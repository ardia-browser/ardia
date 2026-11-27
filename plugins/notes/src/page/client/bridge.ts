import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { fromBase64, randomHex, toBase64 } from "../../shared/bytes";
import {
  PAGE_TO_MAIN_MAX,
  PAGE_TO_MAIN_RATE,
  Reassembler,
  UPLOAD_PART_MAX,
  splitMessage,
  type Chunk,
  type DocId,
  type ExtraOpName,
  type ExtraOps,
  type MainToPage,
  type Me,
  type OpName,
  type Ops,
  type PageToMain,
  type PageId,
  type PresenceEntry,
  type WorkspaceId,
  type WorkspaceInfo,
} from "../../shared/protocol";
import type { NotesClient, OpenDoc, Unsubscribe } from "./types";

export type ArdiaPageBridge = {
  send(value: unknown): boolean | void;
  addEventListener(type: string, listener: (event: Event & { data?: unknown }) => void): void;
  path: string;
  navigate(path: string, options?: { replace?: boolean }): void;
};

export type BridgeOptions = { ardia?: ArdiaPageBridge; rate?: number; window?: Window & typeof globalThis; resendMs?: number; memoryChars?: number };

const REMOTE = { remote: true } as const;
const SEND_WINDOW_MS = 1100;
const PART_TIMEOUT_MS = 15_000;
const PART_TRIES = 4;
const PARTS_IN_FLIGHT = 16;
const REFUSED_RETRY_MS = 60;
const OLD_UNACKED_PREFIX = "ardia-notes-unacked:";
export const JOURNAL_PREFIX = "ardia-notes-journal|";
const JOURNAL_CHARS_MAX = 4 * 1024 * 1024;
const OTHER_DEVICE_MAX_AGE = 7 * 24 * 3600_000;
const RESEND_BASE_MS = 5000;
const RESEND_MAX_MS = 60_000;
const MEMORY_CHARS_MAX = 32 * 1024 * 1024;

export const journalKey = (device: string, workspace: string, doc: string, view: string, seq: number) => `${JOURNAL_PREFIX}${device}|${workspace}|${doc}|${view}|${seq}`;

export type SaveState = { state: "saved" | "saving" | "unsaved" | "blocked"; refused: number };

type JournalEntry = { seq: number; workspace: WorkspaceId; doc: DocId; u: string; key: string | null; adopted: string[]; at: number; sentAt: number; tries: number };
const LONG_OPS = new Set<string>(["createSharedWorkspace", "joinSharedWorkspace", "shareWorkspace", "leaveWorkspace", "upload"]);

type Shared = {
  workspace: WorkspaceId;
  doc: DocId;
  ydoc: Y.Doc;
  awareness: Awareness;
  refs: number;
  synced: Promise<void>;
  resolveSynced: () => void;
  pending: number[];
  upTimer: ReturnType<typeof setTimeout> | null;
  awTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
};

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    on(listener: (value: T) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T) {
      for (const l of [...listeners]) {
        try {
          l(value);
        } catch (error) {
          console.error("[notes]", error);
        }
      }
    },
  };
}

const normalizePath = (path: string) => {
  const p = path.startsWith("#") ? path.slice(1) : path;
  return p.startsWith("/") ? p : `/${p}`;
};

export function createBridgeClient(options: BridgeOptions = {}): NotesClient & { saveState(): SaveState; onSaveState(listener: (state: SaveState) => void): Unsubscribe } {
  const win = options.window ?? window;
  const ardia = options.ardia ?? (win as unknown as { ardia?: ArdiaPageBridge }).ardia ?? null;
  const rate = options.rate ?? PAGE_TO_MAIN_RATE;
  const resendMs = options.resendMs ?? RESEND_BASE_MS;
  const memoryLimit = options.memoryChars ?? MEMORY_CHARS_MAX;

  let me: Me = { deviceId: "", name: "Someone", color: "#888888" };
  let workspaces: WorkspaceInfo[] = [];
  let presence: PresenceEntry[] = [];
  const meEvents = emitter<Me>();
  const workspaceEvents = emitter<WorkspaceInfo[]>();
  const presenceEvents = emitter<PresenceEntry[]>();
  const pathEvents = emitter<string>();

  let isReady = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));

  const outbox: (PageToMain | Chunk)[] = [];
  const held: PageToMain[] = [];
  const sentAt: number[] = [];
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  let upSeq = 0;
  const nextId = (prefix: string) => `${prefix}${++seq}${randomHex(3)}`;

  const transmit = (value: unknown): boolean => {
    try {
      return ardia?.send(value) !== false;
    } catch (error) {
      console.error("[notes] send failed", error);
      return false;
    }
  };

  const pump = () => {
    pumpTimer = null;
    const now = performance.now();
    while (sentAt.length && now - sentAt[0]! >= SEND_WINDOW_MS) sentAt.shift();
    let refused = false;
    while (outbox.length && sentAt.length < rate) {
      if (!transmit(outbox[0])) {
        refused = true;
        break;
      }
      outbox.shift();
      sentAt.push(now);
    }
    if (outbox.length) pumpTimer = setTimeout(pump, refused || !sentAt.length ? REFUSED_RETRY_MS : Math.max(5, Math.ceil(SEND_WINDOW_MS - (now - sentAt[0]!)) + 1));
  };

  const enqueue = (msg: PageToMain) => {
    for (const piece of splitMessage(msg, PAGE_TO_MAIN_MAX, nextId("c"))) outbox.push(piece as PageToMain | Chunk);
    if (pumpTimer === null) pump();
  };

  const send = (msg: PageToMain) => {
    if (!isReady && msg.t !== "hello") held.push(msg);
    else enqueue(msg);
  };

  const docs = new Map<string, Shared>();
  const keyOf = (workspace: string, doc: string) => `${workspace}\u0000${doc}`;

  const flushUps = (shared: Shared) => {
    if (shared.upTimer !== null) clearTimeout(shared.upTimer);
    shared.upTimer = null;
    if (!shared.pending.length) return;
    const entries = shared.pending.map((seq) => journal.get(seq)).filter((e): e is JournalEntry => !!e);
    shared.pending = [];
    if (!entries.length) return;
    const texts = entries.map((e) => updateOf(e));
    if (texts.some((t) => !t)) {
      for (const e of entries) sendEntry(e);
      return;
    }
    const u = texts.length === 1 ? texts[0]! : toBase64(Y.mergeUpdates(texts.map((t) => fromBase64(t!))));
    const now = performance.now();
    for (const e of entries) e.sentAt = now;
    send({ t: "up", doc: shared.doc, workspace: shared.workspace, u, seq: entries[entries.length - 1]!.seq, from: entries[0]!.seq, load: viewNonce });
    scheduleResend();
  };

  const journalUpdate = (shared: Shared, update: Uint8Array) => {
    const seq = ++upSeq;
    const entry: JournalEntry = { seq, workspace: shared.workspace, doc: shared.doc, u: toBase64(update), key: null, adopted: [], at: Date.now(), sentAt: 0, tries: 0 };
    journal.set(seq, entry);
    writeJournal(entry);
    saveChanged();
    shared.pending.push(seq);
    if (shared.upTimer === null) shared.upTimer = setTimeout(() => flushUps(shared), 30);
  };

  const storage = (() => {
    try {
      return (win as unknown as { localStorage?: Storage }).localStorage ?? null;
    } catch {
      return null;
    }
  })();
  const journal = new Map<number, JournalEntry>();
  const adoptedKeys = new Set<string>();
  const viewNonce = randomHex(6);
  let refusedCount = 0;
  let lastSaveState = "";
  const saveEvents = emitter<SaveState>();
  const memoryChars = () => {
    let n = 0;
    for (const e of journal.values()) n += e.u.length;
    return n;
  };
  const saveState = (): SaveState => {
    const entries = [...journal.values()];
    const unkept = entries.some((e) => e.key === null && !e.adopted.length);
    const state = entries.length === 0 ? "saved" : unkept && memoryChars() > memoryLimit ? "blocked" : unkept ? "unsaved" : "saving";
    return { state, refused: refusedCount };
  };
  const updateOf = (entry: JournalEntry): string | null => {
    if (entry.u) return entry.u;
    for (const key of entry.key ? [entry.key] : entry.adopted) {
      try {
        const parsed = JSON.parse(storage?.getItem(key) ?? "null") as { u?: unknown } | unknown[] | null;
        if (parsed && !Array.isArray(parsed) && typeof parsed.u === "string") return parsed.u;
      } catch {
        return null;
      }
    }
    return null;
  };
  const sendEntry = (entry: JournalEntry) => {
    const u = updateOf(entry);
    if (!u) return;
    entry.sentAt = performance.now();
    send({ t: "up", doc: entry.doc, workspace: entry.workspace, u, seq: entry.seq, load: viewNonce });
    scheduleResend();
  };
  let resendTimer: ReturnType<typeof setTimeout> | null = null;
  const resendTick = () => {
    resendTimer = null;
    if (!journal.size) return;
    const now = performance.now();
    if (isReady) {
      for (const entry of journal.values()) {
        const wait = Math.min(RESEND_MAX_MS, resendMs * 2 ** Math.min(6, entry.tries));
        if (entry.sentAt && now - entry.sentAt >= wait) {
          entry.tries++;
          sendEntry(entry);
        }
      }
    }
    scheduleResend();
  };
  const scheduleResend = () => {
    if (resendTimer === null && journal.size) resendTimer = setTimeout(resendTick, Math.max(50, Math.min(1000, resendMs / 2)));
  };
  const saveChanged = () => {
    const now = saveState();
    const sig = `${now.state}:${now.refused}`;
    if (sig === lastSaveState) return;
    lastSaveState = sig;
    saveEvents.emit(now);
  };
  const journalEntries = (): { key: string; value: string }[] => {
    const out: { key: string; value: string }[] = [];
    if (!storage) return out;
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && (key.startsWith(JOURNAL_PREFIX) || key.startsWith(OLD_UNACKED_PREFIX))) out.push({ key, value: storage.getItem(key) ?? "" });
      }
    } catch {
      return out;
    }
    return out;
  };
  const removeKey = (key: string) => {
    try {
      storage?.removeItem(key);
    } catch {
      return;
    }
  };
  const ageOf = (value: string): number => {
    try {
      const at = (JSON.parse(value) as { at?: unknown }).at;
      return typeof at === "number" ? Date.now() - at : Infinity;
    } catch {
      return Infinity;
    }
  };
  const cleanJournal = () => {
    for (const { key, value } of journalEntries()) {
      if (key.startsWith(OLD_UNACKED_PREFIX) || adoptedKeys.has(key)) continue;
      const device = key.slice(JOURNAL_PREFIX.length).split("|")[0];
      if (device === me.deviceId) continue;
      if (ageOf(value) > OTHER_DEVICE_MAX_AGE) removeKey(key);
    }
  };
  const writeJournal = (entry: JournalEntry) => {
    if (!storage || !me.deviceId || entry.key) return;
    const key = journalKey(me.deviceId, entry.workspace, entry.doc, viewNonce, entry.seq);
    const value = JSON.stringify({ u: entry.u, at: entry.at });
    const fits = () => journalEntries().reduce((n, e) => n + e.key.length + e.value.length, 0) + key.length + value.length <= JOURNAL_CHARS_MAX;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!fits()) throw new Error("The journal is over its budget.");
        storage.setItem(key, value);
        entry.key = key;
        entry.u = "";
        return;
      } catch (error) {
        if (attempt === 0) cleanJournal();
        else console.error("[notes] an unsent edit couldn't be kept on this Mac; still sending it", error);
      }
    }
  };
  const legacyWaiting = new Map<string, Set<number>>();
  const settleEntry = (seq: number, workspace: string, doc: string, refused: boolean) => {
    const entry = journal.get(seq);
    if (!entry || entry.workspace !== workspace || entry.doc !== doc) return;
    journal.delete(seq);
    if (entry.key) removeKey(entry.key);
    for (const key of entry.adopted) {
      removeKey(key);
      adoptedKeys.delete(key);
    }
    for (const [key, seqs] of legacyWaiting) {
      if (!seqs.delete(seq) || seqs.size) continue;
      legacyWaiting.delete(key);
      removeKey(key);
      adoptedKeys.delete(key);
    }
    if (refused) {
      refusedCount++;
      console.warn(`[notes] an edit to ${doc} wasn't kept: that page or workspace is gone`);
    }
    saveChanged();
  };
  const adoptJournal = () => {
    cleanJournal();
    for (const { key, value } of journalEntries()) {
      if (adoptedKeys.has(key) || [...journal.values()].some((e) => e.key === key)) continue;
      let workspace = "";
      let doc = "";
      let updates: string[] = [];
      try {
        if (key.startsWith(OLD_UNACKED_PREFIX)) {
          const rest = key.slice(OLD_UNACKED_PREFIX.length);
          const cut = rest.indexOf(":");
          workspace = rest.slice(0, cut);
          doc = rest.slice(cut + 1);
          const parsed = JSON.parse(value) as unknown;
          updates = Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
        } else {
          const [device, ws, d, view] = key.slice(JOURNAL_PREFIX.length).split("|");
          if (device !== me.deviceId || view === viewNonce) continue;
          workspace = ws ?? "";
          doc = d ?? "";
          const parsed = JSON.parse(value) as { u?: unknown };
          updates = typeof parsed.u === "string" ? [parsed.u] : [];
        }
      } catch {
        removeKey(key);
        continue;
      }
      if (!workspace || !doc || !updates.length) {
        removeKey(key);
        continue;
      }
      adoptedKeys.add(key);
      const legacy = key.startsWith(OLD_UNACKED_PREFIX);
      const seqs = new Set<number>();
      for (const u of updates) {
        const seq = ++upSeq;
        const entry: JournalEntry = { seq, workspace, doc, u, key: null, adopted: legacy ? [] : [key], at: Date.now(), sentAt: 0, tries: 0 };
        journal.set(seq, entry);
        if (legacy) writeJournal(entry);
        else entry.u = "";
        seqs.add(seq);
        sendEntry(entry);
      }
      if (legacy) {
        if ([...seqs].every((seq) => journal.get(seq)?.key)) {
          removeKey(key);
          adoptedKeys.delete(key);
        } else legacyWaiting.set(key, seqs);
      }
    }
    saveChanged();
  };
  const resendJournal = () => {
    for (const entry of journal.values()) sendEntry(entry);
  };

  const sendAwareness = (shared: Shared) => {
    shared.awTimer = null;
    const update = encodeAwarenessUpdate(shared.awareness, [shared.ydoc.clientID]);
    send({ t: "aw", doc: shared.doc, workspace: shared.workspace, u: toBase64(update) });
  };

  let viewingNow: { workspace: WorkspaceId | ""; page: PageId | "" } | null = null;

  const requests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const handle = (msg: MainToPage) => {
    switch (msg.t) {
      case "ready": {
        me = msg.me;
        workspaces = msg.workspaces;
        meEvents.emit(me);
        workspaceEvents.emit(workspaces);
        for (const entry of journal.values()) writeJournal(entry);
        if (!isReady) {
          isReady = true;
          for (const m of held.splice(0)) enqueue(m);
          adoptJournal();
          resolveReady();
        } else {
          resendJournal();
          if (viewingNow) enqueue({ t: "viewing", ...viewingNow });
          for (const shared of docs.values()) {
            enqueue({ t: "sub", doc: shared.doc, workspace: shared.workspace });
            if (shared.awareness.getLocalState() !== null) sendAwareness(shared);
          }
        }
        return;
      }
      case "me":
        me = msg.me;
        meEvents.emit(me);
        return;
      case "workspaces":
        workspaces = msg.list;
        workspaceEvents.emit(workspaces);
        return;
      case "presence":
        presence = msg.list;
        presenceEvents.emit(presence);
        return;
      case "doc": {
        const shared = docs.get(keyOf(msg.workspace, msg.doc));
        if (!shared) return;
        try {
          Y.applyUpdate(shared.ydoc, fromBase64(msg.state), REMOTE);
        } catch (error) {
          console.error("[notes] state didn't apply", error);
        }
        shared.resolveSynced();
        return;
      }
      case "ack": {
        if (typeof msg.seq !== "number" || msg.load !== viewNonce) return;
        const from = typeof msg.from === "number" && msg.from <= msg.seq && msg.seq - msg.from < 100_000 ? msg.from : msg.seq;
        for (const seq of [...journal.keys()]) if (seq >= from && seq <= msg.seq) settleEntry(seq, msg.workspace, msg.doc, msg.outcome === "refused");
        return;
      }
      case "up": {
        const shared = docs.get(keyOf(msg.workspace, msg.doc));
        if (!shared) return;
        try {
          Y.applyUpdate(shared.ydoc, fromBase64(msg.u), REMOTE);
        } catch (error) {
          console.error("[notes] update didn't apply", error);
        }
        return;
      }
      case "aw": {
        const shared = docs.get(keyOf(msg.workspace, msg.doc));
        if (!shared) return;
        try {
          applyAwarenessUpdate(shared.awareness, fromBase64(msg.u), REMOTE);
        } catch (error) {
          console.error("[notes] awareness didn't apply", error);
        }
        return;
      }
      case "res": {
        const waiter = requests.get(msg.id);
        if (!waiter) return;
        requests.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.ok) waiter.resolve(msg.value);
        else waiter.reject(new Error(msg.error));
        return;
      }
    }
  };

  const reasm = new Reassembler();
  const onMessage = (event: Event & { data?: unknown }) => {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object" || typeof data.t !== "string") return;
    if (data.t === "chunk") {
      const whole = reasm.push(data as unknown as Chunk);
      if (whole && typeof whole === "object") handle(whole as MainToPage);
      return;
    }
    handle(data as unknown as MainToPage);
  };

  if (ardia) {
    ardia.addEventListener("message", onMessage);
    let helloDelay = 500;
    const hello = () => {
      if (isReady) return;
      enqueue({ t: "hello" });
      setTimeout(hello, helloDelay);
      helloDelay = Math.min(5000, helloDelay * 2);
    };
    hello();
    const alive = setInterval(() => {
      if (isReady) enqueue({ t: "alive" });
    }, 15_000);
    win.addEventListener("pagehide", () => {
      clearInterval(alive);
      for (const shared of docs.values()) flushUps(shared);
      while (outbox.length && transmit(outbox[0])) outbox.shift();
      if (!outbox.length) transmit({ t: "bye" });
      if (pumpTimer !== null) clearTimeout(pumpTimer);
      pumpTimer = null;
      if (resendTimer !== null) clearTimeout(resendTimer);
      resendTimer = null;
      for (const shared of docs.values()) {
        if (shared.awTimer !== null) clearTimeout(shared.awTimer);
        if (shared.closeTimer !== null) clearTimeout(shared.closeTimer);
        shared.awareness.destroy();
      }
      for (const waiter of requests.values()) clearTimeout(waiter.timer);
    });
  } else {
    console.warn("[notes] window.ardia isn't here, so Notes can't reach its storage.");
  }

  const currentPath = () => (ardia ? normalizePath(ardia.path ?? "") : normalizePath(win.location.hash || "/"));

  let lastPath = currentPath();
  const pathChanged = (path?: unknown) => {
    const next = typeof path === "string" ? normalizePath(path) : currentPath();
    if (next === lastPath) return;
    lastPath = next;
    pathEvents.emit(next);
  };

  if (ardia) ardia.addEventListener("navigate", () => pathChanged());
  else win.addEventListener("hashchange", () => pathChanged());

  const userOf = (m: Me) => ({ name: m.name || "Someone", color: m.color });
  meEvents.on((m) => {
    for (const shared of docs.values()) if (shared.awareness.getLocalState() !== null) shared.awareness.setLocalStateField("user", userOf(m));
  });

  const open = (workspace: WorkspaceId, doc: DocId): OpenDoc => {
    const key = keyOf(workspace, doc);
    let shared = docs.get(key);
    if (shared) {
      shared.refs++;
      if (shared.closeTimer !== null) {
        clearTimeout(shared.closeTimer);
        shared.closeTimer = null;
      }
    } else {
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      awareness.setLocalState({ user: userOf(me) });
      let resolveSynced!: () => void;
      const synced = new Promise<void>((resolve) => (resolveSynced = resolve));
      const created: Shared = { workspace, doc, ydoc, awareness, refs: 1, synced, resolveSynced, pending: [], upTimer: null, awTimer: null, closeTimer: null };
      shared = created;
      ydoc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) return;
        journalUpdate(created, update);
      });
      awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin !== "local") return;
        const mine = ydoc.clientID;
        if (![...added, ...updated, ...removed].includes(mine)) return;
        if (created.awTimer === null) created.awTimer = setTimeout(() => sendAwareness(created), 50);
      });
      docs.set(key, created);
      send({ t: "sub", doc, workspace });
      created.awTimer = setTimeout(() => sendAwareness(created), 50);
    }
    const s = shared;
    let released = false;
    return {
      doc: s.ydoc,
      awareness: s.awareness,
      synced: s.synced,
      release: () => {
        if (released) return;
        released = true;
        s.refs--;
        if (s.refs > 0) return;
        s.closeTimer = setTimeout(() => {
          s.closeTimer = null;
          if (s.refs > 0) return;
          flushUps(s);
          if (s.awTimer !== null) clearTimeout(s.awTimer);
          if (s.awareness.getLocalState() !== null) {
            s.awareness.setLocalState(null);
            if (s.awTimer !== null) clearTimeout(s.awTimer);
            sendAwareness(s);
          }
          send({ t: "unsub", doc: s.doc, workspace: s.workspace });
          docs.delete(key);
          s.awareness.destroy();
          s.ydoc.destroy();
        }, 250);
      },
    };
  };

  const call = <K extends OpName>(op: K, args: Ops[K]["args"]): Promise<Ops[K]["value"]> => request(op, args) as Promise<Ops[K]["value"]>;


  const request = (op: OpName | ExtraOpName, args: unknown, timeoutMs?: number): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId("r");
      const timer = setTimeout(
        () => {
          if (!requests.delete(id)) return;
          reject(Object.assign(new Error(`Notes didn't answer ${op} in time.`), { timedOut: true }));
        },
        timeoutMs ?? (LONG_OPS.has(op) ? 30 * 60_000 : 120_000),
      );
      requests.set(id, { resolve, reject, timer });
      send({ t: "req", id, op, args });
    });

  const fileUrls = new Map<string, Promise<string>>();

  return {
    ready,
    me: () => me,
    onMe: (listener) => meEvents.on(listener),
    workspaces: () => workspaces,
    onWorkspaces: (listener) => workspaceEvents.on(listener),
    presence: () => presence,
    onPresence: (listener) => presenceEvents.on(listener),
    open,
    call,
    saveState,
    onSaveState: (listener) => saveEvents.on(listener),
    async upload(workspace, file, name) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const data = toBase64(bytes);
      const uploadId = nextId("u");
      const count = Math.max(1, Math.ceil(data.length / UPLOAD_PART_MAX));
      let next = 0;
      const sendPart = async (i: number) => {
        const args: ExtraOps["uploadPart"]["args"] = { uploadId, i, data: data.slice(i * UPLOAD_PART_MAX, (i + 1) * UPLOAD_PART_MAX) };
        for (let attempt = 1; ; attempt++) {
          try {
            await request("uploadPart", args, PART_TIMEOUT_MS);
            return;
          } catch (error) {
            if (!(error as { timedOut?: boolean }).timedOut || attempt >= PART_TRIES) throw error;
          }
        }
      };
      const worker = async () => {
        while (next < count) await sendPart(next++);
      };
      await Promise.all(Array.from({ length: Math.min(PARTS_IN_FLIGHT, count) }, worker));
      const { ref } = await call("upload", { workspace, name, type: file.type || "application/octet-stream", uploadId });
      return ref;
    },
    fileUrl(workspace, ref) {
      const key = `${workspace}\u0000${ref}`;
      let url = fileUrls.get(key);
      if (!url) {
        url = call("file", { workspace, ref }).then(({ type, data }) => URL.createObjectURL(new Blob([fromBase64(data) as BlobPart], { type })));
        url.catch(() => fileUrls.delete(key));
        fileUrls.set(key, url);
      }
      return url;
    },
    path: () => lastPath,
    onPath: (listener) => pathEvents.on(listener),
    navigate(path, navigateOptions) {
      const next = normalizePath(path);
      if (ardia) {
        ardia.navigate(next, navigateOptions);
        pathChanged(next);
        return;
      }
      if (navigateOptions?.replace) win.history.replaceState(null, "", `#${next}`);
      else win.history.pushState(null, "", `#${next}`);
      pathChanged(next);
    },
    setTitle(title) {
      win.document.title = title;
    },
    canExportFiles: true,
    viewing(workspace, page) {
      const next = { workspace: workspace && page ? workspace : "", page: workspace && page ? page : "" };
      if (viewingNow && viewingNow.workspace === next.workspace && viewingNow.page === next.page) return;
      viewingNow = next;
      send({ t: "viewing", ...next });
    },
  };
}
