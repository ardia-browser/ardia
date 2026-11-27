import { concatBytes, fromBase64, toBase64 } from "../shared/bytes";

export type Disposable = { dispose(): void };

export type FileEntry = { path: string; kind: "file" | "dir"; size: number; mtimeMs: number; placeholder: boolean };
export type HostReadResult = { found: false } | { found: true; data: string; size: number; mtimeMs: number };
export type WriteResult = { size: number; mtimeMs: number };
export type FolderGrant = { id: string; name: string; location: "icloud" | "other"; available: boolean };

export type FilesApi = {
  read(path: string, options?: { root?: string; offset?: number; length?: number }): Promise<HostReadResult>;
  readText(path: string, options?: { root?: string }): Promise<string | null>;
  write(path: string, base64: string, options?: { root?: string; exclusive?: boolean }): Promise<WriteResult>;
  writeText(path: string, text: string, options?: { root?: string; exclusive?: boolean }): Promise<WriteResult>;
  append(path: string, base64: string, options?: { root?: string }): Promise<WriteResult>;
  list(dir?: string, options?: { root?: string; recursive?: boolean }): Promise<FileEntry[]>;
  remove(path: string, options?: { root?: string }): Promise<boolean>;
  watch(listener: (event: { root: string; paths: string[] }) => void, options?: { root?: string }): Disposable;
};

export type FoldersApi = {
  list(): Promise<FolderGrant[]>;
  create(name: string): Promise<FolderGrant | null>;
  pick(options?: { prompt?: string }): Promise<FolderGrant | null>;
  share(id: string): Promise<{ ok: boolean }>;
  forget(id: string): Promise<unknown>;
};

export type ReadResult = { found: false } | { found: true; data: Uint8Array; size: number; mtimeMs: number };

export interface FileStore {
  readonly maxWrite: number;
  stat(path: string): Promise<{ found: false } | { found: true; size: number; mtimeMs: number }>;
  read(path: string, range?: { offset?: number; length?: number }): Promise<ReadResult>;
  readText(path: string): Promise<string | null>;
  write(path: string, data: Uint8Array, options?: { exclusive?: boolean }): Promise<WriteResult>;
  writeText(path: string, text: string, options?: { exclusive?: boolean }): Promise<WriteResult>;
  append(path: string, data: Uint8Array): Promise<WriteResult>;
  list(dir: string, options?: { recursive?: boolean }): Promise<FileEntry[]>;
  remove(path: string): Promise<boolean>;
  watch(listener: (paths: string[] | null) => void): Disposable;
}

export const CALL_LIMIT = 4 * 1024 * 1024;
export const READ_CHUNK = 1024 * 1024;

export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

const join = (a: string, b: string) => (!a ? b : !b ? a : `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`);

type WatchHub = { listeners: Set<(event: { root: string; paths: string[] }) => void>; handle: Disposable };

const hubs = new WeakMap<FilesApi, Map<string, WatchHub>>();

function sharedWatch(files: FilesApi, root: string, listener: (event: { root: string; paths: string[] }) => void): Disposable {
  let byRoot = hubs.get(files);
  if (!byRoot) hubs.set(files, (byRoot = new Map()));
  let hub = byRoot.get(root);
  if (!hub) {
    const listeners = new Set<(event: { root: string; paths: string[] }) => void>();
    const handle = files.watch((event) => {
      for (const l of [...listeners]) l(event);
    }, { root });
    hub = { listeners, handle };
    byRoot.set(root, hub);
  }
  const live = hub;
  live.listeners.add(listener);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      live.listeners.delete(listener);
      if (live.listeners.size === 0 && byRoot!.get(root) === live) {
        byRoot!.delete(root);
        live.handle.dispose();
      }
    },
  };
}

export function ardiaFileStore(files: FilesApi, root: string, prefix = "", options: { callMax?: number; readChunk?: number } = {}): FileStore {
  const CALL_MAX = options.callMax ?? CALL_LIMIT;
  const READ_MAX = Math.min(CALL_MAX, options.readChunk ?? READ_CHUNK);
  const base = prefix.replace(/^\/+|\/+$/g, "");
  const full = (path: string) => join(base, path);
  const local = (path: string): string | null => {
    if (!base) return path;
    if (path === base) return "";
    return path.startsWith(base + "/") ? path.slice(base.length + 1) : null;
  };
  const opts = { root };
  return {
    maxWrite: CALL_MAX,
    async stat(path) {
      const res = await files.read(full(path), { ...opts, offset: 0, length: 0 });
      return res.found ? { found: true, size: res.size, mtimeMs: res.mtimeMs } : { found: false };
    },
    async read(path, range = {}) {
      const offset = range.offset ?? 0;
      const wanted = range.length;
      if (wanted === 0) {
        const res = await files.read(full(path), { ...opts, offset, length: 0 });
        return res.found ? { found: true, data: new Uint8Array(0), size: res.size, mtimeMs: res.mtimeMs } : { found: false };
      }
      const parts: Uint8Array[] = [];
      let at = offset;
      let size = 0;
      let mtimeMs = 0;
      for (;;) {
        const left = wanted === undefined ? READ_MAX : Math.min(READ_MAX, wanted - (at - offset));
        if (left <= 0) break;
        const res = await files.read(full(path), { ...opts, offset: at, length: left });
        if (!res.found) {
          if (parts.length === 0) return { found: false };
          break;
        }
        const bytes = fromBase64(res.data);
        size = res.size;
        mtimeMs = res.mtimeMs;
        parts.push(bytes);
        at += bytes.length;
        if (bytes.length === 0 || at >= size) break;
      }
      return { found: true, data: parts.length === 1 ? parts[0]! : concatBytes(parts), size, mtimeMs };
    },
    readText: (path) => files.readText(full(path), opts),
    async write(path, data, options = {}) {
      if (data.length > CALL_MAX) throw Object.assign(new Error(`${path} is over ${CALL_MAX} bytes; write it as a blob.`), { code: "too_large" });
      return files.write(full(path), toBase64(data), { ...opts, ...(options.exclusive ? { exclusive: true } : {}) });
    },
    writeText: (path, text, options = {}) => files.writeText(full(path), text, { ...opts, ...(options.exclusive ? { exclusive: true } : {}) }),
    async append(path, data) {
      if (data.length > CALL_MAX) throw Object.assign(new Error(`${path}: an append is at most ${CALL_MAX} bytes.`), { code: "too_large" });
      return files.append(full(path), toBase64(data), opts);
    },
    async list(dir, options = {}) {
      let entries: FileEntry[];
      try {
        entries = await files.list(full(dir), { ...opts, ...(options.recursive ? { recursive: true } : {}) });
      } catch (error) {
        if (errorCode(error) === "not_found") return [];
        throw error;
      }
      const out: FileEntry[] = [];
      for (const raw of entries) {
        const rel = local(raw.path);
        if (rel) out.push({ ...raw, path: rel });
      }
      return out;
    },
    remove: (path) => files.remove(full(path), opts),
    watch(listener) {
      return sharedWatch(files, root, (event) => {
        const mapped: string[] = [];
        for (const path of event.paths) {
          const rel = local(path);
          if (rel) mapped.push(rel);
        }
        if (mapped.length) listener(mapped);
      });
    },
  };
}
