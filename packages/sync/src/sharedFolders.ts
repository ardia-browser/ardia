import { requireOptionalNativeModule } from "expo-modules-core";

export type SharedListingEntry =
  | { kind: "link"; file: string; text: string }
  | { kind: "pending"; file: string; reason: "download" | "unreadable" }
  | { kind: "dir"; file: string; level: SharedListingLevel };

export type SharedListingLevel = { entries: SharedListingEntry[]; manifest: string | null; manifestPending: boolean; error?: string };

export type SharedListing = { exists: false; error?: string } | { exists: true; root: SharedListingLevel };

export type SharedFolderOp =
  | { op: "write"; path: string; text: string; create: boolean; expect: string | null }
  | { op: "move"; path: string; to: string }
  | { op: "delete"; path: string; expect: string }
  | { op: "mkdir"; path: string }
  | { op: "rmdir"; path: string };

export type SharedLocation = { path: string; iCloudAvailable: boolean; iCloudPath: string };

export type SharedFolderIdentity = { device: number; inode: number };

export type ResolvedSharedFolder = SharedFolderIdentity & { path: string };

export const SHARED_FOLDER_REFUSED = "ERR_SHARED_FOLDER_REFUSED";

type SharedFoldersNative = {
  location(): SharedLocation;
  read(path: string, identity: SharedFolderIdentity | null): Promise<SharedListing>;
  apply(path: string, ops: string, identity: SharedFolderIdentity | null): Promise<{ conflicts: string[] }>;
  create(parent: string, parentIdentity: SharedFolderIdentity | null, name: string): Promise<ResolvedSharedFolder>;
  resolve(path: string): Promise<ResolvedSharedFolder>;
  discard(path: string, identity: SharedFolderIdentity): Promise<boolean>;
  watch(paths: string[]): void;
  addListener(name: "onChange", listener: (event: { paths: string[] }) => void): { remove(): void };
};

export const SharedFoldersNative = requireOptionalNativeModule<SharedFoldersNative>("ArdiaSharedFolders");
