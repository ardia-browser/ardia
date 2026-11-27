import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { FileEntry, FilesApi, FolderGrant, FoldersApi } from "../../src/main/files";

type Watcher = { root: string; listener: (e: { root: string; paths: string[] }) => void };

const watchersByDir = new Map<string, Set<Watcher>>();
const hiddenByDir = new Map<string, Set<string>>();
let tmpSeq = 0;

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

function safe(path: string): string {
  const clean = path.replace(/^\/+/, "");
  if (clean.split("/").some((p) => p === ".." || p === ".")) fail("refused", `bad path ${path}`);
  return clean;
}

export type NodeFiles = FilesApi & {
  roots: Map<string, string>;
  hide(root: string, path: string): void;
  reveal(root: string, path: string): void;
  emit(root: string, paths: string[]): void;
  calls: number;
  bytesRead: number;
  faults: { mutate?: (root: string, path: string, data: Buffer) => Buffer | Uint8Array; delay?: (root: string, path: string) => number; append?: (root: string, path: string, size: number) => number | null; write?: (root: string, path: string, size: number) => boolean; read?: (root: string, path: string) => boolean; list?: (root: string, path: string) => boolean };
  detach(): void;
};

export function nodeFiles(roots: Record<string, string>, options: { latencyMs?: number } = {}): NodeFiles {
  const map = new Map(Object.entries(roots));
  const mine = new Set<Watcher>();
  const dirOf = (root?: string) => {
    const dir = map.get(root ?? "data");
    if (!dir) fail("refused", `no root ${root}`);
    if (!existsSync(dir)) fail("unavailable", `root ${root} is gone`);
    return dir;
  };
  const hidden = (dir: string) => {
    let set = hiddenByDir.get(dir);
    if (!set) hiddenByDir.set(dir, (set = new Set()));
    return set;
  };
  const notify = (dir: string, paths: string[]) => {
    const set = watchersByDir.get(dir);
    if (!set) return;
    for (const w of [...set]) setTimeout(() => w.listener({ root: w.root, paths }), 1);
  };
  const pause = async (ms: number) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; ) await new Promise((r) => setTimeout(r, Math.min(5, Math.max(1, deadline - Date.now()))));
  };
  const delay = () => pause(options.latencyMs ?? 0);
  const api: NodeFiles = {
    roots: map,
    calls: 0,
    bytesRead: 0,
    faults: {},
    async read(path, opts = {}) {
      api.calls++;
      await delay();
      const dir = dirOf(opts.root);
      const p = safe(path);
      if (hidden(dir).has(p) || api.faults.read?.(opts.root ?? "data", p)) fail("unavailable", `${p} is in iCloud`);
      const full = join(dir, p);
      if (!existsSync(full) || statSync(full).isDirectory()) return { found: false };
      const fd = openSync(full, "r");
      try {
        const st = fstatSync(fd);
        const offset = Math.min(opts.offset ?? 0, st.size);
        const length = Math.max(0, Math.min(opts.length ?? st.size - offset, st.size - offset, 4 * 1024 * 1024));
        const buf = Buffer.alloc(length);
        if (length) readSync(fd, buf, 0, length, offset);
        api.bytesRead += length;
        return { found: true, data: buf.toString("base64"), size: st.size, mtimeMs: st.mtimeMs };
      } finally {
        closeSync(fd);
      }
    },
    async readText(path, opts = {}) {
      const res = await api.read(path, opts);
      return res.found ? Buffer.from(res.data, "base64").toString("utf8") : null;
    },
    async write(path, base64, opts = {}) {
      api.calls++;
      await delay();
      const dir = dirOf(opts.root);
      const p = safe(path);
      const full = join(dir, p);
      mkdirSync(dirname(full), { recursive: true });
      const given = Buffer.from(base64, "base64");
      const mutated = api.faults.mutate?.(opts.root ?? "data", p, given);
      const data = mutated ? Buffer.from(mutated) : given;
      const extra = api.faults.delay?.(opts.root ?? "data", p) ?? 0;
      if (extra) await pause(extra);
      if (data.length > 4 * 1024 * 1024) fail("too_large", "over 4 MB");
      if (api.faults.write?.(opts.root ?? "data", p, data.length)) fail("unavailable", `writing ${p} failed`);
      if (opts.exclusive && existsSync(full)) fail("exists", `${p} exists`);
      const tmp = join(dirname(full), `.${p.split("/").pop()}.ardia-${process.pid}-${++tmpSeq}`);
      writeFileSync(tmp, data);
      if (opts.exclusive && existsSync(full)) {
        rmSync(tmp);
        fail("exists", `${p} exists`);
      }
      renameSync(tmp, full);
      hidden(dir).delete(p);
      const st = statSync(full);
      notify(dir, [p]);
      return { size: st.size, mtimeMs: st.mtimeMs };
    },
    async writeText(path, text, opts = {}) {
      return api.write(path, Buffer.from(text, "utf8").toString("base64"), opts);
    },
    async append(path, base64, opts = {}) {
      api.calls++;
      await delay();
      const dir = dirOf(opts.root);
      const p = safe(path);
      const full = join(dir, p);
      mkdirSync(dirname(full), { recursive: true });
      const bytes = Buffer.from(base64, "base64");
      const torn = api.faults.append?.(opts.root ?? "data", p, bytes.length) ?? null;
      if (torn !== null) {
        if (torn > 0) appendFileSync(full, bytes.subarray(0, torn));
        if (torn > 0) notify(dir, [p]);
        fail("unavailable", `appending to ${p} failed after ${Math.max(0, torn)} bytes`);
      }
      appendFileSync(full, bytes);
      const st = statSync(full);
      notify(dir, [p]);
      return { size: st.size, mtimeMs: st.mtimeMs };
    },
    async list(dirPath = "", opts = {}) {
      api.calls++;
      await delay();
      const slow = api.faults.delay?.(opts.root ?? "data", `${dirPath}/`) ?? 0;
      if (slow) await pause(slow);
      const dir = dirOf(opts.root);
      if (api.faults.list?.(opts.root ?? "data", dirPath)) fail("unavailable", `listing ${dirPath} failed`);
      const base = join(dir, safe(dirPath));
      if (!existsSync(base)) fail("not_found", `there's no folder ${dirPath}`);
      const out: FileEntry[] = [];
      const walk = (abs: string) => {
        for (const name of readdirSync(abs)) {
          if (/\.ardia-/.test(name)) continue;
          const full = join(abs, name);
          const st = statSync(full);
          const rel = relative(dir, full).split("\\").join("/");
          const isHidden = hidden(dir).has(rel);
          out.push({ path: rel, kind: st.isDirectory() ? "dir" : "file", size: isHidden ? 0 : st.size, mtimeMs: isHidden ? 0 : st.mtimeMs, placeholder: isHidden });
          if (st.isDirectory() && opts.recursive) walk(full);
        }
      };
      walk(base);
      return out;
    },
    async remove(path, opts = {}) {
      api.calls++;
      const dir = dirOf(opts.root);
      const full = join(dir, safe(path));
      if (!existsSync(full)) return false;
      if (statSync(full).isDirectory()) rmdirSync(full);
      else rmSync(full, { recursive: false, force: true });
      notify(dir, [safe(path)]);
      return true;
    },
    watch(listener, opts = {}) {
      const root = opts.root ?? "data";
      const dir = map.get(root);
      const w: Watcher = { root, listener };
      if (dir) {
        let set = watchersByDir.get(dir);
        if (!set) watchersByDir.set(dir, (set = new Set()));
        set.add(w);
        mine.add(w);
      }
      return {
        dispose() {
          if (dir) watchersByDir.get(dir)?.delete(w);
          mine.delete(w);
        },
      };
    },
    hide(root, path) {
      const dir = map.get(root)!;
      hidden(dir).add(safe(path));
    },
    reveal(root, path) {
      const dir = map.get(root)!;
      hidden(dir).delete(safe(path));
      notify(dir, [safe(path)]);
    },
    emit(root, paths) {
      notify(map.get(root)!, paths);
    },
    detach() {
      for (const w of mine) for (const set of watchersByDir.values()) set.delete(w);
      mine.clear();
    },
  };
  return api;
}

export function fakeFolders(files: NodeFiles, sharedRoot: string, pickQueue: (FolderGrant | null)[] = []): FoldersApi & { shared: string[]; pickQueue: (FolderGrant | null)[] } {
  const grants = new Map<string, FolderGrant>();
  const out = {
    shared: [] as string[],
    pickQueue,
    async list() {
      return [...grants.values()].map((g) => ({ ...g, available: existsSync(files.roots.get(g.id)!) }));
    },
    async create(name: string) {
      const id = `g${grants.size + 1}-${Math.random().toString(16).slice(2, 8)}`;
      const dir = join(sharedRoot, `${name}-${id}`);
      mkdirSync(dir, { recursive: true });
      files.roots.set(id, dir);
      const grant: FolderGrant = { id, name, location: "icloud", available: true };
      grants.set(id, grant);
      return grant;
    },
    async pick() {
      const next = out.pickQueue.shift() ?? null;
      if (next) grants.set(next.id, next);
      return next;
    },
    async share(id: string) {
      out.shared.push(id);
      return { ok: grants.has(id) };
    },
    async forget(id: string) {
      grants.delete(id);
      return null;
    },
  };
  return out;
}

export function grantFor(files: NodeFiles, id: string, dir: string, name: string): FolderGrant {
  files.roots.set(id, dir);
  return { id, name, location: "icloud", available: true };
}

export function writeRaw(path: string, data: Uint8Array | string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export function readRaw(path: string): Buffer {
  return readFileSync(path);
}
