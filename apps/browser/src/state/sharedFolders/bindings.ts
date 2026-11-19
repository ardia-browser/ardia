import type { ResolvedSharedFolder, SharedFolderIdentity } from "../../platform/sharedFolders";
import { boundFolders, type SharedFolder } from "./store";

const sameIdentity = (a: SharedFolderIdentity | undefined, b: SharedFolderIdentity) => !!a && a.device === b.device && a.inode === b.inode;

const sameFolder = (folder: SharedFolder, found: ResolvedSharedFolder) => (folder.identity ? sameIdentity(folder.identity, found) : folder.path === found.path);

export async function bindingAt(profileId: string, found: ResolvedSharedFolder) {
  return boundFolders().find((b) => b.profileId === profileId && sameFolder(b.folder, found));
}

export const boundWithIdentity = (found: SharedFolderIdentity) => boundFolders().find((b) => sameIdentity(b.folder.identity, found));

export const addKey = (found: SharedFolderIdentity) => `${found.device}:${found.inode}`;

const locks = new Map<string, Promise<unknown>>();

export function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(work);
  const held = mine.catch(() => undefined);
  locks.set(key, held);
  void held.then(() => {
    if (locks.get(key) === held) locks.delete(key);
  });
  return mine;
}
