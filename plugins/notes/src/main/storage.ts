import * as Y from "yjs";
import { bytesEqual, crc32 } from "../shared/bytes";
import { blobMatches, readBlob, removeUnreferencedChunks, sha256Hex, writeBlob, type BlobPointer } from "./blob";
import { errorCode, type Disposable, type FileEntry, type FileStore, type ReadResult } from "./files";

export const DISK_ORIGIN = { disk: true } as const;

export const LOG_COMPACT_AT = 256 * 1024;
const MAX_RECORD = 64 * 1024 * 1024;
const HEAD = 32;
const PRESENCE_EVERY = 10_000;
const LOG_CHUNK = 1024 * 1024;
const PRESENCE_MAX = 4096;
export const DOC_BYTES_MAX = 64 * 1024 * 1024;
export const WORKSPACE_BYTES_MAX = 384 * 1024 * 1024;
export const DEVICES_MAX = 64;
export const FILE_BYTES_MAX = 128 * 1024 * 1024;
const MAX_WAITERS = 10_000;
const MAX_PENDING_UPDATES = 2_000;
export const PENDING_BYTES_MAX = 16 * 1024 * 1024;
const PRESENCE_FRESH = 45_000;

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};

export const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
  now: () => Date.now(),
};

export type StoreState = "loading" | "ready" | "missing" | "downloading";

export type PresenceFile = { device: string; name: string; color: string; page: string | null; at: number };

export type StoreOptions = {
  fs: FileStore;
  deviceId: string;
  debounceMs?: number;
  compactAt?: number;
  rescanMs?: number;
  loadConcurrency?: number;
  timers?: Timers;
  onDocAdded?: (name: string) => void;
  onDocLoaded?: (name: string, doc: Y.Doc) => void;
  onState?: () => void;
  onPresence?: (list: PresenceFile[]) => void;
  onCursorFile?: (device: string, mtimeMs: number | null) => void;
  onError?: (error: unknown, where: string) => void;
  maxDocBytes?: number;
  maxWorkspaceBytes?: number;
  maxDevices?: number;
  maxPendingBytes?: number;
};

type Mark = { mtimeMs: number; size: number };
type LogReader = { offset: number; head: Uint8Array | null; legacy: boolean | null; mtimeMs?: number };

class DocEntry {
  readonly doc = new Y.Doc({ gc: true });
  loading: Promise<void> | null = null;
  loaded = false;
  readonly snaps = new Map<string, Mark>();
  readonly logs = new Map<string, LogReader>();
  pending: Uint8Array[] = [];
  timer: unknown = null;
  queue: Promise<void> = Promise.resolve();
  ownLogSize = 0;
  ownSnap: BlobPointer | null = null;
  readonly sizes = new Map<string, { snap: number; log: number }>();
  localSeq = 0;
  verbatim = false;
  durableSeq = 0;
  waiters: { seq: number; resolve: (ok: boolean) => void }[] = [];
  resident = 0;
  needsCompaction = false;
  failures = 0;
  dirty = new Set<string>();
  constructor(readonly name: string) {}
}

const FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.(snap|log)$/;
const DOC_NAME = /^(ws|p-[0-9a-f]{12}|[A-Za-z0-9_-]{1,80})$/;

const RECORD_MAGIC = new Uint8Array([0xa5, 0x4e, 0x4c, 0x52]);
export const LOG_HEADER = new Uint8Array([0xa5, 0x4e, 0x4c, 0x48, 0x44, 0x52, 0x00, 0x02]);

export type LogFormat = "framed" | "legacy" | "wait";

export function logFormat(data: Uint8Array): { format: LogFormat; skip: number } {
  if (data.length === 0) return { format: "wait", skip: 0 };
  const n = Math.min(data.length, LOG_HEADER.length);
  if (bytesEqual(data.subarray(0, n), LOG_HEADER.subarray(0, n))) return n < LOG_HEADER.length ? { format: "wait", skip: 0 } : { format: "framed", skip: LOG_HEADER.length };
  if (data[0] === 0xa5) return { format: "framed", skip: 0 };
  return { format: "legacy", skip: 0 };
}
const RECORD_HEADER = 12;

export function encodeRecord(update: Uint8Array): Uint8Array {
  const out = new Uint8Array(RECORD_HEADER + update.length);
  out.set(RECORD_MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, update.length);
  view.setUint32(8, crc32(update));
  out.set(update, RECORD_HEADER);
  return out;
}

const magicAt = (data: Uint8Array, pos: number) => data[pos] === 0xa5 && data[pos + 1] === 0x4e && data[pos + 2] === 0x4c && data[pos + 3] === 0x52;


export function decodeRecords(data: Uint8Array): { records: Uint8Array[]; consumed: number; damaged: number } {
  const records: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  let damaged = 0;
  const skip = () => {
    damaged++;
    let next = pos + 1;
    while (next + 4 <= data.length && !magicAt(data, next)) next++;
    pos = next;
  };
  while (pos + 4 <= data.length) {
    if (!magicAt(data, pos)) {
      skip();
      continue;
    }
    if (pos + RECORD_HEADER > data.length) break;
    const n = view.getUint32(pos + 4);
    if (n === 0 || n > MAX_RECORD) {
      skip();
      continue;
    }
    if (pos + RECORD_HEADER + n > data.length) break;
    const body = data.subarray(pos + RECORD_HEADER, pos + RECORD_HEADER + n);
    if (crc32(body) !== view.getUint32(pos + 8)) {
      skip();
      continue;
    }
    records.push(body);
    pos += RECORD_HEADER + n;
  }
  if (pos + 4 > data.length && pos < data.length && damaged && !magicAt(data, pos)) pos = Math.max(pos, data.length - 3);
  return { records, consumed: pos, damaged };
}

export function decodeLegacyRecords(data: Uint8Array): { records: Uint8Array[]; consumed: number; damaged: number } {
  const records: Uint8Array[] = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const n = ((data[pos]! << 24) >>> 0) + (data[pos + 1]! << 16) + (data[pos + 2]! << 8) + data[pos + 3]!;
    if (n === 0 || n > MAX_RECORD) return { records, consumed: data.length, damaged: 1 };
    if (pos + 4 + n > data.length) break;
    records.push(data.subarray(pos + 4, pos + 4 + n));
    pos += 4 + n;
  }
  return { records, consumed: pos, damaged: 0 };
}

export function fullState(doc: Y.Doc): Uint8Array {
  const state = Y.encodeStateAsUpdate(doc);
  const parts = [state];
  const pendingStructs = doc.store.pendingStructs;
  if (pendingStructs) parts.push(Y.convertUpdateFormatV2ToV1(pendingStructs.update));
  if (doc.store.pendingDs) parts.push(Y.convertUpdateFormatV2ToV1(doc.store.pendingDs));
  return parts.length === 1 ? state : Y.mergeUpdates(parts);
}

export function applyUpdates(doc: Y.Doc, updates: Uint8Array[], origin: unknown): number {
  if (updates.length === 0) return 0;
  try {
    Y.applyUpdate(doc, updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates), origin);
    return 0;
  } catch {
    let failed = 0;
    for (const u of updates) {
      try {
        Y.applyUpdate(doc, u, origin);
      } catch {
        failed++;
      }
    }
    return failed;
  }
}

export class WorkspaceStore {
  readonly fs: FileStore;
  readonly deviceId: string;
  private readonly debounceMs: number;
  private readonly compactAt: number;
  private readonly rescanMs: number;
  private readonly concurrency: number;
  private readonly timers: Timers;
  private readonly entries = new Map<string, DocEntry>();
  private readonly known = new Set<string>();
  private watcher: Disposable | null = null;
  private rescanTimer: unknown = null;
  private rescanSoonTimer: unknown = null;
  private rescanning: Promise<void> | null = null;
  private rescanAgain = false;
  private pendingPaths = new Map<string, Set<string>>();
  private pathTimer: unknown = null;
  private placeholders = new Map<string, number>();
  private presenceFiles = new Map<string, PresenceFile>();
  private presenceMine: { name: string; color: string; page: string | null } | null = null;
  private presenceTimer: unknown = null;
  private presenceWrite: Promise<void> = Promise.resolve();
  private fileNames = new Map<string, string>();
  private savingFiles = new Map<string, Promise<void>>();
  private filesListed = false;
  private backgroundLoad: Promise<void> | null = null;
  private closed = false;
  private stateValue: StoreState = "loading";
  private failures = 0;
  private readonly maxDocBytes: number;
  private readonly maxWorkspaceBytes: number;
  private readonly maxDevices: number;
  private readonly maxPendingBytes: number;
  private resident = 0;
  private readonly listedCharges = new Map<string, { sizes: Map<string, { snap: number; log: number }>; total: number }>();
  private readonly rejectedDocs = new Map<string, string>();

  constructor(private readonly options: StoreOptions) {
    this.fs = options.fs;
    this.deviceId = options.deviceId;
    this.debounceMs = options.debounceMs ?? 300;
    this.compactAt = options.compactAt ?? LOG_COMPACT_AT;
    this.rescanMs = options.rescanMs ?? 30_000;
    this.concurrency = options.loadConcurrency ?? 4;
    this.timers = options.timers ?? defaultTimers;
    this.maxDocBytes = options.maxDocBytes ?? DOC_BYTES_MAX;
    this.maxWorkspaceBytes = options.maxWorkspaceBytes ?? WORKSPACE_BYTES_MAX;
    this.maxDevices = options.maxDevices ?? DEVICES_MAX;
    this.maxPendingBytes = options.maxPendingBytes ?? PENDING_BYTES_MAX;
  }

  get state(): StoreState {
    if (this.stateValue === "ready" && this.placeholders.size > 0) return "downloading";
    return this.stateValue;
  }

  get waiting(): number {
    return this.placeholders.size;
  }

  hasPending(): boolean {
    return [...this.entries.values()].some((e) => e.pending.length > 0 || e.needsCompaction);
  }

  rejected(): string[] {
    return [...this.rejectedDocs.keys()];
  }

  private reject(name: string, why: string) {
    if (this.rejectedDocs.has(name)) return;
    this.rejectedDocs.set(name, why);
    this.report(new Error(`${name} was set aside: ${why}`), "limit");
    this.options.onState?.();
  }

  private yieldNow(): Promise<void> {
    return new Promise((resolve) => this.timers.setTimeout(resolve, 0));
  }

  private allowDevice(entry: DocEntry, device: string): boolean {
    if (device === this.deviceId || entry.snaps.has(device) || entry.logs.has(device)) return true;
    const others = new Set([...entry.snaps.keys(), ...entry.logs.keys()].filter((d) => d !== this.deviceId));
    return others.size < this.maxDevices;
  }

  private keptDevices<T>(devices: Map<string, T>): [string, T][] {
    const all = [...devices.entries()].sort(([a], [b]) => (a === this.deviceId ? -1 : b === this.deviceId ? 1 : a < b ? -1 : 1));
    if (all.length > this.maxDevices + 1) this.report(new Error(`Only ${this.maxDevices} devices' files are read for one document.`), "limit");
    return all.slice(0, this.maxDevices + 1);
  }

  docNames(): string[] {
    return [...this.known];
  }

  loadedDocs(): [string, Y.Doc][] {
    return [...this.entries.values()].filter((e) => e.loaded).map((e) => [e.name, e.doc]);
  }

  peek(name: string): Y.Doc | null {
    const entry = this.entries.get(name);
    return entry?.loaded ? entry.doc : null;
  }

  isLoaded(name: string): boolean {
    return this.entries.get(name)?.loaded === true;
  }

  async open(): Promise<void> {
    let listing: FileEntry[] = [];
    try {
      listing = await this.fs.list("docs", { recursive: true });
      this.stateValue = "loading";
    } catch (error) {
      this.report(error, "open");
      this.setState("missing");
    }
    const grouped = this.group(listing);
    for (const name of grouped.keys()) this.known.add(name);
    this.known.add("ws");
    await this.load(this.entry("ws"), grouped.get("ws") ?? null);
    if (this.stateValue !== "missing") this.setState("ready");
    this.watcher = this.fs.watch((paths) => this.onWatch(paths));
    this.scheduleRescan();
    void this.readAllPresence();
  }

  loadAll(skip: (name: string) => boolean = () => false): Promise<void> {
    if (this.backgroundLoad) return this.backgroundLoad;
    const run = async () => {
      const names = [...this.known].filter((n) => !this.isLoaded(n) && !skip(n));
      let next = 0;
      const worker = async () => {
        while (next < names.length && !this.closed) {
          const name = names[next++]!;
          try {
            await this.get(name);
          } catch (error) {
            this.report(error, "loadAll");
          }
          await this.yieldNow();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker));
    };
    this.backgroundLoad = run().finally(() => (this.backgroundLoad = null));
    return this.backgroundLoad;
  }

  async get(name: string): Promise<Y.Doc> {
    if (!DOC_NAME.test(name)) throw new Error(`There's no document ${name}.`);
    const entry = this.entry(name);
    if (!entry.loaded) await this.load(entry, null);
    return entry.doc;
  }

  create(name: string): Y.Doc {
    const entry = this.entry(name);
    if (!entry.loaded && !entry.loading) {
      entry.loaded = true;
      entry.loading = Promise.resolve();
      this.known.add(name);
    }
    return entry.doc;
  }

  async flushDurable(names: string[], timeoutMs = 30_000): Promise<boolean> {
    const waits = names.map((name) => this.whenDurable(name, this.seqOf(name)));
    await Promise.all(names.map((name) => this.flush(name)));
    let timer: unknown = null;
    const deadline = new Promise<boolean>((resolve) => (timer = this.timers.setTimeout(() => resolve(false), timeoutMs)));
    try {
      return await Promise.race([Promise.all(waits).then((oks) => oks.every(Boolean)), deadline]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  async flush(name?: string): Promise<void> {
    const targets = name ? [this.entries.get(name)].filter((e): e is DocEntry => !!e) : [...this.entries.values()];
    await Promise.all(targets.map((e) => this.flushEntry(e)));
  }

  async whenIdle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await this.flush();
      if (this.rescanning) await this.rescanning;
      await Promise.all([...this.entries.values()].map((e) => e.queue));
      await this.presenceWrite;
      if ([...this.entries.values()].every((e) => e.pending.length === 0) && !this.rescanning && this.pendingPaths.size === 0) return;
      if (this.pendingPaths.size) await this.drainPaths();
    }
  }

  async close(options: { flush?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.dispose();
    this.watcher = null;
    for (const t of [this.rescanTimer, this.rescanSoonTimer, this.pathTimer, this.presenceTimer]) if (t !== null) this.timers.clearTimeout(t);
    for (const e of this.entries.values()) if (e.timer !== null) this.timers.clearTimeout(e.timer);
    const all = [...this.entries.values()];
    if (options.flush !== false) await Promise.all(all.map((e) => this.flushNow(e)));
    for (const e of all) {
      for (const w of e.waiters.splice(0)) w.resolve(false);
    }
    if (this.presenceMine?.page) {
      this.presenceMine = { ...this.presenceMine, page: null };
      await this.writePresence().catch(() => undefined);
    }
    for (const e of all) e.doc.destroy();
  }

  async rescan(): Promise<void> {
    if (this.closed) return;
    if (this.rescanning) {
      this.rescanAgain = true;
      return this.rescanning;
    }
    this.rescanning = (async () => {
      do {
        this.rescanAgain = false;
        await this.rescanOnce();
      } while (this.rescanAgain && !this.closed);
    })().finally(() => (this.rescanning = null));
    return this.rescanning;
  }

  setPresence(mine: { name: string; color: string; page: string | null } | null) {
    const before = this.presenceMine;
    this.presenceMine = mine;
    if (!mine) {
      if (before?.page) {
        this.presenceMine = { ...before, page: null };
        void this.writePresence().finally(() => (this.presenceMine = null));
      }
      if (this.presenceTimer !== null) this.timers.clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
      return;
    }
    if (!before || before.page !== mine.page || before.name !== mine.name || before.color !== mine.color) void this.writePresence();
    if (this.presenceTimer === null && mine.page) this.tickPresence();
  }

  presence(): PresenceFile[] {
    const now = this.timers.now();
    return [...this.presenceFiles.values()].filter((p) => p.device !== this.deviceId && p.page && now - p.at < PRESENCE_FRESH);
  }

  async putFile(data: Uint8Array, ext: string): Promise<string> {
    const staged = this.stageFile(data, ext);
    await staged.saved;
    return staged.sha;
  }

  stageFile(data: Uint8Array, ext: string): { sha: string; saved: Promise<void> } {
    const sha = sha256Hex(data);
    const running = this.savingFiles.get(sha);
    if (running) return { sha, saved: running };
    const saved = this.saveFile(sha, data, ext).finally(() => {
      if (this.savingFiles.get(sha) === saved) this.savingFiles.delete(sha);
    });
    this.savingFiles.set(sha, saved);
    return { sha, saved };
  }

  private async saveFile(sha: string, data: Uint8Array, ext: string): Promise<void> {
    const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "bin";
    const existing = await this.fileName(sha);
    if (existing && (await this.hasFile(sha, data.length))) return;
    const name = existing ?? `${sha}.${clean}`;
    let saved = false;
    try {
      const wrote = await writeBlob(this.fs, `files/${name}`, data, { chunkDir: "files/.chunks", exclusive: !existing });
      saved = (wrote.pointer ? wrote.pointer.size : wrote.size) === data.length;
    } catch (error) {
      if (errorCode(error) !== "exists") throw error;
    }
    if (!saved && !(await blobMatches(this.fs, `files/${name}`, sha, data.length))) throw new Error("The file didn't save correctly.");
    this.fileNames.set(sha, name);
  }

  async hasFile(sha: string, size: number): Promise<boolean> {
    const name = await this.fileName(sha);
    return !!name && (await blobMatches(this.fs, `files/${name}`, sha, size).catch(() => false));
  }

  async getFile(sha: string): Promise<{ name: string; data: Uint8Array } | null> {
    const clean = sha.replace(/\.[a-z0-9]+$/i, "");
    if (!/^[0-9a-f]{64}$/.test(clean)) return null;
    let name = await this.fileName(clean);
    if (!name) {
      this.filesListed = false;
      name = await this.fileName(clean);
    }
    if (!name) return null;
    const res = await readBlob(this.fs, `files/${name}`, { maxBytes: FILE_BYTES_MAX }).catch(() => null);
    if (!res || !res.found || "tooLarge" in res) return null;
    if (sha256Hex(res.data) !== clean) return null;
    return { name, data: res.data };
  }

  private async fileName(sha: string): Promise<string | null> {
    const known = this.fileNames.get(sha);
    if (known) return known;
    if (!this.filesListed) {
      this.filesListed = true;
      try {
        for (const e of await this.fs.list("files")) {
          const base = e.path.slice(e.path.lastIndexOf("/") + 1);
          const m = /^([0-9a-f]{64})\.[a-z0-9]+$/.exec(base);
          if (m && !e.placeholder) this.fileNames.set(m[1]!, base);
          else if (m && e.placeholder) void this.fs.read(`files/${base}`, { length: 1 }).catch(() => undefined);
        }
      } catch (error) {
        this.report(error, "files");
      }
    }
    return this.fileNames.get(sha) ?? null;
  }

  private entry(name: string): DocEntry {
    let entry = this.entries.get(name);
    if (entry) return entry;
    entry = new DocEntry(name);
    const listed = this.listedCharges.get(name);
    if (listed) {
      for (const [device, v] of listed.sizes) entry.sizes.set(device, { ...v });
      entry.resident = listed.total;
    }
    const e = entry;
    entry.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === DISK_ORIGIN || this.closed || e.verbatim) return;
      e.pending.push(update);
      e.localSeq++;
      this.schedule(e);
    });
    this.entries.set(name, entry);
    this.known.add(name);
    return entry;
  }

  private load(entry: DocEntry, listing: FileEntry[] | null): Promise<void> {
    if (entry.loading) return entry.loading;
    entry.loading = this.serial(entry, async () => {
      let files = listing;
      if (!files) {
        try {
          files = await this.fs.list(`docs/${entry.name}`);
        } catch (error) {
          this.report(error, "load");
          files = [];
        }
      }
      const devices = new Map<string, { snap?: FileEntry; log?: FileEntry }>();
      for (const f of files) {
        const m = FILE_NAME.exec(f.path.slice(f.path.lastIndexOf("/") + 1));
        if (!m) continue;
        if (f.placeholder) {
          this.notePlaceholder(`docs/${entry.name}/${m[0]}`);
          continue;
        }
        const slot = devices.get(m[1]!) ?? {};
        if (m[2] === "snap") slot.snap = f;
        else slot.log = f;
        devices.set(m[1]!, slot);
      }
      for (const [device, slot] of this.keptDevices(devices)) {
        if (device !== this.deviceId && this.rejectedDocs.has(entry.name)) continue;
        if (device !== this.deviceId && ((slot.snap && slot.snap.size > Math.min(this.fs.maxWrite, this.maxDocBytes)) || (slot.log && slot.log.size > this.maxDocBytes))) {
          this.reject(entry.name, `files from ${device} are over the size limit`);
          continue;
        }
        try {
          if (slot.snap) await this.readSnap(entry, device, false);
          if (slot.log) await this.readLog(entry, device);
        } catch (error) {
          this.report(error, `load ${entry.name} ${device}`);
        }
      }
      entry.loaded = true;
    }).then(() => {
      this.options.onDocLoaded?.(entry.name, entry.doc);
      if (entry.needsCompaction || entry.pending.length) this.schedule(entry, 0);
    });
    return entry.loading;
  }

  private serial(entry: DocEntry, task: () => Promise<void>): Promise<void> {
    const run = entry.queue.then(task, task);
    entry.queue = run.catch((error) => this.report(error, entry.name));
    return run;
  }

  private snapPath(name: string, device: string) {
    return `docs/${name}/${device}.snap`;
  }

  private logPath(name: string, device: string) {
    return `docs/${name}/${device}.log`;
  }

  private async readOrWait(path: string, range?: { offset?: number; length?: number }): Promise<ReadResult | null> {
    try {
      return await this.fs.read(path, range);
    } catch (error) {
      if (errorCode(error) === "unavailable") {
        this.notePlaceholder(path);
        return null;
      }
      throw error;
    }
  }

  private async readSnap(entry: DocEntry, device: string, thenLog: boolean): Promise<void> {
    const path = this.snapPath(entry.name, device);
    let res;
    try {
      res = await readBlob(this.fs, path, { maxBytes: device === this.deviceId ? Number.MAX_SAFE_INTEGER : this.maxDocBytes });
    } catch (error) {
      if (errorCode(error) === "unavailable") return this.notePlaceholder(path);
      if (errorCode(error) === "damaged") {
        this.report(error, "snap");
        if (device === this.deviceId) entry.needsCompaction = true;
        return;
      }
      throw error;
    }
    if (!res.found) {
      entry.snaps.delete(device);
      this.admit(entry, device, 0, entry.sizes.get(device)?.log ?? 0);
      return;
    }
    const mark = entry.snaps.get(device);
    if (mark && mark.mtimeMs === res.mtimeMs && mark.size === res.size) return;
    this.placeholders.delete(path);
    if ("tooLarge" in res) return this.reject(entry.name, `a snapshot from ${device} is ${res.size} bytes`);
    if (!this.admit(entry, device, res.size, 0)) return;
    if (res.data.length > 0) {
      const failed = applyUpdates(entry.doc, [res.data], DISK_ORIGIN);
      if (failed) {
        this.report(new Error(`A snapshot of ${entry.name} from ${device} didn't read; it will be read again when it changes.`), "snap");
        if (device === this.deviceId) entry.needsCompaction = true;
        return;
      }
    }
    if (device === this.deviceId) entry.ownSnap = res.pointer;
    entry.snaps.set(device, { mtimeMs: res.mtimeMs, size: res.size });
    const reader = entry.logs.get(device);
    if (reader) {
      reader.offset = 0;
      reader.head = null;
      reader.legacy = null;
    }
    if (thenLog) await this.readLog(entry, device);
  }

  private recharge(grouped: Map<string, FileEntry[]>, listing: FileEntry[]) {
    let total = 0;
    const totals = new Map<string, number>();
    const chunks = new Map<string, number>();
    for (const e of listing) {
      const m = /(?:^|\/)docs\/([^/]+)\/\.chunks-([A-Za-z0-9_-]{1,64})\/[0-9a-f]{64}$/.exec(e.path);
      if (m && e.kind === "file" && m[2] !== this.deviceId) chunks.set(`${m[1]}\u0000${m[2]}`, (chunks.get(`${m[1]}\u0000${m[2]}`) ?? 0) + e.size);
    }
    for (const [name, files] of grouped) {
      const sizes = new Map<string, { snap: number; log: number }>();
      for (const f of files) {
        const m = FILE_NAME.exec(f.path.slice(f.path.lastIndexOf("/") + 1));
        if (!m || m[1] === this.deviceId || f.placeholder) continue;
        const slot = sizes.get(m[1]!) ?? { snap: 0, log: 0 };
        if (m[2] === "snap") slot.snap = f.size + (chunks.get(`${name}\u0000${m[1]}`) ?? 0);
        else slot.log = f.size;
        sizes.set(m[1]!, slot);
      }
      let docTotal = 0;
      for (const v of sizes.values()) docTotal += v.snap + v.log;
      totals.set(name, docTotal);
      total += docTotal;
      const entry = this.entries.get(name);
      this.listedCharges.set(name, { sizes, total: docTotal });
      if (entry) {
        const own = entry.sizes.get(this.deviceId);
        entry.sizes.clear();
        if (own) entry.sizes.set(this.deviceId, own);
        for (const [device, v] of sizes) entry.sizes.set(device, v);
        entry.resident = docTotal;
      }
    }
    for (const entry of this.entries.values()) if (!grouped.has(entry.name)) entry.resident = 0;
    this.resident = total;
    let kept = 0;
    for (const [name, docTotal] of [...totals].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))) {
      if (docTotal > this.maxDocBytes) this.reject(name, `its files from other devices add up to ${docTotal} bytes`);
      else if (kept + docTotal > this.maxWorkspaceBytes) this.reject(name, "the workspace is over its size limit");
      else {
        kept += docTotal;
        this.rejectedDocs.delete(name);
      }
    }
    this.resident = kept;
  }

  private admit(entry: DocEntry, device: string, snap: number | null, log: number): boolean {
    const old = entry.sizes.get(device) ?? { snap: 0, log: 0 };
    const next = { snap: snap ?? old.snap, log };
    if (device === this.deviceId) {
      entry.sizes.set(device, next);
      return true;
    }
    const delta = next.snap + next.log - old.snap - old.log;
    const docTotal = entry.resident + delta;
    if (delta > 0 && docTotal > this.maxDocBytes) {
      this.reject(entry.name, `its files from other devices add up to ${docTotal} bytes`);
      return false;
    }
    if (delta > 0 && this.resident + delta > this.maxWorkspaceBytes) {
      this.reject(entry.name, "the workspace is over its size limit");
      return false;
    }
    entry.sizes.set(device, next);
    entry.resident = docTotal;
    this.resident += delta;
    return true;
  }

  private async readLog(entry: DocEntry, device: string): Promise<void> {
    const path = this.logPath(entry.name, device);
    let reader = entry.logs.get(device);
    if (!reader) {
      reader = { offset: 0, head: null, legacy: null };
      entry.logs.set(device, reader);
    }
    if (reader.offset > 0 && reader.head) {
      const head = await this.readOrWait(path, { offset: 0, length: HEAD });
      if (!head) return;
      if (!head.found) {
        reader.offset = 0;
        reader.head = null;
        reader.legacy = null;
        if (device === this.deviceId) entry.ownLogSize = 0;
        return;
      }
      const same = head.size >= reader.offset && bytesEqual(head.data.subarray(0, reader.head.length), reader.head);
      if (!same) {
        reader.offset = 0;
        reader.head = null;
        reader.legacy = null;
      }
    }
    const limit = device === this.deviceId ? Number.MAX_SAFE_INTEGER : this.maxDocBytes;
    const chunk = Math.min(LOG_CHUNK, limit);
    let want = chunk;
    let total = chunk;
    for (let rounds = 0; rounds < 4 + Math.ceil(total / chunk); rounds++) {
      let res = await this.readOrWait(path, { offset: reader.offset, length: want });
      if (!res) return;
      if (!res.found) {
        reader.offset = 0;
        reader.head = null;
        reader.legacy = null;
        this.admit(entry, device, null, 0);
        return;
      }
      total = Math.min(limit, res.size);
      if (res.size > this.maxDocBytes && device !== this.deviceId) return this.reject(entry.name, `a log from ${device} is ${res.size} bytes`);
      if (res.size < reader.offset) {
        reader.offset = 0;
        reader.head = null;
        reader.legacy = null;
        res = await this.readOrWait(path, { offset: 0, length: want });
        if (!res || !res.found) return;
      }
      this.placeholders.delete(path);
      let start = reader.offset;
      let body = res.data;
      if (start === 0) {
        const { format, skip } = logFormat(res.data);
        if (format === "wait") {
          if (device === this.deviceId && res.size > 0) entry.needsCompaction = true;
          return;
        }
        reader.head = res.data.slice(0, Math.min(HEAD, res.data.length));
        reader.legacy = format === "legacy";
        body = res.data.subarray(skip);
        start = skip;
        reader.offset = skip;
        if (!this.admit(entry, device, null, res.size)) return;
      }
      const { records, consumed, damaged } = reader.legacy ? decodeLegacyRecords(body) : decodeRecords(body);
      if (!this.admit(entry, device, null, res.size)) return;
      const failed = applyUpdates(entry.doc, records, DISK_ORIGIN);
      reader.offset = start + consumed;
      reader.mtimeMs = res.mtimeMs;
      const atEnd = reader.offset >= res.size;
      if (device === this.deviceId) {
        entry.ownLogSize = res.size;
        if (reader.legacy || damaged || failed || (atEnd && consumed < body.length) || (!atEnd && consumed === 0)) entry.needsCompaction = true;
      }
      if (damaged || failed) this.report(new Error(`The log of ${entry.name} from ${device} has ${damaged ? `${damaged} damaged records` : `${failed} updates that didn't apply`}.`), "log");
      if (atEnd) return;
      if (consumed === 0) {
        const need = !reader.legacy && body.length >= RECORD_HEADER && magicAt(body, 0) ? RECORD_HEADER + new DataView(body.buffer, body.byteOffset).getUint32(4) : 0;
        if (need <= want || need > limit) return;
        want = need;
        continue;
      }
      want = chunk;
      await this.yieldNow();
    }
  }

  private schedule(entry: DocEntry, ms = this.debounceMs) {
    if (this.closed) return;
    if (entry.timer !== null) return;
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      void this.flushEntry(entry);
    }, ms);
  }

  private flushEntry(entry: DocEntry): Promise<void> {
    if (entry.timer !== null) {
      this.timers.clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.pending.length === 0 && !entry.needsCompaction) return entry.queue;
    return this.serial(entry, () => this.write(entry));
  }

  private flushNow(entry: DocEntry): Promise<void> {
    if (entry.pending.length === 0 && !entry.needsCompaction) return entry.queue;
    return this.serial(entry, () => this.write(entry));
  }

  private retryLater(entry: DocEntry) {
    entry.failures++;
    if (this.closed || entry.timer !== null) return;
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      void this.flushEntry(entry);
    }, Math.min(30_000, 250 * 2 ** Math.min(7, entry.failures)));
  }

  private async write(entry: DocEntry): Promise<void> {
    if (!entry.loaded) return;
    if (entry.needsCompaction) return this.compact(entry);
    const batch = entry.pending;
    if (batch.length === 0) return;
    const upto = entry.localSeq;
    entry.pending = [];
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    const record = encodeRecord(merged);
    if (record.length > this.fs.maxWrite) {
      entry.needsCompaction = true;
      return this.compact(entry);
    }
    const path = this.logPath(entry.name, this.deviceId);
    if (entry.ownLogSize < LOG_HEADER.length) {
      try {
        const existing = await this.fs.stat(path);
        if (existing.found && existing.size > 0) entry.ownLogSize = existing.size;
        else {
          try {
            const made = await this.fs.write(path, LOG_HEADER, { exclusive: true });
            entry.ownLogSize = made.size;
            entry.logs.set(this.deviceId, { offset: LOG_HEADER.length, head: LOG_HEADER.slice(), legacy: false, mtimeMs: made.mtimeMs });
          } catch (error) {
            if (errorCode(error) !== "exists") throw error;
            const raced = await this.fs.stat(path);
            entry.ownLogSize = raced.found ? raced.size : 0;
            if (entry.ownLogSize === 0) throw error;
          }
        }
      } catch (error) {
        this.report(error, "log header");
        entry.pending.unshift(merged);
        this.retryLater(entry);
        return;
      }
    }
    const before = entry.ownLogSize;
    try {
      const res = await this.fs.append(path, record);
      entry.ownLogSize = res.size;
      entry.failures = 0;
      this.settle(entry, upto, true);
      if (this.stateValue === "missing") this.setState("ready");
    } catch (error) {
      this.report(error, "append");
      let size: number | null = null;
      try {
        const back = await this.fs.stat(path);
        size = back.found ? back.size : 0;
      } catch {
        size = null;
      }
      if (size === before) entry.pending.unshift(merged);
      else entry.needsCompaction = true;
      this.retryLater(entry);
      return;
    }
    if (entry.ownLogSize >= this.compactAt) await this.compact(entry);
  }

  private settle(entry: DocEntry, upto: number, ok: boolean) {
    if (ok) entry.durableSeq = Math.max(entry.durableSeq, upto);
    const keep: typeof entry.waiters = [];
    for (const w of entry.waiters) {
      if (w.seq <= upto) w.resolve(ok);
      else keep.push(w);
    }
    entry.waiters = keep;
  }

  pendingBytes(name: string): number {
    const doc = this.entries.get(name)?.doc;
    return (doc?.store.pendingStructs?.update.length ?? 0) + (doc?.store.pendingDs?.length ?? 0);
  }

  applyFromPage(name: string, update: Uint8Array, origin: unknown): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry?.loaded || this.closed) return Promise.resolve(false);
    if (this.pendingBytes(name) > this.maxPendingBytes) {
      this.report(new Error(`${name} holds ${this.pendingBytes(name)} bytes of edits waiting for others that never arrived; new ones wait on the page.`), "pending");
      return Promise.resolve(false);
    }
    if (entry.waiters.length >= MAX_WAITERS || entry.pending.length >= MAX_PENDING_UPDATES) {
      entry.pending = [Y.mergeUpdates(entry.pending)];
      if (entry.waiters.length >= MAX_WAITERS) return Promise.resolve(false);
    }
    entry.verbatim = true;
    try {
      Y.applyUpdate(entry.doc, update, origin);
    } finally {
      entry.verbatim = false;
    }
    entry.pending.push(update);
    entry.localSeq++;
    const seq = entry.localSeq;
    this.schedule(entry);
    return this.whenDurable(name, seq);
  }

  seqOf(name: string): number {
    return this.entries.get(name)?.localSeq ?? 0;
  }

  whenDurable(name: string, seq: number): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry || seq <= entry.durableSeq) return Promise.resolve(true);
    if (this.closed && entry.pending.length === 0 && !entry.needsCompaction) return Promise.resolve(false);
    return new Promise((resolve) => entry.waiters.push({ seq, resolve }));
  }

  private async compact(entry: DocEntry): Promise<void> {
    entry.pending = [];
    const upto = entry.localSeq;
    const state = fullState(entry.doc);
    const chunkDir = `docs/${entry.name}/.chunks-${this.deviceId}`;
    try {
      const written = await writeBlob(this.fs, this.snapPath(entry.name, this.deviceId), state, { chunkDir });
      entry.snaps.set(this.deviceId, { mtimeMs: written.mtimeMs, size: written.size });
      entry.ownSnap = written.pointer;
      await this.fs.write(this.logPath(entry.name, this.deviceId), LOG_HEADER);
      entry.ownLogSize = LOG_HEADER.length;
      entry.needsCompaction = false;
      entry.failures = 0;
      entry.logs.set(this.deviceId, { offset: LOG_HEADER.length, head: LOG_HEADER.slice(), legacy: false });
      this.admit(entry, this.deviceId, written.size, 0);
      this.settle(entry, upto, true);
      await removeUnreferencedChunks(this.fs, chunkDir, written.pointer).catch(() => undefined);
    } catch (error) {
      entry.needsCompaction = true;
      this.report(error, "compact");
      this.retryLater(entry);
    }
  }

  private group(listing: FileEntry[]): Map<string, FileEntry[]> {
    const grouped = new Map<string, FileEntry[]>();
    for (const e of listing) {
      if (e.kind !== "file") continue;
      const parts = e.path.split("/");
      const at = parts.lastIndexOf("docs");
      const name = parts[at + 1];
      if (at < 0 || parts.length !== at + 3 || !name || !DOC_NAME.test(name)) continue;
      const list = grouped.get(name) ?? [];
      list.push(e);
      grouped.set(name, list);
    }
    return grouped;
  }

  private async rescanOnce(): Promise<void> {
    let listing: FileEntry[];
    try {
      listing = await this.fs.list("docs", { recursive: true });
    } catch (error) {
      this.report(error, "rescan");
      this.setState("missing");
      return;
    }
    if (this.stateValue === "missing") this.setState("ready");
    const grouped = this.group(listing);
    this.recharge(grouped, listing);
    const seenPlaceholders = new Set<string>();
    for (const [name, files] of grouped) {
      if (!this.known.has(name)) {
        this.known.add(name);
        this.options.onDocAdded?.(name);
      }
      const entry = this.entries.get(name);
      if (entry?.loaded) {
        const present = new Set(files.map((f) => FILE_NAME.exec(f.path.slice(f.path.lastIndexOf("/") + 1))?.[1]).filter((d): d is string => !!d));
        for (const device of [...entry.snaps.keys(), ...entry.logs.keys()]) {
          if (device === this.deviceId || present.has(device)) continue;
          entry.snaps.delete(device);
          entry.logs.delete(device);
        }
      }
      for (const f of files) {
        const m = FILE_NAME.exec(f.path.slice(f.path.lastIndexOf("/") + 1));
        if (!m) continue;
        const path = `docs/${name}/${m[0]}`;
        if (f.placeholder) {
          seenPlaceholders.add(path);
          this.notePlaceholder(path);
          continue;
        }
        this.placeholders.delete(path);
        if (!entry?.loaded || m[1] === this.deviceId || this.rejectedDocs.has(name)) continue;
        const device = m[1]!;
        if (!this.allowDevice(entry, device)) continue;
        if (f.size > (m[2] === "snap" ? Math.min(this.fs.maxWrite, this.maxDocBytes) : this.maxDocBytes)) {
          this.reject(name, `a ${m[2]} from ${device} is ${f.size} bytes`);
          continue;
        }
        if (m[2] === "snap") {
          const mark = entry.snaps.get(device);
          if (!mark || mark.mtimeMs !== f.mtimeMs || mark.size !== f.size) await this.serial(entry, () => this.readSnap(entry, device, true));
        } else {
          const reader = entry.logs.get(device);
          if (!reader || reader.offset !== f.size || reader.mtimeMs !== f.mtimeMs) await this.serial(entry, () => this.readLog(entry, device));
        }
      }
      await this.yieldNow();
    }
    for (const path of [...this.placeholders.keys()]) if (path.startsWith("docs/") && !seenPlaceholders.has(path)) this.placeholders.delete(path);
    await this.readAllPresence();
    this.options.onState?.();
  }

  private notePlaceholder(path: string) {
    const now = this.timers.now();
    const asked = this.placeholders.get(path);
    if (asked !== undefined && now - asked < 60_000) return;
    this.placeholders.set(path, now);
    void this.fs.read(path, { length: 1 }).catch(() => undefined);
    this.options.onState?.();
  }

  private scheduleRescan() {
    if (this.closed || this.rescanMs <= 0) return;
    this.rescanTimer = this.timers.setTimeout(() => {
      this.rescanTimer = null;
      void this.rescan().finally(() => this.scheduleRescan());
    }, this.rescanMs);
  }

  private rescanSoon() {
    if (this.rescanSoonTimer !== null || this.closed) return;
    this.rescanSoonTimer = this.timers.setTimeout(() => {
      this.rescanSoonTimer = null;
      void this.rescan();
    }, 200);
  }

  private onWatch(paths: string[] | null) {
    if (this.closed) return;
    if (!paths) return this.rescanSoon();
    for (const path of paths) {
      const parts = path.split("/");
      const file = parts[parts.length - 1] ?? "";
      if (parts[0] === "docs" && parts.length === 3) {
        const name = parts[1]!;
        const m = FILE_NAME.exec(file);
        if (!DOC_NAME.test(name) || !m || m[1] === this.deviceId) continue;
        if (!this.known.has(name)) {
          this.known.add(name);
          this.options.onDocAdded?.(name);
        }
        const set = this.pendingPaths.get(name) ?? new Set<string>();
        set.add(file);
        this.pendingPaths.set(name, set);
      } else if (parts[0] === "docs" && parts.length < 3) {
        this.rescanSoon();
      } else if (parts[0] === "presence" && parts.length === 2) {
        const m = /^([A-Za-z0-9_-]{1,64})\.(json|aw)$/.exec(file);
        if (m && m[1] !== this.deviceId) {
          if (m[2] === "aw") this.options.onCursorFile?.(m[1]!, null);
          else void this.readPresence(m[1]!);
        }
      } else if (parts[0] === "files") {
        this.filesListed = false;
      }
    }
    if (this.pendingPaths.size && this.pathTimer === null) {
      this.pathTimer = this.timers.setTimeout(() => {
        this.pathTimer = null;
        void this.drainPaths();
      }, 30);
    }
  }

  private async drainPaths(): Promise<void> {
    const batch = this.pendingPaths;
    this.pendingPaths = new Map();
    for (const [name, files] of batch) {
      await this.yieldNow();
      const entry = this.entries.get(name);
      if (!entry?.loaded || this.rejectedDocs.has(name)) continue;
      for (const file of files) {
        const m = FILE_NAME.exec(file)!;
        const device = m[1]!;
        if (!this.allowDevice(entry, device)) continue;
        await this.serial(entry, () => (m[2] === "snap" ? this.readSnap(entry, device, true) : this.readLog(entry, device)));
      }
    }
    this.options.onState?.();
  }

  private tickPresence() {
    if (this.closed) return;
    this.presenceTimer = this.timers.setTimeout(() => {
      this.presenceTimer = null;
      if (!this.presenceMine?.page) return;
      void this.writePresence();
      this.tickPresence();
    }, PRESENCE_EVERY);
  }

  private writePresence(): Promise<void> {
    const mine = this.presenceMine;
    if (!mine) return this.presenceWrite;
    const body = JSON.stringify({ name: mine.name, color: mine.color, page: mine.page, at: this.timers.now() });
    this.presenceWrite = this.presenceWrite
      .then(() => this.fs.writeText(`presence/${this.deviceId}.json`, body))
      .then(
        () => undefined,
        (error) => this.report(error, "presence"),
      );
    return this.presenceWrite;
  }

  private async readAllPresence() {
    let list: FileEntry[];
    try {
      list = await this.fs.list("presence");
    } catch {
      return;
    }
    const seen = new Set<string>();
    let cursors = 0;
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const e of list) {
      const cursor = /([A-Za-z0-9_-]{1,64})\.aw$/.exec(e.path);
      if (cursor && cursor[1] !== this.deviceId && !e.placeholder && cursors < this.maxDevices) {
        cursors++;
        this.options.onCursorFile?.(cursor[1]!, e.mtimeMs);
      }
      const m = /([A-Za-z0-9_-]{1,64})\.json$/.exec(e.path);
      if (!m || m[1] === this.deviceId || e.placeholder || e.size > PRESENCE_MAX || seen.size >= this.maxDevices) continue;
      seen.add(m[1]!);
      const known = this.presenceFiles.get(m[1]!);
      if (!known || Math.abs(known.at - e.mtimeMs) > 1000) await this.readPresence(m[1]!, false);
    }
    for (const device of [...this.presenceFiles.keys()]) if (!seen.has(device)) this.presenceFiles.delete(device);
    this.options.onPresence?.(this.presence());
  }

  private async readPresence(device: string, notify = true) {
    if (!this.presenceFiles.has(device) && this.presenceFiles.size >= this.maxDevices) return;
    try {
      const res = await this.fs.read(`presence/${device}.json`, { length: PRESENCE_MAX + 1 });
      if (res.found && res.size > PRESENCE_MAX) return;
      const text = res.found ? new TextDecoder().decode(res.data) : null;
      if (text === null) {
        this.presenceFiles.delete(device);
      } else {
        const v = JSON.parse(text) as Record<string, unknown>;
        this.presenceFiles.set(device, {
          device,
          name: typeof v.name === "string" ? v.name.slice(0, 80) : "Someone",
          color: typeof v.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.color) ? v.color : "#888888",
          page: typeof v.page === "string" && /^[0-9a-f]{12}$/.test(v.page) ? v.page : null,
          at: typeof v.at === "number" ? v.at : 0,
        });
      }
    } catch {
      return;
    }
    if (notify) this.options.onPresence?.(this.presence());
  }

  private setState(state: StoreState) {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onState?.();
  }

  private report(error: unknown, where: string) {
    this.options.onError?.(error, where);
  }
}
