import { resolveSharedFolder, SHARED_FOLDER_REFUSED, type ResolvedSharedFolder } from "../../platform/sharedFolders";
import { boundFolders, sharedFolderOf, upgradeFolder, type SharedFolder } from "./store";

export async function upgradeLegacy(profileId: string, key: string): Promise<SharedFolder | undefined> {
  const was = sharedFolderOf(profileId, key);
  if (!was || was.identity) return was;
  let refused = false;
  const found = await resolveSharedFolder(was.path).catch((error: unknown) => ((refused = (error as { code?: unknown })?.code === SHARED_FOLDER_REFUSED), null));
  if (refused) return undefined;
  if (found) upgradeFolder(profileId, key, was, found);
  return sharedFolderOf(profileId, key);
}

const sameFolder = (folder: SharedFolder, found: ResolvedSharedFolder) =>
  folder.identity ? folder.identity.device === found.device && folder.identity.inode === found.inode : folder.path === found.path;

export async function bindingAt(profileId: string, found: ResolvedSharedFolder) {
  const legacy = boundFolders().filter((b) => b.profileId === profileId && !b.folder.identity);
  await Promise.all(legacy.map((b) => upgradeLegacy(profileId, b.key)));
  return boundAt(profileId, found);
}

export const boundAt = (profileId: string, found: ResolvedSharedFolder) => boundFolders().find((b) => b.profileId === profileId && sameFolder(b.folder, found));
