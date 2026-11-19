import { SharedFoldersNative, SyncNative, type ResolvedSharedFolder, type SharedFolderIdentity, type SharedFolderOp } from "@ardia/sync";

export { SHARED_FOLDER_REFUSED } from "@ardia/sync";

export type { ResolvedSharedFolder, SharedFolderIdentity, SharedFolderOp, SharedListing, SharedListingEntry, SharedListingLevel, SharedLocation } from "@ardia/sync";

const Native = () => SharedFoldersNative!;

export const sharedFoldersAvailable = () => !!SharedFoldersNative;
export const sharedLocation = () => Native().location();
export const readSharedFolder = (path: string, identity: SharedFolderIdentity) => Native().read(path, identity);
export const writeSharedFolder = (path: string, ops: SharedFolderOp[], identity: SharedFolderIdentity, token: string) => Native().apply(path, JSON.stringify(ops), identity, token);
export const cancelSharedFolderWrite = (token: string) => Native().cancel(token);
export const identityOf = (folder: ResolvedSharedFolder): SharedFolderIdentity => ({ device: folder.device, inode: folder.inode });
export const resolveSharedFolder = async (path: string) => Native().resolve(path);
export const discardSharedFolder = async (folder: ResolvedSharedFolder) => Native().discard(folder.path, identityOf(folder));
export const createSharedFolder = async (parent: string, name: string, parentIdentity: SharedFolderIdentity | null = null) => Native().create(parent, parentIdentity, name);
export const watchSharedFolders = (paths: string[]) => Native().watch(paths);
export const onSharedFolderChange = (listener: (paths: string[]) => void) => Native().addListener("onChange", (e) => listener(e.paths));
export const revealSharedFolder = (path: string) => SyncNative!.revealFolder(path);
