import { fromBase64, toBase64 } from "../shared/bytes";
import { awarenessClients, awarenessRemoval, encodeAwareness } from "./awareness";
import { errorCode, type FileStore } from "./files";
import type { Timers } from "./storage";

export type CursorClient = { id: number; clock: number; state: string };

export const CURSOR_THROTTLE = 400;
export const CURSOR_KEEPALIVE = 6_000;
export const CURSOR_STALE = 18_000;
export const CURSOR_SWEEP = (stale: number) => Math.max(50, Math.min(5000, stale / 4));

type Remote = { seenAt: number; mtimeMs: number | null; body: string; docs: Map<string, Map<number, CursorClient>> };

export type CursorOptions = {
  fs: FileStore;
  deviceId: string;
  timers: Timers;
  collect: () => Map<string, CursorClient[]>;
  deliver: (doc: string, update: Uint8Array) => void;
  onError?: (error: unknown) => void;
  throttleMs?: number;
  keepaliveMs?: number;
  staleMs?: number;
  maxRemotes?: number;
};

const DOC = /^(ws|p:[0-9a-f]{12})$/;
const MAX_CLIENTS = 64;
const MAX_STATE = 16_384;
const CURSOR_FILE_MAX = 256 * 1024;
const MAX_REMOTES = 64;
const MAX_EXPIRED = 256;

export class CursorSync {
  private readonly throttle: number;
  private readonly keepalive: number;
  private readonly stale: number;
  private writeTimer: unknown = null;
  private keepTimer: unknown = null;
  private sweepTimer: unknown = null;
  private lastWrite = 0;
  private wroteEmpty = true;
  private writing: Promise<void> = Promise.resolve();
  private readonly remotes = new Map<string, Remote>();
  private readonly expired = new Map<string, { mtimeMs: number | null; body: string }>();
  private readonly reading = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly options: CursorOptions) {
    this.throttle = options.throttleMs ?? CURSOR_THROTTLE;
    this.keepalive = options.keepaliveMs ?? CURSOR_KEEPALIVE;
    this.stale = options.staleMs ?? CURSOR_STALE;
    this.scheduleSweep();
  }

  private get path() {
    return `presence/${this.options.deviceId}.aw`;
  }

  localChanged() {
    if (this.closed || this.writeTimer !== null) return;
    const wait = Math.max(0, this.lastWrite + this.throttle - this.options.timers.now());
    this.writeTimer = this.options.timers.setTimeout(() => {
      this.writeTimer = null;
      void this.write();
    }, wait);
  }

  private write(): Promise<void> {
    const docs = this.options.collect();
    const out: Record<string, string> = {};
    for (const [doc, clients] of docs) if (clients.length) out[doc] = toBase64(encodeAwareness(clients.slice(0, MAX_CLIENTS)));
    const empty = Object.keys(out).length === 0;
    if (this.keepTimer !== null) {
      this.options.timers.clearTimeout(this.keepTimer);
      this.keepTimer = null;
    }
    if (empty && this.wroteEmpty) return this.writing;
    this.wroteEmpty = empty;
    this.lastWrite = this.options.timers.now();
    const body = JSON.stringify({ at: this.lastWrite, docs: out });
    this.writing = this.writing
      .then(() => this.options.fs.writeText(this.path, body))
      .then(
        () => undefined,
        (error) => this.options.onError?.(error),
      );
    if (!empty && !this.closed) {
      this.keepTimer = this.options.timers.setTimeout(() => {
        this.keepTimer = null;
        void this.write();
      }, this.keepalive);
    }
    return this.writing;
  }

  remoteChanged(device: string, mtimeMs: number | null) {
    if (this.closed || device === this.options.deviceId || !/^[A-Za-z0-9_-]{1,64}$/.test(device)) return;
    const known = this.remotes.get(device) ?? this.expired.get(device);
    if (known && mtimeMs !== null && known.mtimeMs === mtimeMs) return;
    if (!this.remotes.has(device) && this.remotes.size >= (this.options.maxRemotes ?? MAX_REMOTES)) return;
    const previous = this.reading.get(device) ?? Promise.resolve();
    const next = previous.then(() => this.read(device, mtimeMs)).catch((error) => this.options.onError?.(error));
    this.reading.set(device, next);
    void next.finally(() => {
      if (this.reading.get(device) === next) this.reading.delete(device);
    });
  }

  private async read(device: string, mtimeMs: number | null) {
    let text: string | null;
    try {
      const res = await this.options.fs.read(`presence/${device}.aw`, { length: CURSOR_FILE_MAX + 1 });
      if (res.found && res.size > CURSOR_FILE_MAX) return;
      text = res.found ? new TextDecoder().decode(res.data) : null;
    } catch (error) {
      if (errorCode(error) === "unavailable") return;
      throw error;
    }
    if (this.closed) return;
    const known = this.remotes.get(device);
    if (text === null) {
      this.expired.delete(device);
      if (known) this.drop(device, true);
      return;
    }
    const gone = this.expired.get(device);
    if (gone && gone.body === text) {
      gone.mtimeMs = mtimeMs ?? gone.mtimeMs;
      return;
    }
    if (known && known.body === text) {
      known.mtimeMs = mtimeMs ?? known.mtimeMs;
      return;
    }
    this.expired.delete(device);
    if (!known && this.remotes.size >= (this.options.maxRemotes ?? MAX_REMOTES)) return;
    const docs = new Map<string, Map<number, CursorClient>>();
    try {
      const parsed = JSON.parse(text) as { docs?: Record<string, unknown> };
      for (const [doc, value] of Object.entries(parsed.docs ?? {})) {
        if (!DOC.test(doc) || typeof value !== "string") continue;
        const clients = new Map<number, CursorClient>();
        for (const c of awarenessClients(fromBase64(value)).slice(0, MAX_CLIENTS)) if (!c.removed && c.state.length <= MAX_STATE) clients.set(c.id, { id: c.id, clock: c.clock, state: c.state });
        if (clients.size) docs.set(doc, clients);
      }
    } catch {
      return;
    }
    const before = known?.docs ?? new Map<string, Map<number, CursorClient>>();
    this.remotes.set(device, { seenAt: this.options.timers.now(), mtimeMs, body: text, docs });
    for (const doc of new Set([...before.keys(), ...docs.keys()])) {
      const old = before.get(doc) ?? new Map<number, CursorClient>();
      const now = docs.get(doc) ?? new Map<number, CursorClient>();
      const changed = [...now.values()].filter((c) => {
        const o = old.get(c.id);
        return !o || o.clock !== c.clock || o.state !== c.state;
      });
      const gone = [...old.values()].filter((c) => !now.has(c.id));
      if (changed.length) this.options.deliver(doc, encodeAwareness(changed));
      if (gone.length) this.options.deliver(doc, awarenessRemoval(gone));
    }
  }

  private drop(device: string, forget = false) {
    const known = this.remotes.get(device);
    if (!known) return;
    const docs = known.docs;
    this.remotes.delete(device);
    if (!forget) {
      this.expired.delete(device);
      this.expired.set(device, { mtimeMs: known.mtimeMs, body: known.body });
      while (this.expired.size > MAX_EXPIRED) this.expired.delete(this.expired.keys().next().value!);
    }
    for (const [doc, clients] of docs) if (clients.size) this.options.deliver(doc, awarenessRemoval([...clients.values()]));
  }

  cached(doc: string): Uint8Array | null {
    const now = this.options.timers.now();
    const clients: CursorClient[] = [];
    for (const remote of this.remotes.values()) {
      if (now - remote.seenAt > this.stale) continue;
      for (const c of remote.docs.get(doc)?.values() ?? []) clients.push(c);
    }
    return clients.length ? encodeAwareness(clients) : null;
  }

  async settled(): Promise<void> {
    while (this.reading.size) await Promise.all([...this.reading.values()]);
  }

  devices(): string[] {
    return [...this.remotes.keys()];
  }

  private scheduleSweep() {
    if (this.closed) return;
    this.sweepTimer = this.options.timers.setTimeout(() => {
      this.sweepTimer = null;
      this.sweep();
      this.scheduleSweep();
    }, CURSOR_SWEEP(this.stale));
  }

  sweep() {
    const now = this.options.timers.now();
    for (const [device, remote] of [...this.remotes]) if (now - remote.seenAt > this.stale) this.drop(device);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const t of [this.writeTimer, this.keepTimer, this.sweepTimer]) if (t !== null) this.options.timers.clearTimeout(t);
    this.writeTimer = this.keepTimer = this.sweepTimer = null;
    this.closed = true;
    if (!this.wroteEmpty) {
      this.wroteEmpty = true;
      const body = JSON.stringify({ at: this.options.timers.now(), docs: {} });
      this.writing = this.writing.then(() => this.options.fs.writeText(this.path, body)).then(
        () => undefined,
        (error) => this.options.onError?.(error),
      );
    }
    await this.writing;
  }

  flushed(): Promise<void> {
    return this.writing;
  }
}
