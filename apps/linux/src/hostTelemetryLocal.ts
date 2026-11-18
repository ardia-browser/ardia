import type { TelemetryLocalExport, TelemetryLocalNative, TelemetryLocalStats } from "../../../packages/shell/src/telemetryLocal";
import { ardiaHost, callHost, type ArdiaHost } from "./host.ts";
import { unavailableError } from "./hostCapabilities.ts";
import { hostReportExport } from "./hostReport.ts";

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATABASE = "ardia.telemetry-local";
const STORE = "chunks";
const MAX_WRITE_SAMPLES = 4096;
const SAVE_DEADLINE_MS = 30_000;
const SAVE_POLL_MS = 100;
const GATHER_TIMEOUT_MS = 1_000;
export const TELEMETRY_LOCAL_CHANNEL = "ardia.linux.telemetry-local";
const FEATURE = "The local telemetry copy";

export type Chunk = { key: number; day: string; text: string };
export type ChunkChange<T> = { put: Chunk[]; remove: number[]; result: T };
export type ChunkStore = {
  add(day: string, text: string): Promise<void>;
  all(): Promise<Chunk[]>;
  change<T>(plan: (chunks: Chunk[]) => ChunkChange<T>): Promise<T>;
  clear(): Promise<void>;
};

const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).length;
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lineAt = (line: string) => {
  const match = /^\{"at":(\d+)/.exec(line);
  return match ? Number(match[1]) : null;
};
const linesOf = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};
const textOf = (lines: string[]) => lines.map((line) => `${line}\n`).join("");

type DayLines = { day: string; keys: number[]; lines: string[] };

function byDay(chunks: Chunk[]): DayLines[] {
  const days = new Map<string, DayLines>();
  for (const chunk of [...chunks].sort((a, b) => a.key - b.key)) {
    const known = days.get(chunk.day);
    if (known) {
      known.keys.push(chunk.key);
      known.lines.push(...linesOf(chunk.text));
    } else days.set(chunk.day, { day: chunk.day, keys: [chunk.key], lines: linesOf(chunk.text) });
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export type PrunePlan = { put: Chunk[]; remove: number[]; dropped: number; bytes: number; lines: number; files: number };

export function planPrune(chunks: Chunk[], now: number, keepMs: number, maxBytes: number): PrunePlan {
  const cutoff = now - keepMs;
  const oldestDay = utcDay(cutoff);
  const newestDay = utcDay(now + DAY_MS);
  const remove: number[] = [];
  const rewritten = new Set<DayLines>();
  let dropped = 0;
  const discard = (entry: DayLines) => {
    dropped += entry.lines.length;
    remove.push(...entry.keys);
  };
  const trim = (entry: DayLines, count: number) => {
    dropped += count;
    entry.lines.splice(0, count);
    rewritten.add(entry);
  };
  let days = byDay(chunks).filter((entry) => {
    if (entry.day >= oldestDay && entry.day <= newestDay) return true;
    discard(entry);
    return false;
  });
  const first = days[0];
  if (first && first.day === oldestDay) {
    const kept = first.lines.findIndex((line) => (lineAt(line) ?? now) >= cutoff);
    if (kept < 0) {
      discard(first);
      days = days.slice(1);
    } else if (kept > 0) trim(first, kept);
  }
  const sizes = new Map(days.map((entry) => [entry, entry.lines.map((line) => utf8Bytes(line) + 1)]));
  const sizeOf = (entry: DayLines) => sizes.get(entry)!.reduce((sum, size) => sum + size, 0);
  let total = days.reduce((sum, entry) => sum + sizeOf(entry), 0);
  const target = maxBytes - Math.floor(maxBytes / 10);
  while (total > maxBytes && days.length) {
    const oldest = days[0]!;
    const excess = total - target;
    const size = sizeOf(oldest);
    if (size <= excess) {
      discard(oldest);
      total -= size;
      days = days.slice(1);
      continue;
    }
    const lineSizes = sizes.get(oldest)!;
    let cut = 0;
    let freed = 0;
    while (cut < lineSizes.length && freed < excess) freed += lineSizes[cut++]!;
    lineSizes.splice(0, cut);
    trim(oldest, cut);
    total -= freed;
    break;
  }
  const put: Chunk[] = [];
  for (const entry of days) {
    if (entry.keys.length > 1) remove.push(...entry.keys.slice(1));
    if (entry.keys.length > 1 || rewritten.has(entry)) put.push({ key: entry.keys[0]!, day: entry.day, text: textOf(entry.lines) });
  }
  return { put, remove, dropped, bytes: total, lines: days.reduce((sum, entry) => sum + entry.lines.length, 0), files: days.length };
}

export function collectSince(chunks: Chunk[], since: number): { text: string; lines: number } {
  const fromDay = utcDay(since);
  let text = "";
  let lines = 0;
  for (const entry of byDay(chunks)) {
    if (entry.day < fromDay) continue;
    const first = entry.day === fromDay ? entry.lines.findIndex((line) => (lineAt(line) ?? since) >= since) : 0;
    const kept = first < 0 ? [] : entry.lines.slice(first);
    text += textOf(kept);
    lines += kept.length;
  }
  return { text, lines };
}

export type TelemetryLocalDeps = {
  chunks: ChunkStore | null;
  writes: boolean;
  save(name: string, text: string): Promise<string | null>;
  reportFile?(text: string): Promise<{ path: string; bytes: number } | null>;
  gather?(): Promise<void>;
  clock?(): number;
  now?(): number;
  report?(error: unknown): void;
};

export type TelemetryLocal = TelemetryLocalNative & { settled(): Promise<void> };

export function createTelemetryLocal(deps: TelemetryLocalDeps): TelemetryLocal {
  const clock = deps.clock ?? (() => performance.now());
  const now = deps.now ?? (() => Date.now());
  const report = deps.report ?? (() => {});
  let maxBytes = 8 * 1_048_576;
  let keepMs = 7 * DAY_MS;
  let knownBytes: number | null = null;
  let droppedSincePrune = 0;
  let writeMs: number[] = [];
  let queue: Promise<void> = Promise.resolve();

  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.then(() => {}, () => {});
    return next;
  };
  const required = () => {
    if (!deps.chunks) throw unavailableError(FEATURE);
    return deps.chunks;
  };
  const pruneStore = async (store: ChunkStore, at: number) => {
    const started = clock();
    const plan = await store.change((chunks) => {
      const planned = planPrune(chunks, at, keepMs, maxBytes);
      return { put: planned.put, remove: planned.remove, result: planned };
    });
    droppedSincePrune += plan.dropped;
    knownBytes = plan.bytes;
    return { bytes: plan.bytes, lines: plan.lines, files: plan.files, pruneMs: clock() - started };
  };
  const write = (day: string, text: string) => {
    if (!deps.writes || !DAY.test(day) || !text) return;
    const store = required();
    const body = text.endsWith("\n") ? text : `${text}\n`;
    void run(async () => {
      const started = clock();
      await store.add(day, body);
      if (writeMs.length >= MAX_WRITE_SAMPLES) writeMs.splice(0, writeMs.length - MAX_WRITE_SAMPLES + 1);
      writeMs.push(clock() - started);
      if (knownBytes === null) return;
      knownBytes += utf8Bytes(body);
      if (knownBytes > maxBytes) await pruneStore(store, now());
    }).catch(report);
  };

  return {
    append: write,
    appendNow: write,
    configure(nextMaxBytes, keepDays) {
      maxBytes = Math.max(1, nextMaxBytes);
      keepMs = Math.max(1, keepDays) * DAY_MS;
    },
    prune: (at) => run(async (): Promise<TelemetryLocalStats> => {
      const stats = await pruneStore(required(), at);
      const reading = { ...stats, droppedLines: droppedSincePrune, writeMs };
      droppedSincePrune = 0;
      writeMs = [];
      return reading;
    }),
    clear: () => run(async () => {
      await deps.chunks?.clear();
      knownBytes = 0;
    }),
    async exportForReport(since): Promise<TelemetryLocalExport | null> {
      const store = deps.chunks;
      const write = deps.reportFile;
      if (!store || !write) return null;
      await deps.gather?.().catch(report);
      const { text, lines } = await run(async () => collectSince(await store.all(), since));
      const file = await write(text);
      return file ? { ...file, lines } : null;
    },
    async exportToDownloads(at): Promise<TelemetryLocalExport | null> {
      const store = deps.chunks;
      if (!store) return null;
      await deps.gather?.().catch(report);
      const { text, lines } = await run(async () => collectSince(await store.all(), at - keepMs));
      const path = await deps.save(`Ardia data ${utcDay(at)}.jsonl`, text);
      return path ? { path, bytes: utf8Bytes(text), lines } : null;
    },
    settled: () => run(async () => {}),
  };
}

type StoredChunk = { day: string; text: string };
const isStoredChunk = (value: unknown): value is StoredChunk =>
  typeof value === "object" && value !== null && typeof (value as StoredChunk).day === "string" && typeof (value as StoredChunk).text === "string";

export function indexedChunkStore(factory: IDBFactory): ChunkStore {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => void request.result.createObjectStore(STORE, { autoIncrement: true });
    request.onsuccess = () => {
      const database = request.result;
      const forget = () => void (opening = null);
      database.onversionchange = () => (database.close(), forget());
      database.onclose = forget;
      resolve(database);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  const transact = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, answer: (value: T) => void, transaction: IDBTransaction) => void): Promise<T> => {
    const database = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      let value: T;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error ?? new Error("The local telemetry copy was not written"));
      work(transaction.objectStore(STORE), (answer) => void (value = answer), transaction);
    });
  };
  const read = (store: IDBObjectStore, done: (chunks: Chunk[]) => void) => {
    const values = store.getAll();
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      const chunks: Chunk[] = [];
      keys.result.forEach((key, index) => {
        const value: unknown = values.result[index];
        if (typeof key === "number" && isStoredChunk(value)) chunks.push({ key, day: value.day, text: value.text });
      });
      done(chunks);
    };
  };
  return {
    add: (day, text) => transact<void>("readwrite", (store, _answer, transaction) => {
      store.add({ day, text } satisfies StoredChunk);
      transaction.commit();
    }),
    all: () => transact<Chunk[]>("readonly", (store, answer) => read(store, answer)),
    change: <T>(plan: (chunks: Chunk[]) => ChunkChange<T>) => transact<T>("readwrite", (store, answer, transaction) => read(store, (chunks) => {
      const { put, remove, result } = plan(chunks);
      for (const key of remove) store.delete(key);
      for (const { key, day, text } of put) store.put({ day, text } satisfies StoredChunk, key);
      answer(result);
      transaction.commit();
    })),
    clear: () => transact<void>("readwrite", (store, _answer, transaction) => {
      store.clear();
      transaction.commit();
    }),
  };
}

export type DownloadSaverDeps = {
  begin(name: string, text: string): string;
  release(url: string): void;
  list(): Promise<unknown>;
  pause(ms: number): Promise<void>;
  now?(): number;
};

type ListedDownload = { url?: unknown; state?: unknown; path?: unknown };

export function downloadSaver(deps: DownloadSaverDeps) {
  const now = deps.now ?? (() => Date.now());
  return async (name: string, text: string): Promise<string | null> => {
    const url = deps.begin(name, text);
    try {
      const deadline = now() + SAVE_DEADLINE_MS;
      while (now() < deadline) {
        await deps.pause(SAVE_POLL_MS);
        const listed = await deps.list();
        const entry = Array.isArray(listed) ? (listed as ListedDownload[]).find((download) => download?.url === url) : undefined;
        if (!entry) continue;
        if (entry.state === "finished") return typeof entry.path === "string" && entry.path.startsWith("/") ? entry.path : null;
        if (entry.state === "failed" || entry.state === "cancelled") return null;
      }
      return null;
    } finally {
      deps.release(url);
    }
  };
}

function pageDownloads(host: ArdiaHost): DownloadSaverDeps {
  return {
    begin(name, text) {
      const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      return url;
    },
    release: (url) => URL.revokeObjectURL(url),
    list: async () => JSON.parse(await callHost("downloads.list", "", "{}", host)) as unknown,
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export type FlushChannel = { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null };

export type FlushRelayDeps = {
  channel: FlushChannel;
  leading(): Promise<boolean>;
  flush(): Promise<void>;
  settled(): Promise<void>;
  newId?(): string;
  timeoutMs?: number;
};

type FlushWire = { kind: "flush" | "flushed"; id: string };
const isFlushWire = (value: unknown): value is FlushWire =>
  typeof value === "object" && value !== null && ((value as FlushWire).kind === "flush" || (value as FlushWire).kind === "flushed") && typeof (value as FlushWire).id === "string";

export function startFlushRelay(deps: FlushRelayDeps) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const waiting = new Map<string, () => void>();
  deps.channel.onmessage = (event) => {
    const data = event.data;
    if (!isFlushWire(data)) return;
    if (data.kind === "flushed") return waiting.get(data.id)?.();
    void deps.leading().then(async (leading) => {
      if (!leading) return;
      await deps.flush();
      await deps.settled();
      deps.channel.postMessage({ kind: "flushed", id: data.id } satisfies FlushWire);
    }).catch(() => {});
  };
  return {
    async gather(): Promise<void> {
      if (await deps.leading()) return;
      const id = newId();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve();
        };
        const timer = setTimeout(done, deps.timeoutMs ?? GATHER_TIMEOUT_MS);
        waiting.set(id, done);
        deps.channel.postMessage({ kind: "flush", id } satisfies FlushWire);
      });
    },
  };
}

export const telemetryLocalAvailable = () => typeof indexedDB !== "undefined" && typeof document !== "undefined";

const reportFailure = (error: unknown) => console.warn("[ardia linux] local telemetry copy", error);

function hostTelemetryLocal(host: ArdiaHost | undefined): TelemetryLocal {
  const available = !!host && telemetryLocalAvailable();
  const relay = available && typeof BroadcastChannel !== "undefined"
    ? startFlushRelay({
        channel: new BroadcastChannel(TELEMETRY_LOCAL_CHANNEL) as unknown as FlushChannel,
        leading: () => import("./hostTelemetry.ts").then((telemetry) => telemetry.linuxTelemetryHooks.leading()),
        flush: () => import("../../browser/src/state/telemetry/localStore").then((store) => store.flushLocal()),
        settled: () => local.settled(),
      })
    : null;
  const local: TelemetryLocal = createTelemetryLocal({
    chunks: available ? indexedChunkStore(indexedDB) : null,
    writes: !host?.bootstrap.privateWindow,
    save: host && available ? downloadSaver(pageDownloads(host)) : () => Promise.resolve(null),
    reportFile: available ? hostReportExport(host) : undefined,
    gather: relay?.gather,
    report: reportFailure,
  });
  return local;
}

let shared: TelemetryLocal | undefined;
const local = () => shared ??= hostTelemetryLocal(ardiaHost);

export const TELEMETRY_LOCAL_METHODS: Record<string, (...args: unknown[]) => unknown> = {
  append: (day, text) => local().append(day as string, text as string),
  appendNow: (day, text) => local().appendNow(day as string, text as string),
  configure: (maxBytes, keepDays) => local().configure(maxBytes as number, keepDays as number),
  prune: (now) => local().prune(now as number),
  clear: () => local().clear(),
  exportForReport: (since) => local().exportForReport(since as number),
  exportToDownloads: (now) => local().exportToDownloads(now as number),
};

if (ardiaHost) local();
