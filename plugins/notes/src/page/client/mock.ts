import * as Y from "yjs";
import { createMockNotion } from "./mockNotion";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { DocId, Me, OpName, Ops, PageId, PresenceEntry, SearchHit, VersionInfo, WorkspaceId, WorkspaceInfo } from "../../shared/protocol";
import { pageDocId, treeDocId } from "../../shared/protocol";
import {
  allPages,
  ancestorsOf,
  archivePage,
  blocksOf,
  childrenOf,
  createPage,
  deletePage,
  displayTitle,
  getPage,
  isArchivedDeep,
  metaOf,
  movePage,
  newId,
  orderBetween,
  pageIdFromPath,
  pagesOf,
  plainText,
  restorePage,
  updatePage,
} from "../../shared/model";
import type { NotesClient, OpenDoc, Unsubscribe } from "./types";
import { fromBase64, sha256Hex, toBase64 } from "./encoding";
import { createMockImports, mockAppIcon, mockGettingStarted } from "./mockImports";
import { createMockAgents } from "./mockAgents";
import { initDatabase } from "../../shared/database";
import { writeBlocks } from "../editor/ops";
import { isBlankFragment } from "../../shared/blocks";
import { instantiateTemplate, templateById } from "../../shared/templates";
import { templateUseCount } from "../../shared/templates/counts";

type Key = string;
type StoredVersion = VersionInfo & { state: string };
type StoredFile = { type: string; data: string };
type Snapshot = { workspaces: WorkspaceInfo[]; docs: Record<Key, string>; versions: Record<Key, StoredVersion[]>; files: Record<string, StoredFile> };
type TabPresence = PresenceEntry & { tab: string };

type Wire =
  | { t: "hello"; from: string }
  | { t: "welcome"; from: string; to: string; state: Snapshot }
  | { t: "up"; from: string; key: Key; u: string }
  | { t: "aw"; from: string; key: Key; u: string }
  | { t: "presence"; from: string; entry: TabPresence }
  | { t: "leave"; from: string; tab: string }
  | { t: "workspaces"; from: string; list: WorkspaceInfo[] }
  | { t: "file"; from: string; ref: string; file: StoredFile };

export type BacklinkHit = { page: PageId; title: string; icon: string };

const STORAGE_KEY = "ardia-notes-mock-v1";
const REMOTE = Symbol("remote");
const PEOPLE = [
  { name: "Ada Lovelace", color: "#C07A98" },
  { name: "Grace Hopper", color: "#4691C3" },
  { name: "Alan Kay", color: "#3EB489" },
  { name: "Margaret Hamilton", color: "#D87249" },
];

const keyOf = (workspace: WorkspaceId, doc: DocId) => `${workspace}|${doc}`;

declare global {
  interface Window {
    __notesMockRelay?: (message: string) => void;
    __notesMockDeliver?: (message: string) => void;
    __notesMock?: MockInternals;
  }
}

type SaveState = { state: "saved" | "saving" | "unsaved"; refused: number };
type MockInternals = { docs: Map<Key, Y.Doc>; snapshot: () => Snapshot; flushVersions: () => void; setSaveFailing: (failing: boolean) => void; saveFailing: () => boolean; refuseEdit: () => void; setSaveDelay: (ms: number) => void; joinAsPage: (title: string) => void };

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {}
}

function pickMe(): Me {
  const params = new URLSearchParams(location.search);
  const asName = params.get("as");
  const stored = readSession("ardia-notes-mock-me");
  if (stored && !asName) {
    try {
      return JSON.parse(stored) as Me;
    } catch {}
  }
  const person = asName ? (PEOPLE.find((p) => p.name.toLowerCase().startsWith(asName.toLowerCase())) ?? { name: asName, color: PEOPLE[1]!.color }) : PEOPLE[Math.floor(Math.random() * 2)]!;
  const me = { deviceId: `dev-${newId()}`, name: person.name, color: person.color };
  writeSession("ardia-notes-mock-me", JSON.stringify(me));
  return me;
}

class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

export type MockOptions = { seed?: (client: MockSeedApi) => void | Promise<void> };

export type MockSeedApi = {
  me: Me;
  addWorkspace: (info: Omit<WorkspaceInfo, "state" | "waiting">) => void;
  doc: (workspace: WorkspaceId, doc: DocId) => Y.Doc;
};

export function createMockClient(options: MockOptions = {}): NotesClient & { internals: MockInternals } {
  const tab = newId();
  let me = pickMe();
  let workspaces: WorkspaceInfo[] = [];
  const docs = new Map<Key, Y.Doc>();
  const awarenesses = new Map<Key, Awareness>();
  const refs = new Map<Key, number>();
  const versions = new Map<Key, StoredVersion[]>();
  const versionTimers = new Map<Key, ReturnType<typeof setTimeout>>();
  const files = new Map<string, StoredFile>();
  const fileUrls = new Map<string, string>();
  const presence = new Map<string, TabPresence>();
  const openPages: Key[] = [];
  const meEvents = new Emitter<Me>();
  const saveEvents = new Emitter<SaveState>();
  const startParams = new URLSearchParams(location.search);
  let saveFailing = startParams.has("unsaved");
  let saveDelay = Number(startParams.get("saveDelay") ?? 250);
  let saveDirty = false;
  let saveCurrent: SaveState = { state: "saved", refused: 0 };
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const setSave = (next: SaveState) => {
    if (next.state === saveCurrent.state && next.refused === saveCurrent.refused) return;
    saveCurrent = next;
    saveEvents.emit(saveCurrent);
  };
  const attemptSave = () => {
    persistTimer = null;
    if (!saveDirty) return;
    if (saveFailing) {
      setSave({ ...saveCurrent, state: "unsaved" });
      persistTimer = setTimeout(attemptSave, 2000);
      return;
    }
    saveDirty = false;
    setSave({ ...saveCurrent, state: "saved" });
  };
  const markDirty = () => {
    saveDirty = true;
    if (saveCurrent.state !== "unsaved") setSave({ ...saveCurrent, state: "saving" });
    if (!persistTimer) persistTimer = setTimeout(attemptSave, saveDelay);
  };
  const workspaceEvents = new Emitter<WorkspaceInfo[]>();
  const presenceEvents = new Emitter<PresenceEntry[]>();
  const pathEvents = new Emitter<string>();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("ardia-notes-mock") : null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let welcomed = false;

  const send = (message: Wire) => {
    const text = JSON.stringify(message);
    channel?.postMessage(text);
    window.__notesMockRelay?.(text);
  };

  const snapshot = (): Snapshot => ({
    workspaces,
    docs: Object.fromEntries([...docs].map(([key, doc]) => [key, toBase64(Y.encodeStateAsUpdate(doc))])),
    versions: Object.fromEntries(versions),
    files: Object.fromEntries(files),
  });

  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
      } catch {}
    }, 400);
  };

  const recordVersion = (key: Key) => {
    const doc = docs.get(key);
    if (!doc || !key.includes("|p:")) return;
    const state = Y.encodeStateAsUpdate(doc);
    const list = versions.get(key) ?? [];
    const encoded = toBase64(state);
    if (list.at(-1)?.state === encoded) return;
    list.push({ id: newId(), at: Date.now(), by: me.name, size: state.length, state: encoded });
    if (list.length > 60) list.splice(0, list.length - 60);
    versions.set(key, list);
    scheduleSave();
  };

  const scheduleVersion = (key: Key) => {
    const existing = versionTimers.get(key);
    if (existing) clearTimeout(existing);
    versionTimers.set(
      key,
      setTimeout(() => {
        versionTimers.delete(key);
        recordVersion(key);
      }, 1200),
    );
  };

  const docFor = (key: Key): Y.Doc => {
    let doc = docs.get(key);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(key, doc);
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE) {
          send({ t: "up", from: tab, key, u: toBase64(update) });
          markDirty();
        }
        scheduleSave();
        scheduleVersion(key);
      });
    }
    return doc;
  };

  const awarenessFor = (key: Key): Awareness => {
    let awareness = awarenesses.get(key);
    if (!awareness) {
      awareness = new Awareness(docFor(key));
      awareness.setLocalState(null);
      awarenesses.set(key, awareness);
      const own = awareness;
      own.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === REMOTE) return;
        const changed = [...added, ...updated, ...removed];
        if (changed.length) send({ t: "aw", from: tab, key, u: toBase64(encodeAwarenessUpdate(own, changed)) });
      });
    }
    return awareness;
  };

  const setWorkspaces = (list: WorkspaceInfo[], broadcast = true) => {
    workspaces = list;
    workspaceEvents.emit(workspaces);
    scheduleSave();
    if (broadcast) send({ t: "workspaces", from: tab, list });
  };

  const applySnapshot = (state: Snapshot) => {
    const known = new Map(workspaces.map((w) => [w.id, w]));
    for (const w of state.workspaces) known.set(w.id, { ...known.get(w.id), ...w });
    workspaces = [...known.values()];
    for (const [key, update] of Object.entries(state.docs)) Y.applyUpdate(docFor(key), fromBase64(update), REMOTE);
    for (const [key, list] of Object.entries(state.versions ?? {})) if (!versions.has(key)) versions.set(key, list);
    for (const [ref, file] of Object.entries(state.files ?? {})) files.set(ref, file);
    workspaceEvents.emit(workspaces);
  };

  const presenceList = (): PresenceEntry[] => {
    const now = Date.now();
    for (const [id, entry] of presence) if (now - entry.at > 9000) presence.delete(id);
    return [...presence.values()].map(({ tab: _tab, ...entry }) => entry);
  };

  const ownPresence = (): TabPresence | null => {
    const key = openPages.at(-1);
    const workspace = key ? key.split("|")[0]! : (workspaces[0]?.id ?? "");
    const page = key ? key.split("|p:")[1]! : null;
    return { tab, workspace, deviceId: me.deviceId, name: me.name, color: me.color, page, at: Date.now() };
  };

  const announce = () => {
    const entry = ownPresence();
    if (!entry) return;
    presence.set(tab, entry);
    send({ t: "presence", from: tab, entry });
    presenceEvents.emit(presenceList());
  };

  const receive = (message: Wire) => {
    if (message.from === tab) return;
    switch (message.t) {
      case "hello":
        send({ t: "welcome", from: tab, to: message.from, state: snapshot() });
        for (const [key, awareness] of awarenesses) {
          if (awareness.getLocalState()) send({ t: "aw", from: tab, key, u: toBase64(encodeAwarenessUpdate(awareness, [awareness.clientID])) });
        }
        announce();
        break;
      case "welcome":
        if (message.to !== tab) break;
        welcomed = true;
        applySnapshot(message.state);
        break;
      case "up":
        Y.applyUpdate(docFor(message.key), fromBase64(message.u), REMOTE);
        break;
      case "aw":
        applyAwarenessUpdate(awarenessFor(message.key), fromBase64(message.u), REMOTE);
        break;
      case "presence":
        presence.set(message.entry.tab, { ...message.entry, at: Date.now() });
        presenceEvents.emit(presenceList());
        break;
      case "leave":
        presence.delete(message.tab);
        presenceEvents.emit(presenceList());
        break;
      case "workspaces":
        workspaces = message.list;
        workspaceEvents.emit(workspaces);
        break;
      case "file":
        files.set(message.ref, message.file);
        break;
    }
  };

  if (channel) channel.onmessage = (event: MessageEvent<string>) => receive(JSON.parse(event.data) as Wire);
  window.__notesMockDeliver = (text: string) => receive(JSON.parse(text) as Wire);

  const tree = (workspace: WorkspaceId) => docFor(keyOf(workspace, treeDocId));
  const pageDoc = (workspace: WorkspaceId, page: PageId) => docFor(keyOf(workspace, pageDocId(page)));

  const seedApi: MockSeedApi = {
    get me() {
      return me;
    },
    addWorkspace: (info) => {
      workspaces = [...workspaces, { ...info, state: "ready", waiting: 0 }];
      metaOf(tree(info.id)).set("name", info.name);
      metaOf(tree(info.id)).set("icon", info.icon);
    },
    doc: (workspace, doc) => docFor(keyOf(workspace, doc)),
  };

  const ready = (async () => {
    const params = new URLSearchParams(location.search);
    if (params.has("reset")) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
    }
    let stored: Snapshot | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      stored = raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch {}
    if (stored) applySnapshot(stored);
    send({ t: "hello", from: tab });
    if (!stored) {
      const deadline = Date.now() + 350;
      while (!welcomed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      if (!welcomed && options.seed) {
        await options.seed(seedApi);
        workspaceEvents.emit(workspaces);
        for (const key of docs.keys()) recordVersion(key);
      }
    }
    scheduleSave();
    announce();
    setInterval(announce, 3000);
    window.addEventListener("pagehide", () => {
      send({ t: "leave", from: tab, tab });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
      } catch {}
    });
    window.addEventListener("popstate", () => pathEvents.emit(currentPath()));
  })();

  const currentPath = () => location.pathname + location.search;

  const copyBlocks = (from: Y.Doc, to: Y.Doc, remap: Map<string, string>) => {
    const source = blocksOf(from);
    const target = blocksOf(to);
    const clones = source.toArray().map((node) => (node as Y.XmlElement).clone());
    const fix = (node: Y.XmlElement | Y.XmlText) => {
      if (!(node instanceof Y.XmlElement)) return;
      for (const attr of ["pageId", "page", "database"]) {
        const value = node.getAttribute(attr);
        if (typeof value === "string" && remap.has(value)) node.setAttribute(attr, remap.get(value)!);
      }
      for (const child of node.toArray()) fix(child as Y.XmlElement);
    };
    to.transact(() => {
      target.delete(0, target.length);
      target.insert(0, clones as Y.XmlElement[]);
      for (const clone of clones) fix(clone as Y.XmlElement);
    });
  };

  const copyMeta = (fromTree: Y.Doc, from: PageId, toTree: Y.Doc, to: PageId, patch: Record<string, unknown>) => {
    const source = pagesOf(fromTree).get(from);
    if (!source) return;
    const entry = new Y.Map<unknown>();
    const props = new Y.Map<unknown>();
    const json = source.toJSON() as Record<string, unknown>;
    toTree.transact(() => {
      for (const [k, v] of Object.entries(json)) if (k !== "props") entry.set(k, v);
      for (const [k, v] of Object.entries((json.props as Record<string, unknown>) ?? {})) props.set(k, v);
      entry.set("props", props);
      for (const [k, v] of Object.entries(patch)) entry.set(k, v);
      pagesOf(toTree).set(to, entry);
    });
  };

  const subtree = (workspace: WorkspaceId, root: PageId): PageId[] => {
    const out = [root];
    const all = allPages(tree(workspace));
    for (let i = 0; i < out.length; i++) for (const child of all.filter((p) => p.parent === out[i] && !p.deleted)) out.push(child.id);
    return out;
  };

  const search = (args: Ops["search"]["args"]): SearchHit[] => {
    const terms = args.query.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter(Boolean);
    const hits: SearchHit[] = [];
    for (const w of workspaces) {
      if (args.workspace && args.workspace !== w.id) continue;
      const t = tree(w.id);
      for (const page of allPages(t)) {
        if (isArchivedDeep(t, page.id)) continue;
        const title = displayTitle(page);
        const body = args.titlesOnly ? "" : plainText(blocksOf(pageDoc(w.id, page.id)));
        const lowerTitle = title.toLowerCase();
        const lowerBody = body.toLowerCase();
        let score = 0;
        let snippetAt = -1;
        for (const term of terms) {
          const inTitle = lowerTitle.split(/[^a-z0-9]+/).some((word) => word.startsWith(term)) || lowerTitle.includes(term);
          const bodyIndex = lowerBody.indexOf(term);
          if (!inTitle && bodyIndex < 0) {
            score = 0;
            break;
          }
          score += (inTitle ? 10 : 0) + (bodyIndex >= 0 ? 1 : 0);
          if (bodyIndex >= 0 && snippetAt < 0) snippetAt = bodyIndex;
        }
        if (!terms.length) score = 1;
        if (score <= 0) continue;
        const start = Math.max(0, snippetAt - 40);
        const snippet = snippetAt >= 0 ? (start > 0 ? "…" : "") + body.slice(start, start + 140).replace(/\n/g, " ") : body.slice(0, 140).replace(/\n/g, " ");
        hits.push({ workspace: w.id, page: page.id, title, icon: page.icon, path: ancestorsOf(t, page.id).map((a) => displayTitle(a)), snippet, score: score + page.updatedAt / 1e15, updatedAt: page.updatedAt });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, args.limit ?? 50);
  };

  const backlinks = (workspace: WorkspaceId, page: PageId): BacklinkHit[] => {
    const out: BacklinkHit[] = [];
    const t = tree(workspace);
    for (const other of allPages(t)) {
      if (other.id === page || isArchivedDeep(t, other.id)) continue;
      const doc = docs.get(keyOf(workspace, pageDocId(other.id)));
      if (!doc) continue;
      const xml = blocksOf(doc).toString();
      if (new RegExp(`(pageid|pageId)="${page}"`).test(xml) && /mention|linkToPage/.test(xml)) {
        const linked = [...xml.matchAll(/<(mention|linkToPage)[^>]*>/g)].some((m) => m[0].includes(`"${page}"`));
        if (linked) out.push({ page: other.id, title: displayTitle(other), icon: other.icon });
      }
    }
    return out;
  };

  const mockAgents = createMockAgents({
    createPage: (workspace, input) => {
      const id = createPage(tree(workspace), { ...input, by: me.deviceId });
      if (input.kind === "database") initDatabase(pageDoc(workspace, id), { title: "Board", view: "board" });
      return id;
    },
    writePage: (workspace, page, blocks) => writeBlocks(blocksOf(pageDoc(workspace, page)), blocks),
  });

  const mockNotion = createMockNotion();
  const mockImports = createMockImports({
    finish: (workspace, title) => {
      const t = tree(workspace);
      const root = createPage(t, { parent: "", kind: "page", title, icon: "📥", by: me.deviceId });
      for (const child of ["Meeting notes", "Ideas"]) {
        const id = createPage(t, { parent: root, kind: "page", title: child, by: me.deviceId });
        writeBlocks(blocksOf(pageDoc(workspace, id)), [{ type: "paragraph", content: `Imported ${child.toLowerCase()}.` }]);
      }
      return root;
    },
  });

  const counts: Record<string, number> = {};
  let nextJoin: string | null = null;

  const shareLink = (workspace: WorkspaceId, page: PageId | "" | undefined) => {
    if (!page) return null;
    const meta = getPage(tree(workspace), page);
    return meta && !meta.deleted && meta.sharedIn && workspaces.some((w) => w.id === meta.sharedIn) ? meta : null;
  };
  const shareRootOf = (workspace: WorkspaceId) => workspaces.find((w) => w.id === workspace)?.pageShare?.root ?? null;

  const ops: { [K in OpName]: (args: Ops[K]["args"]) => Promise<Ops[K]["value"]> | Ops[K]["value"] } = {
    createPage: (input) => {
      const link = shareLink(input.workspace, input.parent);
      const args = link ? { ...input, workspace: link.sharedIn } : input;
      if (!args.parent && shareRootOf(args.workspace)) args.parent = shareRootOf(args.workspace)!;
      const t = tree(args.workspace);
      const template = args.template ? getPage(t, args.template) : null;
      const id = createPage(t, {
        parent: args.parent,
        kind: template?.kind ?? args.kind,
        title: args.title ?? template?.title,
        icon: args.icon ?? template?.icon,
        after: args.after,
        props: args.props,
        by: me.deviceId,
      });
      if (template) {
        updatePage(t, id, { cover: template.cover, coverY: template.coverY, font: template.font, fullWidth: template.fullWidth, smallText: template.smallText }, me.deviceId);
        copyBlocks(pageDoc(args.workspace, template.id), pageDoc(args.workspace, id), new Map());
      }
      pageDoc(args.workspace, id);
      return { page: id };
    },
    duplicatePage: ({ workspace, page }) => {
      const t = tree(workspace);
      const ids = subtree(workspace, page);
      const remap = new Map(ids.map((id) => [id, newId()]));
      const root = getPage(t, page);
      if (!root) throw new Error("No such page");
      const siblings = childrenOf(t, root.parent);
      const index = siblings.findIndex((s) => s.id === page);
      const nextOrder = siblings[index + 1]?.order ?? null;
      const order = orderBetween(root.order, nextOrder);
      for (const id of ids) {
        const meta = getPage(t, id)!;
        const patch: Record<string, unknown> = { createdAt: Date.now(), updatedAt: Date.now(), createdBy: me.deviceId, updatedBy: me.deviceId, archivedAt: 0 };
        if (id === page) Object.assign(patch, { title: meta.title ? `${meta.title} (1)` : "", order });
        else patch.parent = remap.get(meta.parent) ?? meta.parent;
        copyMeta(t, id, t, remap.get(id)!, patch);
        copyBlocks(pageDoc(workspace, id), pageDoc(workspace, remap.get(id)!), remap);
      }
      return { page: remap.get(page)! };
    },
    movePage: (input) => {
      let { workspace, page, parent, after, toWorkspace } = input;
      const homeOfRoot = workspaces.find((w) => w.id === workspace)?.pageShare;
      if (homeOfRoot?.root === page && homeOfRoot.home) workspace = homeOfRoot.home;
      const link = shareLink(toWorkspace ?? workspace, parent);
      if (link) {
        toWorkspace = link.sharedIn;
        parent = link.id;
      }
      if (toWorkspace === workspace) toWorkspace = undefined;
      if (!toWorkspace || toWorkspace === workspace) {
        movePage(tree(workspace), page, parent, after, me.deviceId);
        return { page, workspace };
      }
      const from = tree(workspace);
      const to = tree(toWorkspace);
      const ids = subtree(workspace, page);
      for (const id of ids) {
        copyMeta(from, id, to, id, id === page ? { parent, order: "" } : {});
        Y.applyUpdate(pageDoc(toWorkspace, id), Y.encodeStateAsUpdate(pageDoc(workspace, id)));
      }
      movePage(to, page, parent, after, me.deviceId);
      deletePage(from, page, me.deviceId);
      return { page, workspace: toWorkspace };
    },
    archivePage: ({ workspace, page }) => {
      archivePage(tree(workspace), page, me.deviceId);
      return null;
    },
    restorePage: ({ workspace, page }) => {
      restorePage(tree(workspace), page, me.deviceId);
      return null;
    },
    deletePage: ({ workspace, page }) => {
      deletePage(tree(workspace), page, me.deviceId);
      return null;
    },
    search: (args) => search(args),
    resolve: ({ path }) => {
      const id = pageIdFromPath(path);
      if (!id) return null;
      const found = workspaces.find((w) => {
        const meta = getPage(tree(w.id), id);
        return meta && !meta.deleted && !meta.sharedIn;
      });
      return found ? { workspace: found.id, page: id } : null;
    },
    upload: () => {
      throw new Error("Use client.upload in the mock");
    },
    file: ({ ref }) => {
      const file = files.get(ref);
      if (!file) throw new Error("No such file");
      return file;
    },
    history: ({ workspace, page }) => {
      const key = keyOf(workspace, pageDocId(page));
      const pending = versionTimers.get(key);
      if (pending) {
        clearTimeout(pending);
        versionTimers.delete(key);
        recordVersion(key);
      }
      return (versions.get(key) ?? []).map(({ state: _state, ...info }) => info).reverse();
    },
    restoreVersion: ({ workspace, page, version }) => {
      const key = keyOf(workspace, pageDocId(page));
      const found = versions.get(key)?.find((v) => v.id === version);
      if (!found) throw new Error("No such version");
      recordVersion(key);
      const old = new Y.Doc();
      Y.applyUpdate(old, fromBase64(found.state));
      copyBlocks(old, pageDoc(workspace, page), new Map());
      updatePage(tree(workspace), page, {}, me.deviceId);
      return null;
    },
    versionState: ({ workspace, page, version }) => {
      const found = versions.get(keyOf(workspace, pageDocId(page)))?.find((v) => v.id === version);
      if (!found) throw new Error("No such version");
      return { state: found.state };
    },
    createWorkspace: ({ name }) => {
      const info: WorkspaceInfo = { id: newId(), name, icon: "", shared: false, folderId: null, state: "ready", waiting: 0 };
      metaOf(tree(info.id)).set("name", name);
      setWorkspaces([...workspaces, info]);
      return info;
    },
    createSharedWorkspace: ({ name }) => {
      const id = newId();
      const info: WorkspaceInfo = { id, name, icon: "", shared: true, folderId: `folder-${id}`, state: "ready", waiting: 0 };
      metaOf(tree(id)).set("name", name);
      setWorkspaces([...workspaces, info]);
      return info;
    },
    joinSharedWorkspace: () => {
      const id = newId();
      if (nextJoin !== null) {
        const title = nextJoin;
        nextJoin = null;
        const root = newId();
        const info: WorkspaceInfo = { id, name: title, icon: "🧭", shared: true, folderId: `folder-${id}`, state: "ready", waiting: 0, pageShare: { root, home: null, location: "icloud", folder: title } };
        const t = tree(id);
        metaOf(t).set("name", title);
        createPage(t, { id: root, parent: "", kind: "page", title, icon: "🧭", by: "someone-else" });
        createPage(t, { parent: root, kind: "page", title: "Agenda", by: "someone-else" });
        writeBlocks(blocksOf(pageDoc(id, root)), [{ type: "paragraph", content: "Shared with you by Grace." }]);
        setWorkspaces([...workspaces, info]);
        return info;
      }
      const info: WorkspaceInfo = { id, name: "Joined Space", icon: "", shared: true, folderId: `folder-${id}`, state: "ready", waiting: 0 };
      const t = tree(id);
      metaOf(t).set("name", info.name);
      createPage(t, { parent: "", kind: "page", title: "Welcome to the shared space", icon: "👋", by: "someone-else" });
      setWorkspaces([...workspaces, info]);
      return info;
    },
    shareWorkspace: ({ workspace }) => {
      if (workspaces.find((w) => w.id === workspace)?.pageShare) counts.page_share_invites = (counts.page_share_invites ?? 0) + 1;
      return { ok: true };
    },
    sharePage: ({ workspace, page }) => {
      const home = tree(workspace);
      const meta = getPage(home, page);
      if (!meta || meta.deleted) throw new Error("That page isn't here any more.");
      if (meta.sharedIn) throw new Error("This page is already shared.");
      const id = newId();
      const title = displayTitle(meta);
      const info: WorkspaceInfo = { id, name: title, icon: meta.icon, shared: true, folderId: `folder-${id}`, state: "ready", waiting: 0, pageShare: { root: page, home: workspace, location: "icloud", folder: title } };
      const t = tree(id);
      metaOf(t).set("name", title);
      const ids = subtree(workspace, page);
      for (const pid of ids) {
        copyMeta(home, pid, t, pid, pid === page ? { parent: "", order: "a" } : {});
        Y.applyUpdate(pageDoc(id, pid), Y.encodeStateAsUpdate(pageDoc(workspace, pid)));
      }
      home.transact(() => {
        pagesOf(home).get(page)?.set("sharedIn", id);
        for (const pid of ids) if (pid !== page) updatePage(home, pid, { deleted: true }, me.deviceId);
      });
      setWorkspaces([...workspaces, info]);
      counts.page_share_creates = (counts.page_share_creates ?? 0) + 1;
      return { workspace: info, invited: true };
    },
    stopSharingPage: ({ workspace }) => {
      const info = workspaces.find((w) => w.id === workspace);
      const share = info?.pageShare;
      if (!share?.home) throw new Error("The private workspace it came from isn't on this Mac, so leave it instead.");
      const home = tree(share.home);
      const link = getPage(home, share.root);
      if (!link) throw new Error("This shared page isn't linked from your private workspace any more.");
      const from = tree(workspace);
      for (const pid of subtree(workspace, share.root)) {
        copyMeta(from, pid, home, pid, pid === share.root ? { parent: link.parent, order: link.order } : {});
        Y.applyUpdate(pageDoc(share.home, pid), Y.encodeStateAsUpdate(pageDoc(workspace, pid)));
      }
      setWorkspaces(workspaces.filter((w) => w.id !== workspace));
      counts.page_share_stops = (counts.page_share_stops ?? 0) + 1;
      return { workspace: share.home, page: share.root };
    },
    renameWorkspace: ({ workspace, name, icon }) => {
      metaOf(tree(workspace)).set("name", name);
      if (icon !== undefined) metaOf(tree(workspace)).set("icon", icon);
      setWorkspaces(workspaces.map((w) => (w.id === workspace ? { ...w, name, icon: icon ?? w.icon } : w)));
      return null;
    },
    leaveWorkspace: ({ workspace }) => {
      const share = workspaces.find((w) => w.id === workspace)?.pageShare;
      if (share?.home) deletePage(tree(share.home), share.root, me.deviceId);
      setWorkspaces(workspaces.filter((w) => w.id !== workspace));
      return null;
    },
    exportFile: () => null,
    openUrl: ({ url }) => {
      window.open(url, "_blank", "noopener");
      return null;
    },
    setMe: ({ name, color }) => {
      me = { ...me, name: name ?? me.name, color: color ?? me.color };
      writeSession("ardia-notes-mock-me", JSON.stringify(me));
      meEvents.emit(me);
      announce();
      return me;
    },
    importStart: ({ workspace, source, pick }) => mockImports.start(workspace, source, pick ?? "folder"),
    importUpload: ({ uploadId }) => ({ uploadId, parts: 0, size: 0 }),
    importStatus: ({ job }) => mockImports.status(job),
    appIcon: () => mockAppIcon(),
    agentStatus: () => mockAgents.status(),
    openArdiaSettings: ({ pane }) => mockAgents.openSettings(pane),
    agentDemo: ({ workspace }) => mockAgents.start(workspace),
    agentDemoStatus: ({ job }) => mockAgents.demoStatus(job),
    importCancel: ({ job }) => mockImports.cancel(job),
    notionAccount: () => mockNotion.account(),
    notionImport: ({ space }) => mockNotion.start(space),
    notionImportStatus: () => mockNotion.status(),
    notionImportCancel: () => {
      mockNotion.cancel();
      return null;
    },
    applyStarter: ({ workspace, starter }) => {
      const t = tree(workspace);
      const page = createPage(t, { parent: "", kind: "page", title: "Getting Started", icon: "👋", by: me.deviceId });
      writeBlocks(blocksOf(pageDoc(workspace, page)), mockGettingStarted);
      if (starter !== "blank") createPage(t, { parent: "", kind: "page", title: starter, by: me.deviceId });
      return { page };
    },
    useTemplate: ({ workspace, template, parent, into }) => {
      const spec = templateById(template);
      if (!spec) throw new Error("That template isn't here any more.");
      const target = into ? { page: into, doc: pageDoc(workspace, into) } : undefined;
      if (target && !isBlankFragment(blocksOf(target.doc))) throw new Error("That page isn't empty any more, so the template wasn't added.");
      const made = instantiateTemplate({ tree: tree(workspace), by: me.deviceId, newDoc: (id) => pageDoc(workspace, id) }, spec, { parent: parent ?? "", ...(target ? { into: target } : {}), me: { name: me.name, color: me.color } });
      counts[templateUseCount(template)] = (counts[templateUseCount(template)] ?? 0) + 1;
      return { page: made.page };
    },
    countEvent: ({ event }) => {
      counts[event] = (counts[event] ?? 0) + 1;
      return null;
    },
    counts: () => ({ ...counts }),
  };

  const extraOps: Record<string, (args: never) => unknown> = {
    backlinks: ({ workspace, page }: { workspace: WorkspaceId; page: PageId }) => backlinks(workspace, page),
  };

  const client: NotesClient & { internals: MockInternals } = {
    ready,
    me: () => me,
    onMe: (listener) => meEvents.on(listener),
    workspaces: () => workspaces,
    onWorkspaces: (listener) => workspaceEvents.on(listener),
    presence: () => presenceList(),
    onPresence: (listener) => presenceEvents.on(listener),
    open(workspace, doc): OpenDoc {
      const key = keyOf(workspace, doc);
      const ydoc = docFor(key);
      const awareness = awarenessFor(key);
      if (awareness.getLocalState() === null) awareness.setLocalState({});
      refs.set(key, (refs.get(key) ?? 0) + 1);
      if (doc.startsWith("p:")) {
        openPages.push(key);
        announce();
      }
      let released = false;
      return {
        doc: ydoc,
        awareness,
        synced: ready.then(() => new Promise<void>((r) => setTimeout(r, 0))),
        release: () => {
          if (released) return;
          released = true;
          const count = (refs.get(key) ?? 1) - 1;
          refs.set(key, count);
          if (doc.startsWith("p:")) {
            const index = openPages.lastIndexOf(key);
            if (index >= 0) openPages.splice(index, 1);
            announce();
          }
          if (count <= 0) awareness.setLocalState(null);
        },
      };
    },
    async call(op, args) {
      await ready;
      const handler = (ops as Record<string, (a: unknown) => unknown>)[op] ?? (extraOps as Record<string, (a: unknown) => unknown>)[op];
      if (!handler) throw new Error(`Unknown op ${op}`);
      return (await handler(args)) as never;
    },
    async upload(workspace, file, name) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ref = `file:${await sha256Hex(bytes)}`;
      const stored = { type: file.type || "application/octet-stream", data: toBase64(bytes), name };
      files.set(ref, stored);
      send({ t: "file", from: tab, ref, file: stored });
      scheduleSave();
      void workspace;
      return ref;
    },
    async fileUrl(_workspace, ref) {
      const cached = fileUrls.get(ref);
      if (cached) return cached;
      const file = files.get(ref);
      if (!file) throw new Error("No such file");
      const url = URL.createObjectURL(new Blob([fromBase64(file.data) as BlobPart], { type: file.type }));
      fileUrls.set(ref, url);
      return url;
    },
    path: currentPath,
    onPath: (listener) => pathEvents.on(listener),
    navigate(path, navigateOptions) {
      if (navigateOptions?.replace) history.replaceState(null, "", path);
      else history.pushState(null, "", path);
      pathEvents.emit(currentPath());
    },
    setTitle(title) {
      document.title = title;
    },
    viewing() {},
    saveState: () => saveCurrent,
    onSaveState: (listener) => saveEvents.on(listener),
    internals: {
      docs,
      snapshot,
      flushVersions: () => [...versionTimers.keys()].forEach(recordVersion),
      setSaveFailing: (failing) => {
        saveFailing = failing;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = saveDirty ? setTimeout(attemptSave, saveDelay) : null;
      },
      saveFailing: () => saveFailing,
      refuseEdit: () => setSave({ ...saveCurrent, refused: saveCurrent.refused + 1 }),
      setSaveDelay: (ms) => {
        saveDelay = ms;
      },
      joinAsPage: (title) => {
        nextJoin = title;
      },
    },
  };
  window.__notesMock = client.internals;
  return client;
}
