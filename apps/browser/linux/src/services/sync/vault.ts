import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isTag, newFileId, type SyncKeys } from "./crypto.ts";
import { hidePasswords, restorePasswords } from "./logins.ts";

export const FILE_EXTENSION = ".nns";
export const FOLDER_UNREADABLE = "ERR_SYNC_FOLDER_UNREADABLE";

export type Listing = { files: { id: string; payload: string }[]; pending: string[]; damaged: { id: string; age: number }[]; present: string[] };
export type FolderState = { exists: boolean; writable: boolean; hasSyncData: boolean };
export type ChainStatus = "ok" | "missing" | "unavailable";

const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const isMissing = (error: unknown) => code(error) === "ENOENT" || code(error) === "ENOTDIR";
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function failure(message: string, errorCode?: string): Error & { code?: string } {
  return Object.assign(new Error(message), errorCode ? { code: errorCode } : {});
}

async function kindOf(path: string): Promise<"directory" | "absent" | "other"> {
  try {
    return (await lstat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
}

const isDirectory = async (path: string) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

export async function hasSyncData(folder: string): Promise<boolean> {
  try {
    return (await readdir(folder)).some(isTag);
  } catch {
    return false;
  }
}

export async function folderState(folder: string): Promise<FolderState> {
  const exists = await isDirectory(folder);
  if (!exists) return { exists, writable: false, hasSyncData: false };
  const writable = await access(folder, constants.W_OK | constants.X_OK).then(
    () => true,
    () => false,
  );
  return { exists, writable, hasSyncData: await hasSyncData(folder) };
}

async function writeDurably(directory: string, name: string, bytes: Uint8Array, mode = 0o644): Promise<void> {
  const staging = join(directory, `.${name}.${process.pid}.tmp`);
  const handle = await open(staging, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(staging, join(directory, name));
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  const folder = await open(directory, "r").catch(() => null);
  await folder?.sync().catch(() => {});
  await folder?.close();
}

export async function saveFile(path: string, bytes: Uint8Array, mode = 0o644): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (!path.startsWith("/") || slash === path.length - 1) throw failure("not a file path");
  await writeDurably(path.slice(0, slash) || "/", path.slice(slash + 1), bytes, mode);
}

export class SyncVault {
  readonly folder: string;
  readonly keys: SyncKeys;

  constructor(folder: string, keys: SyncKeys) {
    this.folder = folder.length > 1 ? folder.replace(/\/+$/, "") : folder;
    this.keys = keys;
    if (!this.folder.startsWith("/")) throw failure("not a sync folder path");
  }

  get chainPath(): string {
    return join(this.folder, this.keys.chainTag);
  }

  scopePath(scope: string): string {
    return join(this.chainPath, this.keys.scopeTag(scope));
  }

  async chainStatus(): Promise<ChainStatus> {
    if (!(await isDirectory(this.folder))) return "unavailable";
    try {
      const kind = await kindOf(this.chainPath);
      return kind === "directory" ? "ok" : kind === "absent" ? "missing" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async chainExists(): Promise<boolean> {
    return (await kindOf(this.chainPath).catch(() => "other")) === "directory";
  }

  async createChain(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    await mkdir(this.chainPath).catch((error: unknown) => {
      if (code(error) !== "EEXIST") throw error;
    });
    if ((await kindOf(this.chainPath)) !== "directory") throw failure("the sync folder holds a link where sync data belongs");
  }

  async deleteChain(): Promise<void> {
    if ((await kindOf(this.chainPath)) !== "directory") return;
    await rm(this.chainPath, { recursive: true, force: true });
  }

  private async scopeDirectory(scope: string, create: boolean): Promise<string | null> {
    const chain = await kindOf(this.chainPath);
    if (chain === "other") throw failure("the sync folder holds a link where sync data belongs");
    if (chain === "absent") throw failure("the sync folder isn't reachable");
    const path = this.scopePath(scope);
    const kind = await kindOf(path);
    if (kind === "other") throw failure("the sync folder holds a link where sync data belongs");
    if (kind === "absent") {
      if (!create) return null;
      await mkdir(path).catch((error: unknown) => {
        if (code(error) !== "EEXIST") throw error;
      });
    }
    return path;
  }

  async write(scope: string, payload: string): Promise<string> {
    const directory = await this.scopeDirectory(scope, true);
    if (!directory) throw failure("the sync folder isn't reachable");
    const id = newFileId();
    const sealed = this.keys.seal(Buffer.from(restorePasswords(payload, this.keys), "utf8"), this.keys.scopeTag(scope), id);
    await writeDurably(directory, `${id}${FILE_EXTENSION}`, sealed);
    return id;
  }

  async remove(scope: string, ids: string[]): Promise<void> {
    if ((await kindOf(this.chainPath)) === "absent") return;
    const directory = await this.scopeDirectory(scope, false);
    if (!directory) return;
    const failed: string[] = [];
    for (const id of ids) {
      if (!isTag(id)) continue;
      try {
        await unlink(join(directory, `${id}${FILE_EXTENSION}`));
      } catch (error) {
        if (!isMissing(error)) failed.push(id);
      }
    }
    if (failed.length) throw failure(`Couldn't remove ${failed.length} sync file${failed.length === 1 ? "" : "s"}`);
  }

  async read(scope: string, known: string[], now = Date.now()): Promise<Listing> {
    const listing: Listing = { files: [], pending: [], damaged: [], present: [] };
    let names: string[];
    try {
      const directory = await this.scopeDirectory(scope, false);
      if (!directory) return listing;
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return listing;
      throw failure(`The sync folder couldn't be read: ${reason(error)}`, FOLDER_UNREADABLE);
    }
    const skip = new Set(known);
    const seen = new Set<string>();
    const scopeTag = this.keys.scopeTag(scope);
    const directory = this.scopePath(scope);
    for (const name of names.sort()) {
      if (!name.endsWith(FILE_EXTENSION)) continue;
      const id = name.slice(0, -FILE_EXTENSION.length);
      if (!isTag(id) || seen.has(id)) continue;
      seen.add(id);
      if (skip.has(id)) {
        listing.present.push(id);
        continue;
      }
      const path = join(directory, name);
      let bytes: Buffer;
      let modified = now;
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        modified = info.mtimeMs;
        bytes = await readFile(path);
      } catch (error) {
        if (isMissing(error)) continue;
        listing.present.push(id);
        listing.damaged.push({ id, age: 0 });
        continue;
      }
      listing.present.push(id);
      let plain: string;
      try {
        plain = this.keys.open(bytes, scopeTag, id).toString("utf8");
      } catch {
        listing.damaged.push({ id, age: Math.max(0, now - modified) });
        continue;
      }
      const hidden = hidePasswords(plain, this.keys);
      if (hidden === null) listing.damaged.push({ id, age: 0 });
      else listing.files.push({ id, payload: hidden });
    }
    return listing;
  }
}
