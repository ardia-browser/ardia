import { HOST_METHODS as M, type FileEntry, type FileReadResult, type FilesChange, type FileWriteResult, type FolderGrant, type PickedFile } from "./protocol";
import { PluginError, readReplyBytes, unwrap, type Rpc } from "./rpc";
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from "./bytes";
import type { Disposable, FilesListener, Registry } from "./types";

type RootOption = { root?: string };

const rootOf = (options: RootOption) => (options.root !== undefined ? { root: options.root } : {});

const EARLY_CHANGES_KEPT = 64;

export function deliverFilesChange(registry: Registry, data: Record<string, unknown>, report: (error: unknown) => void) {
  const { watch, root, paths, gone } = data;
  if (typeof watch !== "string") return;
  const rootName = typeof root === "string" ? root : "data";
  const change: FilesChange = gone === true ? { root: rootName, paths: [], gone: true } : { root: rootName, paths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [] };
  const listener = registry.files.listeners.get(watch);
  if (listener && gone === true) registry.files.listeners.delete(watch);
  if (!listener) {
    if (registry.files.pending <= 0) return;
    const early = registry.files.early.get(watch) ?? [];
    if (early.length < EARLY_CHANGES_KEPT) early.push(change);
    registry.files.early.set(watch, early);
    return;
  }
  try {
    listener(change);
  } catch (error) {
    report(error);
  }
}

export function filesApi(rpc: Rpc, registry: Registry, report: (error: unknown) => void) {
  const watches = registry.files;
  const read = async (path: string, options: RootOption & { offset?: number; length?: number } = {}): Promise<FileReadResult> => {
    const res = await rpc.request<FileReadResult>(
      M.filesRead,
      {
        path,
        ...rootOf(options),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
        ...(options.length !== undefined ? { length: options.length } : {}),
      },
      { replyBytes: readReplyBytes(options.length) },
    );
    return res && res.found === true ? { found: true, data: res.data, size: res.size, mtimeMs: res.mtimeMs } : { found: false };
  };
  const write = (path: string, data: string, options: RootOption & { exclusive?: boolean } = {}) =>
    rpc.request<FileWriteResult>(M.filesWrite, { path, data, ...rootOf(options), ...(options.exclusive ? { exclusive: true } : {}) });
  const watch = (listener: FilesListener, options: RootOption = {}): Disposable => {
    let id: string | null = null;
    let disposed = false;
    watches.pending++;
    void rpc
      .request<{ watch?: unknown }>(M.filesWatch, rootOf(options))
      .then((res) => {
        const given = unwrap(res, "watch");
        if (typeof given !== "string") throw new PluginError("failed", "files.watch didn't answer a watch id.");
        if (disposed) return void rpc.request(M.filesUnwatch, { watch: given }).catch(report);
        id = given;
        watches.listeners.set(id, listener);
        const early = watches.early.get(id) ?? [];
        watches.early.delete(id);
        for (const change of early) deliverFilesChange(registry, { watch: id, ...change }, report);
      })
      .catch(report)
      .finally(() => {
        watches.pending--;
        if (watches.pending === 0) watches.early.clear();
      });
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        if (id === null || !watches.listeners.delete(id)) return;
        void rpc.request(M.filesUnwatch, { watch: id }).catch(report);
      },
    };
  };
  return {
    read,
    async readText(path: string, options: RootOption = {}): Promise<string | null> {
      const res = await read(path, rootOf(options));
      return res.found ? utf8Decode(base64ToBytes(res.data)) : null;
    },
    write,
    writeText: (path: string, text: string, options: RootOption & { exclusive?: boolean } = {}) => write(path, bytesToBase64(utf8Encode(text)), options),
    append: (path: string, data: string, options: RootOption = {}) => rpc.request<FileWriteResult>(M.filesAppend, { path, data, ...rootOf(options) }),
    async list(dir = "", options: RootOption & { recursive?: boolean } = {}): Promise<FileEntry[]> {
      const entries = unwrap(await rpc.request(M.filesList, { dir, ...rootOf(options), ...(options.recursive ? { recursive: true } : {}) }), "entries");
      return Array.isArray(entries) ? (entries as FileEntry[]) : [];
    },
    async remove(path: string, options: RootOption = {}): Promise<boolean> {
      return unwrap(await rpc.request(M.filesRemove, { path, ...rootOf(options) }), "removed") === true;
    },
    watch,
    async pick(options: { multiple?: boolean } = {}): Promise<PickedFile[]> {
      const files = unwrap(await rpc.request(M.filesPick, options.multiple ? { multiple: true } : {}), "files");
      return Array.isArray(files) ? (files as PickedFile[]).filter((f) => typeof f?.id === "string" && typeof f.name === "string") : [];
    },
  };
}

export function foldersApi(rpc: Rpc) {
  const folder = (res: unknown): FolderGrant | null => {
    const given = unwrap(res, "folder");
    return typeof given === "object" && given !== null && typeof (given as FolderGrant).id === "string" ? (given as FolderGrant) : null;
  };
  return {
    async list(): Promise<FolderGrant[]> {
      const folders = unwrap(await rpc.request(M.foldersList), "folders");
      return Array.isArray(folders) ? (folders as FolderGrant[]) : [];
    },
    create: async (name: string): Promise<FolderGrant | null> => folder(await rpc.request(M.foldersCreate, { name })),
    pick: async (options: { prompt?: string } = {}): Promise<FolderGrant | null> => folder(await rpc.request(M.foldersPick, options.prompt !== undefined ? { prompt: options.prompt } : {})),
    async share(id: string): Promise<{ ok: boolean }> {
      return { ok: unwrap(await rpc.request(M.foldersShare, { id }), "ok") === true };
    },
    forget: (id: string) => rpc.request(M.foldersForget, { id }).then(() => undefined),
  };
}
