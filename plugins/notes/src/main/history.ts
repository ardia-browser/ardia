import * as Y from "yjs";
import type { VersionInfo } from "../shared/protocol";
import { isEmptyDoc } from "./content";
import { readBlob, writeBlob } from "./blob";
import { randomHex } from "../shared/bytes";
import { errorCode, type FileStore } from "./files";
import { fullState, type Timers } from "./storage";

export const HISTORY_EVERY = 10 * 60 * 1000;
export const HISTORY_KEEP = 30 * 24 * 60 * 60 * 1000;

const VERSION = /^(\d{10,16})-([A-Za-z0-9_]{1,64})(?:-([0-9a-f]{1,8}))?$/;
const VERSION_BYTES_MAX = 64 * 1024 * 1024;

export class History {
  private last = new Map<string, number>();
  private listing = new Map<string, Promise<void>>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly fs: FileStore,
    private readonly deviceId: string,
    private readonly timers: Timers,
    private readonly every = HISTORY_EVERY,
    private readonly keep = HISTORY_KEEP,
  ) {}

  private dir(workspace: string, page: string) {
    return `${workspace}/${page}`;
  }

  private known(workspace: string, page: string): Promise<void> {
    const key = this.dir(workspace, page);
    if (this.last.has(key)) return Promise.resolve();
    let pending = this.listing.get(key);
    if (!pending) {
      pending = this.list(workspace, page)
        .then((versions) => {
          if (!this.last.has(key)) this.last.set(key, versions[0]?.at ?? 0);
        })
        .catch(() => {
          if (!this.last.has(key)) this.last.set(key, 0);
        })
        .finally(() => this.listing.delete(key));
      this.listing.set(key, pending);
    }
    return pending;
  }

  async beforeEdit(workspace: string, page: string, doc: Y.Doc): Promise<void> {
    await this.known(workspace, page);
    const key = this.dir(workspace, page);
    const now = this.timers.now();
    if (now - (this.last.get(key) ?? 0) < this.every) return;
    if (isEmptyDoc(doc)) {
      this.last.set(key, now - this.every + 60_000);
      return;
    }
    this.snapshot(workspace, page, doc);
  }

  snapshot(workspace: string, page: string, doc: Y.Doc): Promise<void> {
    const now = this.timers.now();
    const key = this.dir(workspace, page);
    this.last.set(key, now);
    const state = fullState(doc);
    const save = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = `${now}-${this.deviceId.replace(/-/g, "_")}-${randomHex(3)}`;
        try {
          await writeBlob(this.fs, `${key}/${id}.snap`, state, { chunkDir: `${key}/.${id}`, exclusive: true });
          return;
        } catch (error) {
          if (errorCode(error) !== "exists") throw error;
        }
      }
    };
    this.writes = this.writes.then(save, save);
    return this.writes.catch(() => undefined);
  }

  async list(workspace: string, page: string): Promise<VersionInfo[]> {
    await this.writes.catch(() => undefined);
    const entries = await this.fs.list(this.dir(workspace, page));
    const now = this.timers.now();
    const out: VersionInfo[] = [];
    for (const e of entries) {
      const base = e.path.slice(e.path.lastIndexOf("/") + 1).replace(/\.snap$/, "");
      const m = VERSION.exec(base);
      if (!m || !e.path.endsWith(".snap") || e.kind !== "file") continue;
      const at = Number(m[1]);
      if (now - at > this.keep) {
        void this.removeVersion(workspace, page, base);
        continue;
      }
      out.push({ id: base, at, by: m[2]!, size: e.size });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async state(workspace: string, page: string, version: string): Promise<Uint8Array | null> {
    if (!VERSION.test(version)) return null;
    await this.writes.catch(() => undefined);
    const res = await readBlob(this.fs, `${this.dir(workspace, page)}/${version}.snap`, { maxBytes: VERSION_BYTES_MAX }).catch(() => null);
    return res && res.found && !("tooLarge" in res) ? res.data : null;
  }

  private async removeVersion(workspace: string, page: string, version: string) {
    const dir = this.dir(workspace, page);
    await this.fs.remove(`${dir}/${version}.snap`).catch(() => false);
    for (const e of await this.fs.list(`${dir}/.${version}`).catch(() => [])) await this.fs.remove(e.path).catch(() => false);
  }

  async prune(): Promise<number> {
    const now = this.timers.now();
    let removed = 0;
    const entries = await this.fs.list("", { recursive: true });
    for (const e of entries) {
      if (e.kind !== "file" || !e.path.endsWith(".snap")) continue;
      const m = VERSION.exec(e.path.slice(e.path.lastIndexOf("/") + 1).replace(/\.snap$/, ""));
      if (m && now - Number(m[1]) > this.keep) {
        const parts = e.path.split("/");
        if (parts.length === 3) {
          await this.removeVersion(parts[0]!, parts[1]!, parts[2]!.replace(/\.snap$/, ""));
          removed++;
        }
      }
    }
    return removed;
  }

  async removeWorkspace(workspace: string): Promise<void> {
    const entries = await this.fs.list(workspace, { recursive: true }).catch(() => []);
    for (const e of entries) if (e.kind === "file") await this.fs.remove(e.path).catch(() => false);
    for (const key of [...this.last.keys()]) if (key.startsWith(`${workspace}/`)) this.last.delete(key);
  }

  flushed(): Promise<void> {
    return this.writes.catch(() => undefined);
  }
}
