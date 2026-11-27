import { FileWriter } from "./import/fileWriter";
import * as Y from "yjs";
import { bytesEqual, fromBase64, randomHex, toBase64 } from "../shared/bytes";
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
  isShareLink,
  metaOf,
  movePage,
  newId,
  orderBetween,
  pageIdFromPath,
  pagePath,
  pagesOf,
  plainText,
  restorePage,
  updatePage,
  type PageMeta,
} from "../shared/model";
import {
  MAIN_TO_PAGE_MAX,
  Reassembler,
  diskDocName,
  pageOfDoc,
  splitMessage,
  treeDocId,
  wireDocId,
  type Chunk,
  type ExtraOps,
  type MainToPage,
  type Me,
  type OpName,
  type Ops,
  type PresenceEntry,
  type WorkspaceInfo,
} from "../shared/protocol";
import { dateValue, filesValue, multiValue, readSchema, selectValue, textValue, type Property } from "../shared/database";
import { isOp, validArgs } from "./validate";
import { readBlob, sha256Hex, writeBlob } from "./blob";
import { awarenessClients, awarenessRemoval, encodeAwareness } from "./awareness";
import { CursorSync, type CursorClient, type CursorOptions } from "./cursors";
import { docFromState, linkedPages, remapPageRefs, replaceContent, visibleContent } from "./content";
import { ardiaFileStore, errorCode, type FileStore, type FilesApi, type FolderGrant, type FoldersApi } from "./files";
import { History } from "./history";
import { SearchIndex, keyOf } from "./search";
import type { NotesAccess } from "./tools/access";
import { FILE_BYTES_MAX, WorkspaceStore, fullState, defaultTimers, type StoreOptions, type Timers } from "./storage";
import { seedWelcome } from "./welcome";
import { applyStarter } from "./starters";
import { Counts } from "./counts";
import { isBlankFragment } from "../shared/blocks";
import { instantiateTemplate, templateById } from "../shared/templates";
import { templateUseCount } from "../shared/templates/counts";
import { Imports, type PickedFile } from "./import/jobs";
import { ImportError } from "./import/limits";
import { NotionLive, type SitesApi } from "./import/sources/notionLive";
import { AgentDemos } from "./agentDemo";
import { makeHandlers } from "./tools";
import { WORKSPACE_JSON_MAX, fileRefsOfEntry, fileRefsOfState, parseWorkspaceJson } from "./pageShare";

export type Host = {
  files: FilesApi;
  folders: FoldersApi | null;
  storage: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  setting(key: string): unknown;
  post(view: string, message: unknown): Promise<void>;
  openPage(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  timers?: Timers;
  log?: (level: "error" | "warn" | "info", message: string) => void;
  cursors?: Partial<Pick<CursorOptions, "throttleMs" | "keepaliveMs" | "staleMs">>;
  store?: Partial<Pick<StoreOptions, "debounceMs" | "compactAt" | "rescanMs" | "loadConcurrency">>;
  sweepMs?: number;
  uploadLimits?: { bytes?: number; file?: number; open?: number };
  existenceWaitMs?: number;
  durableTimeoutMs?: number;
  viewTimeoutMs?: number;
  presenceMs?: number;
  seedWelcome?: boolean;
  pickFiles?: (options: { multiple?: boolean }) => Promise<PickedFile[]>;
  controlStatus?: () => Promise<{ command: boolean; control: boolean }>;
  appIcon?: (path: string, size: number) => Promise<string | null>;
  appleNotes?: import("./import/sources/appleNotesApp").AppleNotesApi & { request(): Promise<boolean> };
  openArdiaSettings?: (pane: "plugins" | "advanced") => Promise<boolean>;
  sites?: SitesApi;
  timeZone?: string;
  agentDemoPauseMs?: number;
};

export type WorkspaceRecord = { id: string; name: string; icon: string; shared: boolean; folderId: string | null; createdAt: number; root?: string; home?: string | null; location?: string; folder?: string };

type Space = {
  record: WorkspaceRecord;
  store: WorkspaceStore;
  opening: Promise<void>;
  tree: Y.Doc | null;
  treeTimer: unknown;
  textTimers: Map<string, unknown>;
  touched: Map<string, number>;
  closed: boolean;
  grantMissing: boolean;
  cursors: CursorSync | null;
};

type OutItem = { kind: "up" | "aw"; key: string; workspace: string; doc: string; parts: Uint8Array[] } | { kind: "msg"; msg: MainToPage };

class View {
  readonly subs = new Set<string>();
  readonly aw = new Map<string, Map<number, { clock: number; raw: Uint8Array; state: string }>>();
  readonly reasm = new Reassembler();
  outbox: OutItem[] = [];
  sending = false;
  queue: Promise<void> = Promise.resolve();
  lastSeen = 0;
  lastPage: { workspace: string; page: string; at: number } | null = null;
  declaresViewing = false;
  dead = false;
  greeted = false;
  constructor(readonly id: string) {}
}

const COLORS = ["#e03e3e", "#d9730d", "#dfab01", "#0f7b6c", "#0b6e99", "#6940a5", "#ad1a72", "#2f9e44", "#1c7ed6", "#e8590c", "#5f3dc4", "#c2255c"];
const DEFAULT_NAME = "Someone";
const IMPORT_QUIT_MS = 10_000;
const IMPORT_DURABLE_MS = 5 * 60_000;
const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_UPLOADS_BYTES = 128 * 1024 * 1024;
const MAX_UPLOADS_OPEN = 64;
const TOUCH_EVERY = 30_000;

type Seqs = { from: number; to: number; load?: string };

function canonical(update: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return fullState(doc);
  } finally {
    doc.destroy();
  }
}

export function sameContent(a: Uint8Array, b: Uint8Array): boolean {
  try {
    const left = canonical(canonical(a));
    const right = canonical(canonical(b));
    return bytesEqual(left, right);
  } catch {
    return false;
  }
}

export function colorFor(deviceId: string): string {
  let h = 2166136261;
  for (let i = 0; i < deviceId.length; i++) h = Math.imul(h ^ deviceId.charCodeAt(i), 16777619) >>> 0;
  return COLORS[h % COLORS.length]!;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  avif: "image/avif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

function extFor(name: string, type: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  if (m) return m[1]!.toLowerCase();
  for (const [ext, mime] of Object.entries(MIME)) if (mime === type) return ext;
  return "bin";
}

const PAGE_ID = /^[0-9a-f]{12}$/;
const WS_ID = /^[0-9a-f]{12,32}$/;

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
}

function rowText(meta: PageMeta, schema: Property[] | null): string {
  if (!schema) return "";
  const out: string[] = [];
  for (const prop of schema) {
    switch (prop.type) {
      case "title":
        break;
      case "select":
      case "status": {
        const option = selectValue(meta, prop);
        if (option?.name) out.push(option.name);
        break;
      }
      case "multi_select":
        for (const option of multiValue(meta, prop)) if (option.name) out.push(option.name);
        break;
      case "date": {
        const date = dateValue(meta, prop);
        if (date?.start) out.push(date.start);
        break;
      }
      case "files":
        for (const file of filesValue(meta, prop)) if (file.name) out.push(file.name);
        break;
      default: {
        const text = textValue(meta, prop);
        if (text) out.push(text);
      }
    }
  }
  return out.join(" ");
}

export class Notes {
  readonly index = new SearchIndex();
  deviceId = "";
  private readonly timers: Timers;
  private readonly spaces = new Map<string, Space>();
  private records: WorkspaceRecord[] = [];
  private readonly views = new Map<string, View>();
  private blockText = new Map<string, string>();
  private links = new Map<string, Set<string>>();
  private uploads = new Map<string, { parts: string[]; at: number; size: number }>();
  private uploadBytes = 0;
  private readonly gates = new Map<string, Promise<void>>();
  private readonly redirects = new Map<string, string>();
  private readonly pendingDeletes = new Map<string, Promise<unknown>>();
  private recordsSave: Promise<void> = Promise.resolve();
  private openUploads = 0;

  private readonly busy = new Map<string, number>();
  private readonly idle = new Map<string, (() => void)[]>();
  private attached = new WeakSet<Y.Doc>();
  private history!: History;
  private storedMe: { name?: string; color?: string } = {};
  private lastPage: { workspace: string; page: string } | null = null;
  private lastWorkspace: string | null = null;
  private lastPageTimer: unknown = null;
  private workspacesTimer: unknown = null;
  private lastWorkspacesJson = "";
  private presenceTimer: unknown = null;
  private sweepTimer: unknown = null;
  private pruneTimer: unknown = null;
  private stopped = false;
  private chunkSeq = 0;
  private settingName = "";
  started: Promise<void> | null = null;
  private readonly imports: Imports;
  readonly notion: NotionLive;
  private readonly demos: AgentDemos;
  readonly counts: Counts;

  constructor(private readonly host: Host) {
    this.timers = host.timers ?? defaultTimers;
    this.counts = new Counts(host.storage, this.timers);
    this.notion = new NotionLive({
      sites: host.sites ?? null,
      removeFile: (path) => host.files.remove(path),
      listFiles: (dir) => host.files.list(dir, { recursive: true }),
      now: () => this.timers.now(),
      sleep: (ms) => new Promise((resolve) => this.timers.setTimeout(() => resolve(), ms)),
      log: (level, text) => this.log(level, text),
    });
    this.imports = new Imports({
      host: { ...host, notionLive: this.notion },
      now: () => this.timers.now(),
      log: (level, text) => this.log(level, text),
      target: async (workspace) => {
        const space = this.space(workspace);
        const tree = await this.tree(space);
        const files = new FileWriter((bytes, ext) => space.store.stageFile(bytes, ext));
        const touched = new Set<string>(["ws"]);
        return {
          tree,
          by: this.deviceId,
          newDoc: (page: string) => {
            touched.add(`p-${page}`);
            return this.freshDoc(space, page);
          },
          doc: (page: string) => {
            touched.add(`p-${page}`);
            return this.docOf(space, `p-${page}`);
          },
          putFile: (bytes: Uint8Array, ext: string) => files.put(bytes, ext),
          hasFile: (sha: string, size: number) => space.store.hasFile(sha, size),
          flush: async () => {
            await files.drain();
            if (!(await space.store.flushDurable([...touched], this.host.durableTimeoutMs ?? IMPORT_DURABLE_MS))) throw new ImportError("Notes couldn't save the imported pages to disk, so the import stopped. Check there's room on this Mac and start it again.");
          },
          settle: () => files.drain().catch(() => undefined),
          alive: () => !space.closed && this.spaces.get(space.record.id) === space,
        };
      },
      opened: (workspace, page) => {
        this.lastWorkspace = workspace;
        this.rememberPage(workspace, page);
      },
      keepsFolder: (id) => this.records.some((r) => r.folderId === id),
    });
    const demoTools = makeHandlers(() => this.access(), { count: false });
    this.demos = new AgentDemos(
      () => demoTools,
      (ms) => new Promise<void>((resolve) => this.timers.setTimeout(() => resolve(), ms)),
      (workspace, page) => {
        this.lastWorkspace = workspace;
        this.rememberPage(workspace, page);
      },
      host.agentDemoPauseMs,
    );
  }

  start(): Promise<void> {
    this.started ??= this.boot();
    return this.started;
  }

  private log(level: "error" | "warn" | "info", text: string) {
    this.host.log?.(level, text);
  }

  private async boot() {
    const storage = this.host.storage;
    let device = await storage.get<string>("deviceId");
    if (typeof device !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(device)) {
      device = randomHex(8);
      await storage.set("deviceId", device);
    }
    this.deviceId = device;
    this.storedMe = (await storage.get<{ name?: string; color?: string }>("me")) ?? {};
    this.settingName = String(this.host.setting("name") ?? "");
    const saved = await storage.get<WorkspaceRecord[]>("workspaces");
    this.records = Array.isArray(saved) ? saved.filter((r) => r && typeof r.id === "string" && WS_ID.test(r.id)) : [];
    const lastPage = await storage.get<{ workspace: string; page: string }>("lastPage");
    if (lastPage && typeof lastPage.workspace === "string" && typeof lastPage.page === "string") this.lastPage = lastPage;
    const lastWorkspace = await storage.get<string>("lastWorkspace");
    if (typeof lastWorkspace === "string") this.lastWorkspace = lastWorkspace;
    this.history = new History(ardiaFileStore(this.host.files, "data", "history"), this.deviceId, this.timers);
    if (this.records.length === 0) await this.createDefault();
    for (const record of this.records) if (!this.spaces.has(record.id)) this.openSpace(record);
    void this.imports.recover();
    this.sweep();
    this.pruneTimer = this.timers.setTimeout(() => void this.history.prune().catch(() => 0), 60_000);
  }

  async stop(options: { flush?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of [this.lastPageTimer, this.workspacesTimer, this.presenceTimer, this.sweepTimer, this.pruneTimer]) if (t !== null) this.timers.clearTimeout(t);
    let importDeadline: unknown = null;
    await Promise.race([this.imports.stop(), new Promise<void>((resolve) => (importDeadline = this.timers.setTimeout(() => resolve(), IMPORT_QUIT_MS)))]);
    this.timers.clearTimeout(importDeadline);
    await Promise.all(
      [...this.spaces.values()].map(async (space) => {
        for (const t of space.textTimers.values()) this.timers.clearTimeout(t);
        if (space.treeTimer !== null) this.timers.clearTimeout(space.treeTimer);
        space.closed = true;
        await space.cursors?.close().catch(() => undefined);
        await space.store.close(options).catch(() => undefined);
      }),
    );
    await this.history?.flushed();
    await this.counts.flush();
  }

  me(): Me {
    const name = (this.storedMe.name || this.settingName || DEFAULT_NAME).trim().slice(0, 80) || DEFAULT_NAME;
    return { deviceId: this.deviceId, name, color: this.storedMe.color || colorFor(this.deviceId) };
  }

  onSettings(values: Readonly<Record<string, unknown>>) {
    const next = typeof values.name === "string" ? values.name : "";
    if (next === this.settingName) return;
    this.settingName = next;
    if (next && this.storedMe.name) {
      this.storedMe = { ...this.storedMe, name: undefined };
      void this.host.storage.set("me", this.storedMe);
    }
    this.broadcast({ t: "me", me: this.me() });
    this.updatePresence();
  }

  workspaces(): WorkspaceInfo[] {
    return this.records.map((r) => this.info(r));
  }

  private info(record: WorkspaceRecord): WorkspaceInfo {
    const space = this.spaces.get(record.id);
    const meta = space?.tree ? metaOf(space.tree) : null;
    const name = typeof meta?.get("name") === "string" && meta.get("name") ? String(meta.get("name")) : record.name;
    const icon = typeof meta?.get("icon") === "string" ? String(meta.get("icon")) : record.icon;
    let state: WorkspaceInfo["state"] = space ? space.store.state : "loading";
    if (space?.grantMissing) state = "missing";
    if (space && !space.tree && state === "ready") state = "loading";
    const pageShare = record.root ? { pageShare: { root: record.root, home: record.home && this.records.some((r) => r.id === record.home) ? record.home : null, location: record.location ?? "icloud", folder: record.folder ?? record.name } } : {};
    return { id: record.id, name, icon, shared: record.shared, folderId: record.folderId, state, waiting: space?.store.waiting ?? 0, ...pageShare };
  }

  private cursorsFor(space: Space, fs: FileStore): CursorSync {
    const ws = space.record.id;
    return new CursorSync({
      fs,
      deviceId: this.deviceId,
      timers: this.timers,
      ...this.host.cursors,
      collect: () => {
        const docs = new Map<string, CursorClient[]>();
        for (const view of this.views.values()) {
          if (view.dead) continue;
          for (const [key, states] of view.aw) {
            const [workspace = "", doc = ""] = key.split("\u0000");
            if (workspace !== ws || !view.subs.has(key) || states.size === 0) continue;
            const list = docs.get(doc) ?? [];
            for (const [id, s] of states) list.push({ id, clock: s.clock, state: s.state });
            docs.set(doc, list);
          }
        }
        return docs;
      },
      deliver: (doc, update) => {
        const key = `${ws}\u0000${doc}`;
        for (const view of this.views.values()) if (view.subs.has(key)) this.enqueueBinary(view, "aw", key, ws, doc, update);
      },
      onError: (error) => this.log("warn", `${ws} cursors: ${message(error)}`),
    });
  }

  private fileStoreFor(record: WorkspaceRecord): FileStore {
    return record.shared && record.folderId ? ardiaFileStore(this.host.files, record.folderId, "") : ardiaFileStore(this.host.files, "data", `workspaces/${record.id}`);
  }

  private openSpace(record: WorkspaceRecord, fs = this.fileStoreFor(record)): Space {
    const space: Space = {
      record,
      store: null as unknown as WorkspaceStore,
      opening: Promise.resolve(),
      tree: null,
      treeTimer: null,
      textTimers: new Map(),
      touched: new Map(),
      closed: false,
      grantMissing: false,
      cursors: null,
    };
    space.store = new WorkspaceStore({
      fs,
      deviceId: this.deviceId,
      timers: this.timers,
      ...this.host.store,
      onDocAdded: (name) => {
        if (space.tree && name.startsWith("p-")) {
          const page = getPage(space.tree, name.slice(2));
          if (page?.deleted) return;
        }
        if (space.tree) void this.docOf(space, name).catch(() => undefined);
      },
      onDocLoaded: (name, doc) => this.attach(space, name, doc),
      onState: () => this.workspacesChanged(),
      onPresence: () => this.presenceChanged(),
      onCursorFile: (device, mtimeMs) => space.cursors?.remoteChanged(device, mtimeMs),
      onError: (error, where) => this.log("warn", `${record.id} ${where}: ${message(error)}`),
    });
    if (record.shared) space.cursors = this.cursorsFor(space, fs);
    this.spaces.set(record.id, space);
    space.opening = (async () => {
      if (record.shared && record.folderId && this.host.folders) {
        try {
          const grants = await this.host.folders.list();
          const grant = grants.find((g) => g.id === record.folderId);
          space.grantMissing = !grant || !grant.available;
        } catch {
          space.grantMissing = false;
        }
      }
      await space.store.open();
      if (space.closed) return;
      const tree = await space.store.get("ws");
      space.tree = tree;
      this.reindexTree(space);
      this.workspacesChanged();
      void space.store.loadAll((name) => {
        if (!name.startsWith("p-")) return false;
        const page = getPage(tree, name.slice(2));
        return !page || page.deleted;
      });
    })().catch((error) => {
      this.log("error", `Opening ${record.id} failed: ${message(error)}`);
      this.workspacesChanged();
    });
    return space;
  }

  private attach(space: Space, name: string, doc: Y.Doc) {
    if (this.attached.has(doc)) return;
    this.attached.add(doc);
    const docId = wireDocId(name);
    const key = `${space.record.id}\u0000${docId}`;
    const page = pageOfDoc(docId);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (space.closed) return;
      for (const view of this.views.values()) if (view !== origin && view.subs.has(key)) this.enqueueBinary(view, "up", key, space.record.id, docId, update);
      if (name === "ws") this.scheduleTree(space);
      else if (page) {
        this.scheduleText(space, page, doc);
        if (origin instanceof View || origin === "restore") this.touch(space, page);
      }
    });
    if (page) this.scheduleText(space, page, doc, 0);
    if (name === "ws") this.scheduleTree(space);
  }

  private async docOf(space: Space, name: string): Promise<Y.Doc> {
    const doc = await space.store.get(name);
    this.attach(space, name, doc);
    return doc;
  }

  private freshDoc(space: Space, page: string): Y.Doc {
    const name = `p-${page}`;
    const doc = space.store.create(name);
    this.attach(space, name, doc);
    return doc;
  }

  private touch(space: Space, page: string) {
    const now = this.timers.now();
    if (now - (space.touched.get(page) ?? 0) < TOUCH_EVERY) return;
    space.touched.set(page, now);
    if (space.tree && getPage(space.tree, page)) updatePage(space.tree, page, {}, this.deviceId, now);
  }

  private scheduleTree(space: Space) {
    if (space.treeTimer !== null || this.stopped) return;
    space.treeTimer = this.timers.setTimeout(() => {
      space.treeTimer = null;
      this.reindexTree(space);
      this.workspacesChanged();
    }, 150);
  }

  private scheduleText(space: Space, page: string, doc: Y.Doc, ms = 400) {
    if (space.textTimers.has(page) || this.stopped) return;
    space.textTimers.set(
      page,
      this.timers.setTimeout(() => {
        space.textTimers.delete(page);
        if (space.closed) return;
        this.indexText(space, page, doc);
      }, ms),
    );
  }

  private indexText(space: Space, page: string, doc: Y.Doc) {
    const key = keyOf(space.record.id, page);
    let text = "";
    try {
      const blocks = blocksOf(doc);
      text = plainText(blocks);
      this.links.set(key, linkedPages(blocks));
    } catch (error) {
      this.log("warn", `Indexing ${page} failed: ${message(error)}`);
    }
    this.blockText.set(key, text);
    const meta = space.tree ? getPage(space.tree, page) : null;
    if (meta && !meta.deleted) this.index.setText(space.record.id, page, this.fullText(space, text, meta));
    if (meta?.kind === "database") this.scheduleTree(space);
  }

  private schemaOf(space: Space, database: string, cache?: Map<string, Property[] | null>): Property[] | null {
    if (cache?.has(database)) return cache.get(database)!;
    const doc = space.store.peek(`p-${database}`);
    let schema: Property[] | null = null;
    if (doc) {
      try {
        schema = readSchema(doc);
      } catch {
        schema = null;
      }
    }
    cache?.set(database, schema);
    return schema;
  }

  private fullText(space: Space, blocks: string, meta: PageMeta, cache?: Map<string, Property[] | null>): string {
    const parent = meta.parent && space.tree ? getPage(space.tree, meta.parent) : null;
    const props = parent?.kind === "database" ? rowText(meta, this.schemaOf(space, parent.id, cache)) : "";
    return props ? (blocks ? `${blocks}\n${props}` : props) : blocks;
  }

  private reindexTree(space: Space) {
    const tree = space.tree;
    if (!tree) return;
    const ws = space.record.id;
    const pages = allPages(tree);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const pathOf = (page: PageMeta) => {
      const out: string[] = [];
      const guard = new Set<string>([page.id]);
      let parent = page.parent ? byId.get(page.parent) : undefined;
      let live = !page.deleted && page.archivedAt === 0;
      while (parent && !guard.has(parent.id)) {
        guard.add(parent.id);
        out.unshift(displayTitle(parent));
        if (parent.deleted || parent.archivedAt) live = false;
        parent = parent.parent ? byId.get(parent.parent) : undefined;
      }
      return { path: out, live };
    };
    const schemas = new Map<string, Property[] | null>();
    for (const page of pages) {
      if (page.deleted || isShareLink(page)) {
        this.index.remove(ws, page.id);
        continue;
      }
      seen.add(page.id);
      const { path, live } = pathOf(page);
      const blocks = this.blockText.get(keyOf(ws, page.id)) ?? "";
      this.index.upsert(
        { workspace: ws, page: page.id, title: displayTitle(page), icon: page.icon, kind: page.kind, path, updatedAt: page.updatedAt, live: live && !page.isTemplate },
        this.fullText(space, blocks, page, schemas),
      );
    }
    for (const page of this.index.pagesOf(ws)) if (!seen.has(page)) this.index.remove(ws, page);
  }

  private async createDefault(): Promise<WorkspaceRecord> {
    const record: WorkspaceRecord = { id: newId(), name: "My Notes", icon: "", shared: false, folderId: null, createdAt: this.timers.now() };
    const fs = this.fileStoreFor(record);
    await fs
      .writeText("workspace.json", JSON.stringify({ format: "ardia-notes", version: 1, id: record.id, name: record.name }), { exclusive: true })
      .catch((error) => this.log("warn", `workspace.json: ${message(error)}`));
    this.records.push(record);
    await this.saveRecords();
    const space = this.openSpace(record, fs);
    await space.opening;
    if (space.tree && this.host.seedWelcome !== false) {
      const { first } = seedWelcome(space.tree, this.deviceId, (page) => this.freshDoc(space, page), this.timers.now());
      this.lastPage = { workspace: record.id, page: first };
      this.lastWorkspace = record.id;
      void this.host.storage.set("lastPage", this.lastPage);
      void this.host.storage.set("lastWorkspace", record.id);
      await space.store.flush();
    }
    return record;
  }

  private saveRecords(): Promise<void> {
    const run = this.recordsSave.then(
      () => this.host.storage.set("workspaces", this.records.map((r) => ({ ...r }))),
      () => this.host.storage.set("workspaces", this.records.map((r) => ({ ...r }))),
    );
    this.recordsSave = run.catch(() => undefined);
    return run;
  }

  private workspacesChanged() {
    if (this.workspacesTimer !== null || this.stopped) return;
    this.workspacesTimer = this.timers.setTimeout(() => {
      this.workspacesTimer = null;
      const list = this.workspaces();
      const json = JSON.stringify(list);
      if (json === this.lastWorkspacesJson) return;
      this.lastWorkspacesJson = json;
      this.broadcast({ t: "workspaces", list });
    }, 60);
  }

  presence(): PresenceEntry[] {
    const out: PresenceEntry[] = [];
    for (const space of this.spaces.values()) {
      if (!space.record.shared) continue;
      for (const p of space.store.presence()) out.push({ workspace: space.record.id, deviceId: p.device, name: p.name, color: p.color, page: p.page, at: p.at });
    }
    return out;
  }

  private presenceChanged() {
    if (this.presenceTimer !== null || this.stopped) return;
    this.presenceTimer = this.timers.setTimeout(() => {
      this.presenceTimer = null;
      this.broadcast({ t: "presence", list: this.presence() });
    }, 100);
  }

  private updatePresence() {
    const me = this.me();
    for (const space of this.spaces.values()) {
      if (!space.record.shared) continue;
      let best: { page: string; at: number } | null = null;
      for (const view of this.views.values()) {
        const lp = view.lastPage;
        if (!view.dead && lp && lp.workspace === space.record.id && view.subs.has(`${lp.workspace}\u0000p:${lp.page}`) && (!best || lp.at > best.at)) best = lp;
      }
      space.store.setPresence(best ? { name: me.name, color: me.color, page: best.page } : null);
    }
  }

  private broadcast(msg: MainToPage) {
    for (const view of this.views.values()) if (view.greeted && !view.dead) this.enqueue(view, msg);
  }

  private enqueue(view: View, msg: MainToPage) {
    if (view.dead) return;
    view.outbox.push({ kind: "msg", msg });
    void this.pump(view);
  }

  private enqueueBinary(view: View, kind: "up" | "aw", key: string, workspace: string, doc: string, bytes: Uint8Array) {
    if (view.dead) return;
    const last = view.outbox[view.outbox.length - 1];
    if (kind === "up" && last && last.kind === "up" && last.key === key) last.parts.push(bytes);
    else view.outbox.push({ kind, key, workspace, doc, parts: [bytes] });
    void this.pump(view);
  }

  private async pump(view: View) {
    if (view.sending) return;
    view.sending = true;
    try {
      while (view.outbox.length && !view.dead && !this.stopped) {
        const item = view.outbox.shift()!;
        let msg: MainToPage;
        if (item.kind === "msg") msg = item.msg;
        else {
          const bytes = item.kind === "up" && item.parts.length > 1 ? Y.mergeUpdates(item.parts) : item.parts[0]!;
          msg = { t: item.kind, doc: item.doc, workspace: item.workspace, u: toBase64(bytes) };
        }
        const pieces = splitMessage(msg, MAIN_TO_PAGE_MAX, `m${++this.chunkSeq}`);
        for (const piece of pieces) {
          if (!(await this.postWithRetry(view, piece))) {
            this.dropView(view);
            return;
          }
        }
      }
    } finally {
      view.sending = false;
    }
  }

  private async postWithRetry(view: View, piece: MainToPage | Chunk): Promise<boolean> {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (view.dead || this.stopped) return false;
      try {
        await this.host.post(view.id, piece);
        return true;
      } catch (error) {
        if (errorCode(error) !== "overloaded") {
          this.log("warn", `page.post to ${view.id}: ${message(error)}`);
          return false;
        }
        await new Promise<void>((resolve) => this.timers.setTimeout(resolve, Math.min(1000, 40 * 2 ** Math.min(attempt, 5))));
      }
    }
    return false;
  }

  private sweep() {
    if (this.stopped) return;
    const timeout = this.host.viewTimeoutMs ?? 50_000;
    const now = this.timers.now();
    for (const view of [...this.views.values()]) if (now - view.lastSeen > timeout) this.dropView(view);
    for (const [id, up] of [...this.uploads]) if (now - up.at > 10 * 60_000) this.dropUpload(id);
    this.sweepTimer = this.timers.setTimeout(() => this.sweep(), this.host.sweepMs ?? 15_000);
  }

  private dropView(view: View) {
    if (view.dead) return;
    view.dead = true;
    view.outbox = [];
    this.views.delete(view.id);
    for (const key of [...view.subs]) this.leave(view, key);
    this.updatePresence();
  }

  viewCount(): number {
    return this.views.size;
  }

  onPageMessage(raw: unknown, viewId: string) {
    if (this.stopped || typeof raw !== "object" || raw === null || typeof viewId !== "string" || !viewId) return;
    const msg = raw as Record<string, unknown>;
    if (typeof msg.t !== "string") return;
    let view = this.views.get(viewId);
    if (!view) {
      if (msg.t === "bye") return;
      view = new View(viewId);
      this.views.set(viewId, view);
    }
    view.lastSeen = this.timers.now();
    const v = view;
    if (msg.t === "req") {
      v.queue = v.queue
        .then(() => (msg.op === "uploadPart" ? this.handle(v, msg) : void this.request(v, msg)))
        .catch((error) => this.log("warn", `request: ${message(error)}`));
      return;
    }
    v.queue = v.queue.then(() => this.handle(v, msg)).catch((error) => this.log("warn", `page message ${String(msg.t)}: ${message(error)}`));
  }

  whenViewsIdle(): Promise<void> {
    return Promise.all([...this.views.values()].map((v) => v.queue)).then(() => undefined);
  }

  private async handle(view: View, msg: Record<string, unknown>): Promise<void> {
    await this.start();
    if (view.dead) return;
    switch (msg.t) {
      case "chunk": {
        const whole = view.reasm.push(msg as unknown as Chunk, this.timers.now());
        if (whole && typeof whole === "object" && (whole as { t?: unknown }).t !== "chunk") {
          const inner = whole as Record<string, unknown>;
          if (inner.t === "req" && inner.op !== "uploadPart") void this.request(view, inner);
          else await this.handle(view, inner);
        }
        return;
      }
      case "hello": {
        for (const key of [...view.subs]) this.leave(view, key);
        view.greeted = true;
        this.enqueue(view, { t: "ready", me: this.me(), workspaces: this.workspaces() });
        const presence = this.presence();
        if (presence.length) this.enqueue(view, { t: "presence", list: presence });
        return;
      }
      case "alive":
        return;
      case "bye":
        this.dropView(view);
        return;
      case "sub":
        return this.subscribe(view, String(msg.workspace ?? ""), String(msg.doc ?? ""));
      case "unsub": {
        const key = `${String(msg.workspace ?? "")}\u0000${String(msg.doc ?? "")}`;
        if (view.subs.has(key)) this.leave(view, key);
        this.updatePresence();
        return;
      }
      case "viewing":
        return this.viewing(view, String(msg.workspace ?? ""), String(msg.page ?? ""));
      case "up": {
        const workspace = String(msg.workspace ?? "");
        const doc = String(msg.doc ?? "");
        const to = typeof msg.seq === "number" && Number.isSafeInteger(msg.seq) ? msg.seq : null;
        const from = typeof msg.from === "number" && Number.isSafeInteger(msg.from) && to !== null && msg.from <= to ? msg.from : to;
        const load = typeof msg.load === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(msg.load) ? msg.load : undefined;
        await this.applyUp(view, workspace, doc, String(msg.u ?? ""), to === null || from === null ? null : { from, to, load });
        return;
      }
      case "aw":
        return this.relayAwareness(view, String(msg.workspace ?? ""), String(msg.doc ?? ""), String(msg.u ?? ""));
      case "req": {
        if (msg.op === "uploadPart") {
          try {
            this.uploadPart(msg.args, view.id);
            this.enqueue(view, { t: "res", id: String(msg.id ?? ""), ok: true, value: null });
          } catch (error) {
            this.enqueue(view, { t: "res", id: String(msg.id ?? ""), ok: false, error: message(error) });
          }
        }
        return;
      }
    }
  }

  private validDoc(doc: string): boolean {
    return doc === treeDocId || (doc.startsWith("p:") && PAGE_ID.test(doc.slice(2)));
  }

  private async subscribe(view: View, workspace: string, doc: string) {
    await this.settled(workspace);
    const space = this.spaces.get(workspace);
    const key = `${workspace}\u0000${doc}`;
    if (!space || !this.validDoc(doc)) {
      this.enqueue(view, { t: "doc", doc, workspace, state: toBase64(Y.encodeStateAsUpdate(new Y.Doc())) });
      return;
    }
    await space.opening;
    const ydoc = await this.docOf(space, diskDocName(doc));
    if (view.dead) return;
    view.subs.add(key);
    this.enqueue(view, { t: "doc", doc, workspace, state: toBase64(Y.encodeStateAsUpdate(ydoc)) });
    for (const other of this.views.values()) {
      if (other === view) continue;
      const states = other.aw.get(key);
      if (states) for (const s of states.values()) this.enqueueBinary(view, "aw", key, workspace, doc, s.raw);
    }
    const remote = space.cursors?.cached(doc);
    if (remote) this.enqueueBinary(view, "aw", key, workspace, doc, remote);
    const page = pageOfDoc(doc);
    if (page && !view.declaresViewing) {
      view.lastPage = { workspace, page, at: this.timers.now() };
      this.rememberPage(workspace, page);
    }
    if (page) this.updatePresence();
  }

  private viewing(view: View, workspace: string, page: string) {
    view.declaresViewing = true;
    if (this.spaces.has(workspace) && PAGE_ID.test(page)) {
      view.lastPage = { workspace, page, at: this.timers.now() };
      this.rememberPage(workspace, page);
    } else view.lastPage = null;
    this.updatePresence();
  }

  private rememberPage(workspace: string, page: string) {
    this.lastPage = { workspace, page };
    this.lastWorkspace = workspace;
    if (this.lastPageTimer !== null) return;
    this.lastPageTimer = this.timers.setTimeout(() => {
      this.lastPageTimer = null;
      void this.host.storage.set("lastPage", this.lastPage).catch(() => undefined);
      void this.host.storage.set("lastWorkspace", this.lastWorkspace).catch(() => undefined);
    }, 1000);
  }

  private leave(view: View, key: string) {
    view.subs.delete(key);
    const states = view.aw.get(key);
    view.aw.delete(key);
    const [workspace = "", doc = ""] = key.split("\u0000");
    if (states && states.size) {
      const removal = awarenessRemoval([...states.entries()].map(([id, s]) => ({ id, clock: s.clock })));
      for (const other of this.views.values()) if (other !== view && other.subs.has(key)) this.enqueueBinary(other, "aw", key, workspace, doc, removal);
    }
    const space = this.spaces.get(workspace);
    if (states?.size) space?.cursors?.localChanged();
    if (space) void space.store.flush(diskDocName(doc)).catch(() => undefined);
  }

  private async applyUp(view: View, workspace: string, doc: string, u: string, seq: Seqs | null = null): Promise<void> {
    await this.settled(workspace);
    await this.tracked([workspace], () => this.applyUpNow(view, workspace, doc, u, seq));
  }

  private ackFor(workspace: string, doc: string, seq: Seqs, outcome?: "refused"): MainToPage {
    return { t: "ack", doc, workspace, seq: seq.to, ...(seq.from !== seq.to ? { from: seq.from } : {}), ...(seq.load ? { load: seq.load } : {}), ...(outcome ? { outcome } : {}) };
  }

  private refuse(view: View, workspace: string, doc: string, seq: Seqs | null) {
    if (seq !== null) this.enqueue(view, this.ackFor(workspace, doc, seq, "refused"));
  }

  private async pageReady(space: Space, page: string): Promise<void> {
    const pending = this.pendingDeletes.get(`${space.record.id}\u0000${page}`);
    if (pending) await pending;
    const tree = space.tree;
    if (!tree || getPage(tree, page)) return;
    const wait = this.host.existenceWaitMs ?? 10_000;
    await new Promise<void>((resolve) => {
      let timer: unknown = null;
      const done = () => {
        tree.off("update", check);
        if (timer !== null) this.timers.clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (getPage(tree, page)) done();
      };
      tree.on("update", check);
      timer = this.timers.setTimeout(done, wait);
    });
  }

  private target(space: Space, page: string | null): { space: Space; page: string | null } | null {
    if (space.closed || this.spaces.get(space.record.id) !== space) return null;
    if (!page) return { space, page };
    const tree = space.tree;
    const meta = tree ? getPage(tree, page) : null;
    if (!tree || !meta) return null;
    if (isShareLink(meta)) {
      const share = this.spaces.get(meta.sharedIn);
      if (!share?.tree || share.record.root !== page) return null;
      const shared = getPage(share.tree, page);
      return shared && !shared.deleted ? { space: share, page } : null;
    }
    if (!meta.deleted) return { space, page };
    const movedTo = pagesOf(tree).get(page)?.get("movedTo");
    if (typeof movedTo !== "string" || movedTo === space.record.id) return null;
    const next = this.spaces.get(movedTo);
    if (!next?.tree) return null;
    const moved = getPage(next.tree, page);
    return moved && !moved.deleted ? { space: next, page } : null;
  }

  private isGone(space: Space, page: string | null): boolean {
    if (space.closed || this.spaces.get(space.record.id) !== space) return true;
    return !!page && !!space.tree && getPage(space.tree, page)?.deleted === true;
  }

  private async applyUpNow(view: View, workspace: string, doc: string, u: string, seq: Seqs | null): Promise<void> {
    const moved = this.redirects.get(workspace);
    const origin = this.spaces.get(workspace) ?? (moved && doc !== treeDocId ? this.spaces.get(moved) : undefined);
    if (!this.validDoc(doc) || !u) return;
    if (!origin) return this.refuse(view, workspace, doc, seq);
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(u);
      Y.parseUpdateMeta(bytes);
    } catch {
      return this.refuse(view, workspace, doc, seq);
    }
    await origin.opening;
    const page = pageOfDoc(doc);
    if (page) await this.pageReady(origin, page);
    const name = diskDocName(doc);
    let where = this.target(origin, page);
    if (!where) return this.refuse(view, workspace, doc, seq);
    if (where.space !== origin) await where.space.opening;
    const ydoc = await this.docOf(where.space, name);
    if (page) await this.history.beforeEdit(where.space.record.id, page, ydoc).catch(() => undefined);
    where = this.target(origin, page);
    if (!where) return this.refuse(view, workspace, doc, seq);
    const space = where.space;
    const deletedBefore = name === "ws" && space.tree ? allPages(space.tree).filter((p) => p.deleted).map((p) => p.id) : [];
    let durable: Promise<boolean>;
    try {
      durable = space.store.applyFromPage(name, bytes, view);
    } catch (error) {
      this.log("warn", `An update for ${doc} didn't apply: ${message(error)}`);
      return this.refuse(view, workspace, doc, seq);
    }
    if (deletedBefore.length && space.tree) this.keepTombstones(space.tree, deletedBefore);
    if (seq === null) return;
    void durable.then((ok) => {
      if (ok && !view.dead) this.enqueue(view, this.ackFor(workspace, doc, seq));
    });
  }

  private keepTombstones(tree: Y.Doc, ids: string[]) {
    for (const id of ids) {
      const meta = getPage(tree, id);
      if (!meta || (meta.deleted && !meta.title && !meta.icon && !meta.cover)) continue;
      updatePage(tree, id, { deleted: true, title: "", icon: "", cover: "" }, this.deviceId, this.timers.now());
    }
  }

  private relayAwareness(view: View, workspace: string, doc: string, u: string) {
    if (!this.validDoc(doc) || !u) return;
    let bytes: Uint8Array;
    let clients;
    try {
      bytes = fromBase64(u);
      clients = awarenessClients(bytes);
    } catch {
      return;
    }
    const key = `${workspace}\u0000${doc}`;
    let states = view.aw.get(key);
    if (!states) view.aw.set(key, (states = new Map()));
    for (const c of clients) {
      if (c.removed) states.delete(c.id);
      else states.set(c.id, { clock: c.clock, raw: clients.length === 1 ? bytes : encodeAwareness([c]), state: c.state });
    }
    for (const other of this.views.values()) if (other !== view && other.subs.has(key)) this.enqueueBinary(other, "aw", key, workspace, doc, bytes);
    this.spaces.get(workspace)?.cursors?.localChanged();
  }

  private uploadPart(raw: unknown, viewId: string) {
    const args = validArgs("uploadPart", raw) as ExtraOps["uploadPart"]["args"];
    const key = `${viewId}\u0000${args.uploadId}`;
    let up = this.uploads.get(key);
    const limits = { bytes: MAX_UPLOADS_BYTES, file: MAX_UPLOAD, open: MAX_UPLOADS_OPEN, ...this.host.uploadLimits };
    if (!up) {
      if (this.openUploads >= limits.open) throw new Error("There's too much being uploaded at once; wait for the others to finish.");
      this.uploads.set(key, (up = { parts: [], at: this.timers.now(), size: 0 }));
      this.openUploads++;
    }
    const grows = args.data.length - (up.parts[args.i]?.length ?? 0);
    if (this.uploadBytes + grows > limits.bytes) throw new Error("There's too much being uploaded at once; wait for the others to finish.");
    if (((up.size + grows) * 3) / 4 > limits.file) {
      this.dropUpload(key);
      throw new Error("That file is bigger than 64 MB.");
    }
    up.at = this.timers.now();
    up.parts[args.i] = args.data;
    up.size += grows;
    this.uploadBytes += grows;
  }

  private async finishUpload(space: Space, up: { parts: string[] }, name: string, type: string): Promise<{ ref: string }> {
    for (let i = 0; i < up.parts.length; i++) if (up.parts[i] === undefined) throw new Error("Part of that upload didn't arrive.");
    const parts = up.parts.map((p) => fromBase64(p));
    let total = 0;
    for (const p of parts) total += p.length;
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    await space.opening;
    const sha = await space.store.putFile(bytes, extFor(name, type));
    return { ref: `file:${sha}` };
  }

  private dropUpload(key: string) {
    const up = this.uploads.get(key);
    if (!up) return null;
    this.uploads.delete(key);
    this.openUploads--;
    this.uploadBytes -= up.size;
    return up;
  }

  private async request(view: View, msg: Record<string, unknown>) {
    const id = String(msg.id ?? "");
    const op = String(msg.op ?? "");
    try {
      await this.start();
      const value = await this.run(op, msg.args, { view: view.id });
      this.enqueue(view, { t: "res", id, ok: true, value: value === undefined ? null : value });
    } catch (error) {
      this.enqueue(view, { t: "res", id, ok: false, error: message(error) });
    }
  }

  private space(id: unknown): Space {
    const space = typeof id === "string" ? this.spaces.get(id) : undefined;
    if (!space) throw new Error("That workspace isn't here any more.");
    return space;
  }

  private async tree(space: Space): Promise<Y.Doc> {
    await space.opening;
    if (!space.tree) throw new Error("That workspace couldn't be opened.");
    return space.tree;
  }

  private page(tree: Y.Doc, id: unknown): PageMeta {
    const page = typeof id === "string" ? getPage(tree, id) : null;
    if (!page || page.deleted) throw new Error("That page isn't here any more.");
    return page;
  }

  async run(op: string, raw: unknown, context: { view: string } = { view: "" }): Promise<unknown> {
    if (!isOp(op) || !Object.hasOwn(this.ops, op)) throw new Error(`Notes can't ${String(op).slice(0, 40)}.`);
    const args = validArgs(op, raw);
    this.followShares(op, args);
    const touched = ["workspace", "toWorkspace"].map((f) => args[f]).filter((w): w is string => typeof w === "string");
    for (const ws of touched) await this.settled(ws);
    const handler = (this.ops as unknown as Record<string, (a: unknown, c: { view: string }) => unknown>)[op]!;
    if (op === "shareWorkspace" || op === "sharePage" || op === "stopSharingPage" || (op === "movePage" && typeof args.toWorkspace === "string" && args.toWorkspace !== args.workspace)) return handler(args, context);
    return this.tracked(touched, () => handler(args, context));
  }

  private shareLink(workspace: unknown, page: unknown): PageMeta | null {
    if (typeof workspace !== "string" || typeof page !== "string") return null;
    const tree = this.spaces.get(workspace)?.tree;
    const meta = tree ? getPage(tree, page) : null;
    if (!meta || !isShareLink(meta)) return null;
    return this.spaces.get(meta.sharedIn)?.record.root === meta.id ? meta : null;
  }

  private shareRootHome(workspace: unknown, page: unknown): string | null {
    const record = typeof workspace === "string" ? this.spaces.get(workspace)?.record : undefined;
    if (!record?.root || record.root !== page || !record.home || !this.spaces.has(record.home)) return null;
    return this.shareLink(record.home, page) ? record.home : null;
  }

  private followShares(op: string, args: Record<string, unknown>) {
    const ws = args.workspace;
    if (typeof ws !== "string") return;
    const rootOf = (id: unknown) => (typeof id === "string" ? this.spaces.get(id)?.record.root : undefined);
    switch (op) {
      case "createPage":
      case "useTemplate": {
        const link = this.shareLink(ws, args.parent) ?? this.shareLink(ws, args.into);
        if (link) args.workspace = link.sharedIn;
        const root = rootOf(args.workspace);
        if (root && op === "createPage" && !args.parent) args.parent = root;
        if (root && op === "useTemplate" && !args.parent && !args.into) args.parent = root;
        return;
      }
      case "duplicatePage":
      case "history":
      case "restoreVersion":
      case "versionState":
      case "backlinks": {
        const link = this.shareLink(ws, args.page);
        if (link) args.workspace = link.sharedIn;
        return;
      }
      case "archivePage":
      case "restorePage":
      case "deletePage": {
        const home = this.shareRootHome(ws, args.page);
        if (home) args.workspace = home;
        return;
      }
      case "movePage": {
        const home = this.shareRootHome(ws, args.page);
        if (home) {
          args.workspace = home;
        }
        const source = String(args.workspace);
        const dest = typeof args.toWorkspace === "string" ? args.toWorkspace : source;
        const link = this.shareLink(dest, args.parent);
        if (link) {
          args.toWorkspace = link.sharedIn;
          args.parent = link.id;
        }
        const target = typeof args.toWorkspace === "string" ? args.toWorkspace : source;
        const root = rootOf(target);
        if (root && !args.parent && args.page !== root) args.parent = root;
        if (args.toWorkspace === source) delete args.toWorkspace;
        return;
      }
    }
  }

  call<K extends OpName>(op: K, args: Ops[K]["args"]): Promise<Ops[K]["value"]> {
    return this.run(op, args) as Promise<Ops[K]["value"]>;
  }

  private copyMeta(fromTree: Y.Doc, id: string, toTree: Y.Doc, newIdValue: string, patch: Record<string, unknown>) {
    const source = pagesOf(fromTree).get(id);
    if (!source) return;
    const entry = new Y.Map<unknown>();
    toTree.transact(() => {
      source.forEach((value, key) => {
        if (key === "props") {
          const props = new Y.Map<unknown>();
          if (value instanceof Y.Map) value.forEach((v, k) => props.set(k, v instanceof Y.AbstractType ? (v as unknown as { clone(): unknown }).clone() : v));
          entry.set("props", props);
        } else entry.set(key, value instanceof Y.AbstractType ? (value as unknown as { clone(): unknown }).clone() : value);
      });
      for (const [k, v] of Object.entries(patch)) entry.set(k, v);
      pagesOf(toTree).set(newIdValue, entry);
    });
  }

  private subtree(tree: Y.Doc, root: string): string[] {
    const ids = [root];
    const pages = allPages(tree).filter((p) => !p.deleted);
    for (let i = 0; i < ids.length; i++) for (const child of pages) if (child.parent === ids[i] && !ids.includes(child.id)) ids.push(child.id);
    return ids;
  }

  readonly ops: { [K in OpName]: (args: Ops[K]["args"]) => Promise<Ops[K]["value"]> } & { [K in keyof ExtraOps]: (args: ExtraOps[K]["args"]) => Promise<ExtraOps[K]["value"]> } = {
    createPage: async (args) => {
      const space = this.space(args.workspace);
      const tree = await this.tree(space);
      if (args.parent) this.page(tree, args.parent);
      const template = args.template ? this.page(tree, args.template) : null;
      const id = createPage(tree, {
        parent: args.parent ?? "",
        kind: template?.kind ?? (args.kind === "database" ? "database" : "page"),
        title: typeof args.title === "string" ? args.title.slice(0, 2000) : template?.title,
        icon: typeof args.icon === "string" ? args.icon : template?.icon,
        after: args.after,
        props: args.props,
        by: this.deviceId,
        now: this.timers.now(),
      });
      const doc = this.freshDoc(space, id);
      if (template) {
        updatePage(tree, id, { cover: template.cover, coverY: template.coverY, font: template.font, fullWidth: template.fullWidth, smallText: template.smallText }, this.deviceId);
        const source = await this.docOf(space, `p-${template.id}`);
        replaceContent(doc, source);
      }
      this.lastWorkspace = space.record.id;
      return { page: id };
    },
    duplicatePage: async ({ workspace, page }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      const root = this.page(tree, page);
      if (space.record.root === page || isShareLink(root)) throw new Error("Duplicate the pages inside a shared page, or stop sharing it first.");
      const ids = this.subtree(tree, page).filter((id) => !isShareLink(getPage(tree, id)));
      const remap = new Map(ids.map((id) => [id, newId()]));
      const siblings = childrenOf(tree, root.parent);
      const index = siblings.findIndex((s) => s.id === page);
      const order = orderBetween(root.order, siblings[index + 1]?.order ?? null);
      const now = this.timers.now();
      for (const id of ids) {
        const meta = getPage(tree, id)!;
        const patch: Record<string, unknown> = { createdAt: now, updatedAt: now, createdBy: this.deviceId, updatedBy: this.deviceId, archivedAt: 0 };
        if (id === page) Object.assign(patch, { title: meta.title ? `${meta.title} (1)` : "", order });
        else patch.parent = remap.get(meta.parent) ?? meta.parent;
        this.copyMeta(tree, id, tree, remap.get(id)!, patch);
        const source = await this.docOf(space, `p-${id}`);
        const target = this.freshDoc(space, remap.get(id)!);
        target.transact(() => {
          replaceContent(target, source);
          remapPageRefs(blocksOf(target), remap);
        });
      }
      return { page: remap.get(page)! };
    },
    movePage: async ({ workspace, page, parent, after, toWorkspace }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      this.page(tree, page);
      if (space.record.root === page) throw new Error("A shared page stays at the top of its share.");
      if (!toWorkspace || toWorkspace === workspace) {
        if (parent) this.page(tree, parent);
        if (parent && isShareLink(getPage(tree, parent))) throw new Error("That page is shared; move pages into it from the shared copy.");
        if (!movePage(tree, page, parent ?? "", after, this.deviceId)) throw new Error("A page can't go inside itself.");
        return { page, workspace };
      }
      return this.withGates([workspace, toWorkspace], async () => {
        const from = this.space(workspace);
        const fromTree = await this.tree(from);
        this.page(fromTree, page);
        const target = this.space(toWorkspace);
        const toTree = await this.tree(target);
        if (parent) this.page(toTree, parent);
        const ids = this.subtree(fromTree, page);
        if (ids.some((id) => isShareLink(getPage(fromTree, id)))) throw new Error("A shared page can't move to another workspace. Stop sharing it first.");
        if (target.record.root && ids.includes(target.record.root)) throw new Error("A page can't go inside itself.");
        await this.copyPageFiles(from, target, fromTree, ids);
        for (const id of ids) {
          this.copyMeta(fromTree, id, toTree, id, id === page ? { parent: parent ?? "", order: "" } : {});
          const source = await this.docOf(from, `p-${id}`);
          const doc = await this.docOf(target, `p-${id}`);
          Y.applyUpdate(doc, fullState(source));
        }
        movePage(toTree, page, parent ?? "", after, this.deviceId);
        const landed = await target.store.flushDurable(["ws", ...ids.map((id) => `p-${id}`)], this.host.durableTimeoutMs);
        if (!landed) {
          deletePage(toTree, page, this.deviceId);
          throw new Error("The page couldn't be saved in the other workspace, so it stayed where it was.");
        }
        const doomed = deletePage(fromTree, page, this.deviceId);
        fromTree.transact(() => {
          for (const id of doomed) pagesOf(fromTree).get(id)?.set("movedTo", toWorkspace);
        });
        await from.store.flushDurable(["ws"], this.host.durableTimeoutMs);
        return { page, workspace: toWorkspace };
      });
    },
    archivePage: async ({ workspace, page }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      this.page(tree, page);
      if (space.record.root === page) throw new Error("This page was shared with you; leave it instead.");
      archivePage(tree, page, this.deviceId, this.timers.now());
      return null;
    },
    restorePage: async ({ workspace, page }) => {
      const tree = await this.tree(this.space(workspace));
      this.page(tree, page);
      restorePage(tree, page, this.deviceId);
      return null;
    },
    deletePage: async ({ workspace, page }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      const meta = this.page(tree, page);
      if (space.record.root === page) throw new Error("This page was shared with you; leave it instead.");
      const link = isShareLink(meta) ? this.spaces.get(meta.sharedIn) : undefined;
      const doomed = deletePage(tree, page, this.deviceId);
      for (const id of doomed) {
        this.index.remove(workspace, id);
        this.blockText.delete(keyOf(workspace, id));
        this.links.delete(keyOf(workspace, id));
      }
      const durable = space.store.flushDurable(["ws"], this.host.durableTimeoutMs);
      const keys = doomed.map((id) => `${workspace}\u0000${id}`);
      for (const key of keys) this.pendingDeletes.set(key, durable);
      const ok = await durable.finally(() => {
        for (const key of keys) if (this.pendingDeletes.get(key) === durable) this.pendingDeletes.delete(key);
      });
      if (!ok) throw new Error("The page is deleted here, but that isn't saved yet. Notes keeps trying.");
      if (link?.record.root === page && link.record.home === workspace) await this.dropShare(link);
      return null;
    },
    search: async ({ query, workspace, limit, titlesOnly }) => {
      if (typeof query !== "string") return [];
      if (!query.trim()) return this.index.recent(limit ?? 20, workspace);
      return this.index.search(query, { workspace, limit, titlesOnly });
    },
    resolve: async ({ path }) => this.resolve(typeof path === "string" ? path : ""),
    uploadPart: async (args, context?: { view: string }) => {
      this.uploadPart(args, context?.view ?? "");
      return null;
    },
    upload: async ({ workspace, name, type, uploadId }, context?: { view: string }) => {
      const space = this.space(workspace);
      const key = `${context?.view ?? ""}\u0000${uploadId}`;
      const up = this.uploads.get(key);
      if (!up) throw new Error("That upload didn't arrive.");
      this.uploads.delete(key);
      try {
        return await this.finishUpload(space, up, String(name ?? ""), String(type ?? ""));
      } finally {
        this.uploadBytes -= up.size;
        this.openUploads--;
      }
    },
    file: async ({ workspace, ref }) => {

      const space = this.space(workspace);
      await space.opening;
      const sha = String(ref ?? "").replace(/^file:/, "");
      const found = await space.store.getFile(sha);
      if (!found) throw new Error("That file isn't here yet.");
      const ext = found.name.slice(found.name.lastIndexOf(".") + 1);
      return { type: MIME[ext] ?? "application/octet-stream", data: toBase64(found.data) };
    },
    history: async ({ workspace, page }) => {
      this.space(workspace);
      if (typeof page !== "string" || !PAGE_ID.test(page)) return [];
      const me = this.me();
      return (await this.history.list(workspace, page)).map((v) => ({ ...v, by: v.by === this.deviceId ? me.name : v.by }));
    },
    versionState: async ({ workspace, page, version }) => {
      this.space(workspace);
      if (typeof page !== "string" || !PAGE_ID.test(page)) throw new Error("That version isn't here.");
      const state = await this.history.state(workspace, page, String(version));
      if (!state) throw new Error("That version isn't here.");
      return { state: toBase64(state) };
    },
    restoreVersion: async ({ workspace, page, version }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      this.page(tree, page);
      const state = await this.history.state(workspace, page, String(version));
      if (!state) throw new Error("That version isn't here.");
      const doc = await this.docOf(space, `p-${page}`);
      await this.history.snapshot(workspace, page, doc);
      const old = docFromState(state);
      replaceContent(doc, old, "restore");
      old.destroy();
      updatePage(tree, page, {}, this.deviceId, this.timers.now());
      return null;
    },
    createWorkspace: async ({ name }) => {
      const clean = String(name ?? "").trim().slice(0, 120) || "Untitled";
      const record: WorkspaceRecord = { id: newId(), name: clean, icon: "", shared: false, folderId: null, createdAt: this.timers.now() };
      const fs = this.fileStoreFor(record);
      await fs.writeText("workspace.json", JSON.stringify({ format: "ardia-notes", version: 1, id: record.id, name: clean }), { exclusive: true }).catch(() => undefined);
      return this.addWorkspace(record, fs, clean);
    },
    createSharedWorkspace: async ({ name }) => {
      if (!this.host.folders) throw new Error("Shared workspaces need folder access.");
      const clean = String(name ?? "").trim().slice(0, 120) || "Shared";
      const grant = await this.host.folders.create(clean);
      if (!grant) return null;
      return this.adoptFolder(grant, clean, true);
    },
    joinSharedWorkspace: async () => {
      if (!this.host.folders) throw new Error("Shared workspaces need folder access.");
      const grant = await this.host.folders.pick({ prompt: "Choose a shared Notes folder" });
      if (!grant) return null;
      return this.adoptFolder(grant, grant.name, false);
    },
    exportFile: async ({ name, text }) => {
      if (!this.host.folders) throw new Error("Exporting needs folder access.");
      const grant = await this.host.folders.pick({ prompt: "Choose a folder to export to" });
      if (!grant) return null;
      try {
        const store = ardiaFileStore(this.host.files, grant.id);
        const clean = String(name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 120) || "Untitled.md";
        const dot = clean.lastIndexOf(".");
        const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
        const bytes = new TextEncoder().encode(String(text ?? ""));
        for (let n = 1; n < 100; n++) {
          const candidate = n === 1 ? clean : `${stem} ${n}${ext}`;
          try {
            await store.write(candidate, bytes, { exclusive: true });
            return { folder: grant.name, name: candidate };
          } catch (e) {
            if (n === 99 || errorCode(e) !== "exists") throw e;
          }
        }
        return null;
      } finally {
        if (!this.records.some((r) => r.folderId === grant.id)) await this.host.folders.forget(grant.id).catch(() => undefined);
      }
    },
    shareWorkspace: async ({ workspace }) => {
      if (!this.host.folders) return { ok: false };
      await this.withGates([workspace], async () => {
        const space = this.space(workspace);
        if (!space.record.shared) await this.migrate(space);
      });
      const record = this.records.find((r) => r.id === workspace);
      if (!record?.folderId) return { ok: false };
      if (record.root) this.counts.bump("page_share_invites");
      return this.host.folders.share(record.folderId);
    },
    sharePage: async ({ workspace, page }) => {
      if (!this.host.folders) throw new Error("Sharing a page needs folder access.");
      try {
        const made = await this.withGates([workspace], () => this.sharePageNow(workspace, page));
        if (!made) return null;
        this.counts.bump("page_share_creates");
        const record = this.records.find((r) => r.id === made);
        const invited = record?.folderId ? (await this.host.folders.share(record.folderId).catch(() => ({ ok: false }))).ok : false;
        return { workspace: this.info(record!), invited };
      } catch (error) {
        this.counts.bump("page_share_failures");
        throw error;
      }
    },
    stopSharingPage: async ({ workspace }) => {
      const record = this.records.find((r) => r.id === workspace);
      if (!record?.root) throw new Error("That isn't a shared page.");
      if (!record.home || !this.spaces.has(record.home)) throw new Error("The private workspace it came from isn't on this Mac, so leave it instead.");
      const home = record.home;
      try {
        const page = await this.withGates([workspace, home], () => this.stopSharingNow(workspace, home));
        this.counts.bump("page_share_stops");
        return { workspace: home, page };
      } catch (error) {
        this.counts.bump("page_share_failures");
        throw error;
      }
    },
    renameWorkspace: async ({ workspace, name, icon }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      const clean = String(name ?? "").trim().slice(0, 120);
      tree.transact(() => {
        if (clean) metaOf(tree).set("name", clean);
        if (typeof icon === "string") metaOf(tree).set("icon", icon);
      });
      if (clean) space.record.name = clean;
      if (typeof icon === "string") space.record.icon = icon;
      await this.saveRecords();
      this.workspacesChanged();
      return null;
    },
    leaveWorkspace: async ({ workspace }) => {
      const space = this.space(workspace);
      const homeTree = space.record.root && space.record.home ? this.spaces.get(space.record.home)?.tree : null;
      if (homeTree && space.record.root && this.shareLink(space.record.home, space.record.root)) deletePage(homeTree, space.record.root, this.deviceId);
      await this.closeSpace(space);
      this.records = this.records.filter((r) => r.id !== workspace);
      if (space.record.shared && space.record.folderId && this.host.folders) await this.host.folders.forget(space.record.folderId).catch(() => undefined);
      else if (!space.record.shared) await this.removeAll(space.store.fs);
      await this.history.removeWorkspace(workspace).catch(() => undefined);
      if (this.lastWorkspace === workspace) this.lastWorkspace = null;
      if (this.lastPage?.workspace === workspace) this.lastPage = null;
      if (!this.records.some((r) => !r.root)) await this.createDefault();
      await this.saveRecords();
      this.workspacesChanged();
      return null;
    },
    openUrl: async ({ url }) => {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Only web addresses open from a note.");
      await this.host.openUrl(url);
      return null;
    },
    importStart: async ({ workspace, source, pick, uploadId }) => {
      await this.tree(this.space(workspace));
      return this.imports.start(workspace, source, pick ?? "folder", uploadId);
    },
    importUpload: async (args) => this.imports.upload(args),
    appIcon: async ({ path, size }) => {
      if (!this.host.appIcon) return { icon: null };
      try {
        const icon = await this.host.appIcon(path, size ?? 64);
        return { icon: typeof icon === "string" && icon.startsWith("data:image/png;base64,") ? icon : null };
      } catch {
        return { icon: null };
      }
    },
    agentStatus: async () => {
      if (!this.host.controlStatus) return { known: false, command: false, control: false };
      try {
        const status = await this.host.controlStatus();
        return { known: true, command: status.command === true, control: status.control === true };
      } catch {
        return { known: false, command: false, control: false };
      }
    },
    openArdiaSettings: async ({ pane }) => {
      if (!this.host.openArdiaSettings) return { ok: false };
      try {
        return { ok: (await this.host.openArdiaSettings(pane)) === true };
      } catch {
        return { ok: false };
      }
    },
    agentDemo: async ({ workspace }) => {
      await this.tree(this.space(workspace));
      return this.demos.start(workspace);
    },
    agentDemoStatus: async ({ job }) => this.demos.status(job),
    importStatus: async ({ job }) => this.imports.status(job),
    importCancel: async ({ job }) => {
      this.imports.cancel(job);
      return null;
    },
    notionAccount: async ({ fresh }) => this.notion.account(fresh === true),
    notionImport: async ({ space }) => this.notion.start(space),
    notionImportStatus: async () => this.notion.status(),
    notionImportCancel: async () => {
      await this.notion.cancel();
      return null;
    },
    applyStarter: async ({ workspace, starter }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      const page = applyStarter(tree, starter, this.deviceId, (id) => this.freshDoc(space, id), this.timers.now());
      this.lastWorkspace = space.record.id;
      this.rememberPage(space.record.id, page);
      await space.store.flush();
      return { page };
    },
    useTemplate: async ({ workspace, template, parent, into }) => {
      const spec = templateById(template);
      if (!spec) throw new Error("That template isn't here any more.");
      const space = this.space(workspace);
      const tree = await this.tree(space);
      if (parent) this.page(tree, parent);
      let target: { page: string; doc: Y.Doc } | undefined;
      if (into) {
        if (this.page(tree, into).kind !== "page") throw new Error("A template can only fill a page.");
        const doc = await this.docOf(space, `p-${into}`);
        if (!isBlankFragment(blocksOf(doc))) throw new Error("That page isn't empty any more, so the template wasn't added.");
        target = { page: into, doc };
      }
      const me = this.me();
      const made = instantiateTemplate({ tree, by: this.deviceId, newDoc: (id) => this.freshDoc(space, id), now: this.timers.now() }, spec, { parent: parent ?? "", ...(target ? { into: target } : {}), me: { name: me.name, color: me.color } });
      this.counts.bump(templateUseCount(template));
      this.lastWorkspace = space.record.id;
      return { page: made.page };
    },
    countEvent: async ({ event }) => {
      this.counts.bump(event);
      return null;
    },
    counts: async () => this.counts.snapshot(),
    setMe: async ({ name, color }) => {
      const next = { ...this.storedMe };
      if (typeof name === "string") next.name = name.trim().slice(0, 80) || undefined;
      if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) next.color = color;
      this.storedMe = next;
      await this.host.storage.set("me", next);
      const me = this.me();
      this.broadcast({ t: "me", me });
      this.updatePresence();
      return me;
    },
    backlinks: async ({ workspace, page }) => {
      const space = this.space(workspace);
      const tree = await this.tree(space);
      const out: { page: string; title: string; icon: string }[] = [];
      for (const [key, set] of this.links) {
        if (!set.has(page) || !key.startsWith(`${workspace}/`)) continue;
        const other = key.slice(workspace.length + 1);
        const meta = getPage(tree, other);
        if (!meta || other === page || isArchivedDeep(tree, other)) continue;
        out.push({ page: other, title: displayTitle(meta), icon: meta.icon });
      }
      return out;
    },
  };

  private async addWorkspace(record: WorkspaceRecord, fs: FileStore, name: string, seed = true): Promise<WorkspaceInfo> {
    this.records.push(record);
    await this.saveRecords();
    const space = this.openSpace(record, fs);
    await space.opening;
    if (space.tree && seed) {
      const tree = space.tree;
      if (!metaOf(tree).get("name")) metaOf(tree).set("name", name);
      if (allPages(tree).length === 0) createPage(tree, { parent: "", kind: "page", title: "", by: this.deviceId, now: this.timers.now() });
      await space.store.flush();
    }
    this.workspacesChanged();
    return this.info(record);
  }

  private async adoptFolder(grant: FolderGrant, name: string, fresh: boolean): Promise<WorkspaceInfo> {
    const fs = ardiaFileStore(this.host.files, grant.id, "");
    const existing = await this.readWorkspaceJson(fs);
    if (existing) {
      const known = this.records.find((r) => r.id === existing.id);
      if (known) {
        if (known.folderId !== grant.id) {
          known.folderId = grant.id;
          await this.saveRecords();
        }
        return this.info(known);
      }
      const record: WorkspaceRecord = { id: existing.id, name: existing.name || name, icon: "", shared: true, folderId: grant.id, createdAt: this.timers.now() };
      if (existing.root) Object.assign(record, { root: existing.root, home: null, location: grant.location, folder: grant.name });
      const info = await this.addWorkspace(record, fs, record.name, false);
      if (existing.root) this.counts.bump("page_share_joins");
      return info;
    }
    if (!fresh) {
      const entries = await fs.list("").catch(() => []);
      if (entries.some((e) => !e.path.split("/").pop()!.startsWith("."))) throw new Error("That folder has other files in it. Choose an empty folder, or one someone shared from Notes.");
    }
    const record: WorkspaceRecord = { id: newId(), name, icon: "", shared: true, folderId: grant.id, createdAt: this.timers.now() };
    try {
      await fs.writeText("workspace.json", JSON.stringify({ format: "ardia-notes", version: 1, id: record.id, name }), { exclusive: true });
    } catch (error) {
      if (errorCode(error) !== "exists") throw error;
      const raced = await this.readWorkspaceJson(fs);
      if (raced) return this.adoptFolder(grant, name, fresh);
      throw error;
    }
    return this.addWorkspace(record, fs, name);
  }

  private async readWorkspaceJson(fs: FileStore): Promise<{ id: string; name: string; root: string | null } | null> {
    const res = await fs.read("workspace.json", { length: WORKSPACE_JSON_MAX + 1 }).catch(() => null);
    if (!res?.found || res.size > WORKSPACE_JSON_MAX || res.data.length > WORKSPACE_JSON_MAX) return null;
    return parseWorkspaceJson(new TextDecoder().decode(res.data));
  }

  private async tracked<T>(workspaces: string[], task: () => T | Promise<T>): Promise<T> {
    for (const ws of workspaces) this.busy.set(ws, (this.busy.get(ws) ?? 0) + 1);
    try {
      return await task();
    } finally {
      for (const ws of workspaces) {
        const left = (this.busy.get(ws) ?? 1) - 1;
        if (left > 0) this.busy.set(ws, left);
        else {
          this.busy.delete(ws);
          for (const wake of this.idle.get(ws)?.splice(0) ?? []) wake();
        }
      }
    }
  }

  private drained(workspace: string): Promise<void> {
    if (!this.busy.get(workspace)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.idle.get(workspace) ?? [];
      list.push(resolve);
      this.idle.set(workspace, list);
    });
  }

  private async settled(workspace: string) {
    for (let gate = this.gates.get(workspace); gate; gate = this.gates.get(workspace)) await gate;
  }

  private async withGates<T>(ids: string[], task: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(ids)].sort();
    for (let busy = sorted.find((id) => this.gates.has(id)); busy; busy = sorted.find((id) => this.gates.has(id))) await this.settled(busy);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    for (const id of sorted) this.gates.set(id, gate);
    try {
      for (const id of sorted) await this.drained(id);
      return await task();
    } finally {
      for (const id of sorted) if (this.gates.get(id) === gate) this.gates.delete(id);
      release();
    }
  }

  private async migrate(space: Space) {
    const folders = this.host.folders!;
    const tree = await this.tree(space);
    const name = String(metaOf(tree).get("name") ?? space.record.name) || space.record.name;
    const grant = await folders.create(name);
    if (!grant) throw new Error("The shared folder wasn't made.");
    const fs = ardiaFileStore(this.host.files, grant.id, "");
    const oldFs = space.store.fs;
    const before = { ...space.record };
    const copied = new Set<string>();
    try {
      await this.drained(space.record.id);
      const existing = await this.readWorkspaceJson(fs);
      if (existing && existing.id !== space.record.id) throw new Error("A different workspace already lives in that folder.");
      if (!existing) await fs.writeText("workspace.json", JSON.stringify({ format: "ardia-notes", version: 1, id: space.record.id, name }), { exclusive: true });
      await space.store.loadAll();
      await space.store.flush();
      if (space.store.hasPending()) throw new Error("Notes couldn't save everything before sharing.");
      await this.copyFiles(oldFs, fs, copied);
      const states = new Map<string, Uint8Array>();
      for (const [docName, doc] of space.store.loadedDocs()) {
        const state = fullState(doc);
        await writeBlob(fs, `docs/${docName}/${this.deviceId}.snap`, state, { chunkDir: `docs/${docName}/.chunks-${this.deviceId}` });
        states.set(docName, state);
      }
      await this.verifyCopy(fs, states);
      const subscribed = [...this.views.values()].map((v) => [v, [...v.subs].filter((k) => k.startsWith(`${space.record.id}\u0000`))] as const);
      space.record.shared = true;
      space.record.folderId = grant.id;
      try {
        await this.saveRecords();
      } catch (error) {
        Object.assign(space.record, before);
        await this.saveRecords().catch(() => undefined);
        throw error;
      }
      await this.closeSpace(space);
      try {
        await this.copyFiles(oldFs, fs, copied);
      } catch (error) {
        Object.assign(space.record, before);
        await this.saveRecords().catch(() => undefined);
        this.openSpace(space.record, oldFs);
        await this.removeAll(fs).catch(() => undefined);
        await folders.forget(grant.id).catch(() => undefined);
        throw error;
      }
      const next = this.openSpace(space.record, fs);
      await next.opening;
      await next.store.loadAll();
      let verified = true;
      for (const [docName, state] of states) if (!sameContent(state, fullState(await next.store.get(docName)))) verified = false;
      if (!verified) {
        await this.closeSpace(next);
        Object.assign(space.record, before);
        await this.saveRecords().catch(() => undefined);
        this.openSpace(space.record, oldFs);
        await this.removeAll(fs).catch(() => undefined);
        await folders.forget(grant.id).catch(() => undefined);
        throw new Error("The shared copy didn't match, so the workspace stayed private.");
      }
      for (const [view, keys] of subscribed) {
        for (const key of keys) {
          const doc = key.split("\u0000")[1]!;
          const ydoc = await this.docOf(next, diskDocName(doc));
          view.subs.add(key);
          this.enqueue(view, { t: "up", doc, workspace: space.record.id, u: toBase64(Y.encodeStateAsUpdate(ydoc)) });
        }
      }
      await this.removeAll(oldFs);
      this.workspacesChanged();
    } catch (error) {
      if (this.spaces.get(space.record.id) === space) {
        await this.removeAll(fs).catch(() => undefined);
        await folders.forget(grant.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async copyPageFiles(from: Space, to: Space, tree: Y.Doc, ids: string[], options: { complete?: boolean } = {}) {
    const refs = new Set<string>();
    for (const id of ids) {
      fileRefsOfEntry(pagesOf(tree).get(id), refs);
      fileRefsOfState(fullState(await this.docOf(from, `p-${id}`)), refs);
    }
    const missing: string[] = [];
    const copies: { data: Uint8Array; ext: string }[] = [];
    for (const sha of refs) {
      if (await to.store.getFile(sha).catch(() => null)) continue;
      const found = await from.store.getFile(sha).catch(() => null);
      if (!found) {
        missing.push(sha);
        continue;
      }
      copies.push({ data: found.data, ext: found.name.slice(found.name.lastIndexOf(".") + 1) });
    }
    if (options.complete && missing.length) {
      const downloading = await from.store.filesDownloading(missing).catch(() => missing);
      if (downloading.length) throw new Error(`${downloading.length === 1 ? "An attachment" : `${downloading.length} attachments`} in the shared page ${downloading.length === 1 ? "is" : "are"} still downloading from iCloud, so sharing didn't stop. Try again once ${downloading.length === 1 ? "it's" : "they're"} down.`);
      throw new Error(`${missing.length === 1 ? "An attachment" : `${missing.length} attachments`} in the shared page ${missing.length === 1 ? "isn't" : "aren't"} in its folder, so sharing didn't stop. Ask whoever added ${missing.length === 1 ? "it" : "them"} to open the page so ${missing.length === 1 ? "it" : "they"} upload again.`);
    }
    for (const sha of missing) this.log("warn", `The attachment ${sha.slice(0, 12)} isn't here, so it didn't come along.`);
    for (const copy of copies) await to.store.putFile(copy.data, copy.ext);
  }

  private async sharePageNow(workspace: string, page: string): Promise<string | null> {
    const folders = this.host.folders!;
    const home = this.space(workspace);
    const homeTree = await this.tree(home);
    const meta = this.page(homeTree, page);
    if (home.record.shared) throw new Error("Everyone in this workspace can already see this page.");
    if (isShareLink(meta)) throw new Error("This page is already shared.");
    if (meta.isTemplate) throw new Error("A template can't be shared on its own.");
    if (meta.parent && getPage(homeTree, meta.parent)?.kind === "database") throw new Error("Share the database this row belongs to instead.");
    if (isArchivedDeep(homeTree, page)) throw new Error("Restore this page from the Trash before sharing it.");
    const ids = this.subtree(homeTree, page);
    if (ids.some((id) => id !== page && isShareLink(getPage(homeTree, id)))) throw new Error("A page inside this one is already shared. Stop sharing it first.");
    const name = displayTitle(meta).slice(0, 120);
    const grant = await folders.create(name);
    if (!grant) return null;
    const fs = ardiaFileStore(this.host.files, grant.id, "");
    const record: WorkspaceRecord = { id: newId(), name, icon: meta.icon.startsWith("file:") ? "" : meta.icon, shared: true, folderId: grant.id, createdAt: this.timers.now(), root: page, home: workspace, location: grant.location, folder: grant.name };
    let share: Space | null = null;
    let switched = false;
    try {
      await fs.writeText("workspace.json", JSON.stringify({ format: "ardia-notes", version: 1, id: record.id, name, root: page }), { exclusive: true });
      share = this.openSpace(record, fs);
      await share.opening;
      const shareTree = await this.tree(share);
      metaOf(shareTree).set("name", name);
      await this.copyPageFiles(home, share, homeTree, ids);
      const states = new Map<string, Uint8Array>();
      for (const id of ids) {
        this.copyMeta(homeTree, id, shareTree, id, id === page ? { parent: "", order: orderBetween(null, null) } : {});
        const state = fullState(await this.docOf(home, `p-${id}`));
        Y.applyUpdate(await this.docOf(share, `p-${id}`), state);
        states.set(`p-${id}`, state);
      }
      states.set("ws", fullState(shareTree));
      if (!(await share.store.flushDurable([...states.keys()], this.host.durableTimeoutMs))) throw new Error("The shared copy couldn't be saved, so the page stayed private.");
      await this.verifyCopy(fs, states);
      this.records.push(record);
      try {
        await this.saveRecords();
      } catch (error) {
        this.records = this.records.filter((r) => r !== record);
        throw error;
      }
      switched = true;
      const now = this.timers.now();
      homeTree.transact(() => {
        pagesOf(homeTree).get(page)?.set("sharedIn", record.id);
        for (const id of ids) {
          if (id === page) continue;
          updatePage(homeTree, id, { deleted: true, title: "", icon: "", cover: "" }, this.deviceId, now);
          pagesOf(homeTree).get(id)?.set("movedTo", record.id);
        }
      });
      for (const id of ids) {
        this.index.remove(workspace, id);
        this.blockText.delete(keyOf(workspace, id));
        this.links.delete(keyOf(workspace, id));
      }
      if (!(await home.store.flushDurable(["ws"], this.host.durableTimeoutMs))) this.log("warn", `The link to shared page ${page} isn't saved yet; Notes keeps trying.`);
      this.workspacesChanged();
      return record.id;
    } catch (error) {
      if (!switched) {
        if (share) await this.closeSpace(share).catch(() => undefined);
        await this.removeAll(fs).catch(() => undefined);
        await folders.forget(grant.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async stopSharingNow(workspace: string, homeId: string): Promise<string> {
    const share = this.space(workspace);
    const home = this.space(homeId);
    const root = share.record.root!;
    const shareTree = await this.tree(share);
    const homeTree = await this.tree(home);
    const link = getPage(homeTree, root);
    if (!link || !isShareLink(link) || link.sharedIn !== workspace) throw new Error("This shared page isn't linked from your private workspace any more.");
    await share.store.rescan();
    await share.store.loadAll();
    await share.store.flush();
    if (share.store.hasPending()) throw new Error("Notes couldn't save everything before bringing the page back.");
    const rootMeta = getPage(shareTree, root);
    if (!rootMeta || rootMeta.deleted) throw new Error("The shared page isn't in its folder any more.");
    const strays = allPages(shareTree).filter((p) => !p.deleted && p.parent === "" && p.id !== root).map((p) => p.id);
    const ids = [...new Set([root, ...this.subtree(shareTree, root), ...strays.flatMap((id) => this.subtree(shareTree, id))])];
    const clash = ids.find((id) => {
      if (id === root) return false;
      const mine = pagesOf(homeTree).get(id);
      return !!mine && !(mine.get("deleted") === true && mine.get("movedTo") === workspace);
    });
    if (clash) throw new Error("A page in the share has the same id as one of your private pages, so sharing didn't stop.");
    const rejected = new Set(share.store.rejected());
    if (ids.some((id) => rejected.has(`p-${id}`))) throw new Error("Part of the shared page couldn't be read, so sharing didn't stop.");
    if (share.store.waitingFor(["ws", ...ids.map((id) => `p-${id}`)]).length) throw new Error("Someone's latest edits to the shared page are still downloading from iCloud, so sharing didn't stop. Try again once they're down.");
    await this.copyPageFiles(share, home, shareTree, ids, { complete: true });
    const incoming = new Map<string, Uint8Array>();
    for (const id of ids) {
      const shared = await this.docOf(share, `p-${id}`);
      const local = await this.docOf(home, `p-${id}`);
      const merged = docFromState(fullState(local));
      Y.applyUpdate(merged, fullState(shared));
      const same = visibleContent(merged) === visibleContent(shared);
      merged.destroy();
      if (!same) throw new Error("The private copy has changes the shared one doesn't, so sharing didn't stop.");
      incoming.set(id, fullState(shared));
    }
    const states = new Map<string, Uint8Array>();
    for (const [id, state] of incoming) {
      const local = await this.docOf(home, `p-${id}`);
      Y.applyUpdate(local, state);
      states.set(`p-${id}`, fullState(local));
    }
    if (!(await home.store.flushDurable([...states.keys()], this.host.durableTimeoutMs))) throw new Error("The pages couldn't be saved here, so sharing didn't stop.");
    await this.verifyCopy(home.store.fs, states);
    homeTree.transact(() => {
      for (const id of ids) {
        const patch: Record<string, unknown> = id === root ? { parent: link.parent, order: link.order } : strays.includes(id) ? { parent: root } : {};
        this.copyMeta(shareTree, id, homeTree, id, patch);
      }
    });
    if (!(await home.store.flushDurable(["ws"], this.host.durableTimeoutMs))) throw new Error("The pages are back here but not saved yet, so the share stays until they are.");
    this.redirects.set(workspace, homeId);
    if (this.lastPage?.workspace === workspace) this.rememberPage(homeId, this.lastPage.page);
    await this.dropShare(share);
    return root;
  }

  private async dropShare(space: Space) {
    const id = space.record.id;
    await this.closeSpace(space);
    this.records = this.records.filter((r) => r.id !== id);
    await this.saveRecords();
    if (space.record.folderId && this.host.folders) await this.host.folders.forget(space.record.folderId).catch(() => undefined);
    await this.history.removeWorkspace(id).catch(() => undefined);
    if (this.lastWorkspace === id) this.lastWorkspace = null;
    if (this.lastPage?.workspace === id) this.lastPage = null;
    this.workspacesChanged();
  }

  private async verifyCopy(fs: FileStore, states: Map<string, Uint8Array>) {
    const verifier = new WorkspaceStore({ fs, deviceId: `verify${randomHex(4)}`, timers: this.timers, rescanMs: 0, debounceMs: 3_600_000, maxDocBytes: Number.MAX_SAFE_INTEGER, maxWorkspaceBytes: Number.MAX_SAFE_INTEGER });
    try {
      await verifier.open();
      await verifier.loadAll();
      const names = new Set(verifier.docNames());
      for (const [docName, state] of states) {
        if (!names.has(docName)) {
          if (sameContent(state, Y.encodeStateAsUpdate(new Y.Doc()))) continue;
          throw new Error(`${docName} is missing from the copy.`);
        }
        if (!sameContent(state, fullState(await verifier.get(docName)))) throw new Error(`${docName} didn't copy correctly.`);
      }
      if (verifier.rejected().length) throw new Error("The shared copy couldn't be read back.");
    } finally {
      await verifier.close({ flush: false }).catch(() => undefined);
    }
  }

  private async copyFiles(from: FileStore, to: FileStore, copied: Set<string>) {
    for (const e of await from.list("files")) {
      const base = e.path.slice(e.path.lastIndexOf("/") + 1);
      const m = /^([0-9a-f]{64})\.[a-z0-9]{1,10}$/.exec(base);
      if (e.kind !== "file" || !m || copied.has(base)) continue;
      const res = await readBlob(from, `files/${base}`, { maxBytes: FILE_BYTES_MAX });
      if (!res.found || "tooLarge" in res || sha256Hex(res.data) !== m[1]) throw new Error(`The attachment ${base} couldn't be read to copy.`);
      try {
        await writeBlob(to, `files/${base}`, res.data, { chunkDir: "files/.chunks", exclusive: true });
      } catch (error) {
        if (errorCode(error) !== "exists") throw error;
      }
      const back = await readBlob(to, `files/${base}`, { maxBytes: FILE_BYTES_MAX });
      if (!back.found || "tooLarge" in back || sha256Hex(back.data) !== m[1]) throw new Error(`The attachment ${base} didn't copy correctly.`);
      copied.add(base);
    }
  }

  private async closeSpace(space: Space) {
    space.closed = true;
    for (const t of space.textTimers.values()) this.timers.clearTimeout(t);
    space.textTimers.clear();
    if (space.treeTimer !== null) this.timers.clearTimeout(space.treeTimer);
    await space.cursors?.close().catch(() => undefined);
    await space.store.close().catch(() => undefined);
    this.spaces.delete(space.record.id);
    this.index.removeWorkspace(space.record.id);
    for (const key of [...this.blockText.keys()]) if (key.startsWith(`${space.record.id}/`)) this.blockText.delete(key);
    for (const key of [...this.links.keys()]) if (key.startsWith(`${space.record.id}/`)) this.links.delete(key);
  }

  private async removeAll(fs: FileStore) {
    const entries = await fs.list("", { recursive: true }).catch(() => []);
    for (const e of entries) if (e.kind === "file") await fs.remove(e.path).catch(() => false);
  }

  async resolve(path: string): Promise<{ workspace: string; page: string } | null> {
    await this.start();
    const clean = path.split(/[?#]/)[0] ?? "";
    const id = pageIdFromPath(clean);
    if (id) {
      for (const space of this.spaces.values()) {
        await space.opening;
        const page = space.tree ? getPage(space.tree, id) : null;
        if (page && !page.deleted && !isShareLink(page)) return { workspace: space.record.id, page: id };
      }
      return null;
    }
    if (clean.replace(/\/+/g, "") !== "") return null;
    const last = this.lastPage;
    if (last) {
      const space = this.spaces.get(last.workspace);
      if (space) {
        await space.opening;
        const page = space.tree ? getPage(space.tree, last.page) : null;
        if (page && !page.deleted && !isShareLink(page) && !isArchivedDeep(space.tree!, last.page)) return last;
      }
    }
    const order = [this.lastWorkspace, ...this.records.map((r) => r.id)].filter((x): x is string => !!x);
    for (const wsId of order) {
      const space = this.spaces.get(wsId);
      if (!space || space.record.root) continue;
      await space.opening;
      if (!space.tree) continue;
      const first = childrenOf(space.tree, "").find((p) => !p.isTemplate);
      if (first) return { workspace: wsId, page: first.id };
    }
    return null;
  }

  async newPage(): Promise<string> {
    await this.start();
    const wsId = this.lastWorkspace && this.spaces.has(this.lastWorkspace) && !this.spaces.get(this.lastWorkspace)!.record.root ? this.lastWorkspace : this.records.find((r) => !r.root)?.id;
    const { page } = await this.call("createPage", { workspace: wsId ?? "", parent: "", kind: "page" });
    const path = pagePath({ id: page, title: "" });
    await this.host.openPage(path);
    return path;
  }

  async openSearch(query?: string) {
    await this.host.openPage(query ? `/search?q=${encodeURIComponent(query)}` : "/search");
  }

  omnibox(query: string, provider: string): { title: string; url: string; subtitle?: string; icon?: string }[] {
    const keyword = provider === "n";
    const q = query.trim();
    if (!keyword) {
      if (q.length < 2) return [];
      if (this.host.setting("searchEverywhere") === false) return [];
    }
    const hits = q ? this.index.search(q, { limit: keyword ? 8 : 5 }) : keyword ? this.index.recent(8) : [];
    return hits.map((hit) => {
      const kind = this.kindOf(hit.workspace, hit.page);
      const crumbs = hit.path.length ? hit.path.join(" / ") : this.workspaceName(hit.workspace);
      const subtitle = hit.snippet || crumbs;
      return { title: hit.title, url: `ardia://notes${pagePath({ id: hit.page, title: hit.title })}`, subtitle, icon: kind === "database" ? "tablecells" : "doc.text" };
    });
  }

  private kindOf(workspace: string, page: string) {
    const tree = this.spaces.get(workspace)?.tree;
    return tree ? getPage(tree, page)?.kind ?? "page" : "page";
  }

  private workspaceName(workspace: string) {
    return this.workspaces().find((w) => w.id === workspace)?.name ?? "";
  }

  async whenIdle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await this.whenViewsIdle();
      await Promise.all([...this.spaces.values()].map((s) => s.opening.then(() => s.store.whenIdle())));
      await this.history?.flushed();
    }
  }

  access(): NotesAccess {
    return {
      deviceId: () => this.deviceId,
      me: () => this.me(),
      run: async (op, args) => {
        await this.start();
        return this.run(op, args);
      },
      has: (op) => isOp(op) && Object.hasOwn(this.ops, op),
      workspaces: () => this.workspaces(),
      tree: async (workspace) => {
        await this.start();
        await this.settled(workspace);
        return this.tree(this.space(workspace));
      },
      doc: async (workspace, page) => {
        const space = this.space(workspace);
        await space.opening;
        return this.docOf(space, `p-${page}`);
      },
      edit: async (workspaces, task) => {
        await this.start();
        for (const ws of workspaces) await this.settled(ws);
        return this.tracked(workspaces, task);
      },
      beforeEdit: (workspace, page, doc) => this.history.beforeEdit(workspace, page, doc).catch(() => undefined),
      flush: (workspace, docs) => this.space(workspace).store.flushDurable(docs, this.host.durableTimeoutMs),
      putFile: async (workspace, bytes, name, type) => {
        const space = this.space(workspace);
        await space.opening;
        return `file:${await space.store.putFile(bytes, extFor(name, type))}`;
      },
      openPath: (path) => this.host.openPage(path),
      setting: (key) => this.host.setting(key),
      storage: this.host.storage,
      reindex: () => this.reindexNow(),
      now: () => this.timers.now(),
    };
  }

  spaceStore(workspace: string): WorkspaceStore | null {
    return this.spaces.get(workspace)?.store ?? null;
  }

  treeOf(workspace: string): Y.Doc | null {
    return this.spaces.get(workspace)?.tree ?? null;
  }

  reindexNow() {
    for (const space of this.spaces.values()) {
      for (const [page, timer] of space.textTimers) {
        this.timers.clearTimeout(timer);
        space.textTimers.delete(page);
        const doc = space.store.peek(`p-${page}`);
        if (doc) this.indexText(space, page, doc);
      }
      if (space.treeTimer !== null) {
        this.timers.clearTimeout(space.treeTimer);
        space.treeTimer = null;
      }
      this.reindexTree(space);
    }
  }
}
