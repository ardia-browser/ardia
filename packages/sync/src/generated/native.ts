import type { FolderInfo, PhraseResult, SealedLogin, SyncCore, SyncOpenFailure } from "../native.ts";
import type { Listing } from "../scopeState.ts";
import type { ResolvedSharedFolder, SharedFolderIdentity, SharedListing, SharedLocation } from "../sharedFolders.ts";

export type SyncNative = {
  core?: SyncCore | (() => Promise<string>);
  folderInfo(path: string | null): Promise<FolderInfo>;
  chooseFolder(current: string | null): Promise<string | null>;
  newDeviceId(): string;
  takeOpenFailures?(): Partial<Record<SyncOpenFailure, number>>;
  deviceName(): string;
  createPhrase(account: string): Promise<boolean>;
  enterPhrase(account: string, text: string, folder: string): Promise<PhraseResult>;
  unlock(account: string): Promise<boolean>;
  forget(account: string): Promise<void>;
  chainStatus(folder: string): Promise<"ok" | "missing" | "unavailable">;
  createChain(folder: string): Promise<void>;
  write(folder: string, scope: string, payload: string): Promise<string>;
  read(folder: string, scope: string, known: string[]): Promise<Listing>;
  remove(folder: string, scope: string, ids: string[]): Promise<void>;
  deleteChain(folder: string): Promise<void>;
  sealLocal(text: string): Promise<string>;
  openLocal(sealed: string): Promise<string | null>;
  recoveryWords(): Promise<string[] | null>;
  qrCode(): Promise<string | null>;
  recoveryKitPreview(width: number): Promise<string | null>;
  saveRecoveryKit(format: "pdf" | "text"): Promise<string | null>;
  copyRecoveryKit(): Promise<boolean | null>;
  shareRecoveryKit(): Promise<boolean | null>;
  copyRecoveryPhrase(): Promise<boolean | null>;
  revealFolder(path: string): Promise<void>;
  readPasswords(engineProfile: string): Promise<SealedLogin[] | null>;
  savePassword(engineProfile: string, origin: string, username: string, sealed: string, replacing: boolean): Promise<boolean>;
  takeFileCounts?(): { placeholders: number; busy: number; hydrated: number };
};

export type SharedFoldersNative = {
  location(): SharedLocation;
  read(path: string, identity: SharedFolderIdentity | null): Promise<SharedListing>;
  apply(path: string, ops: string, identity: SharedFolderIdentity | null): Promise<{ conflicts: string[] }>;
  resolve(path: string): Promise<ResolvedSharedFolder>;
  discard(path: string, identity: SharedFolderIdentity): Promise<boolean>;
  create(parent: string, parentIdentity: SharedFolderIdentity | null, name: string): Promise<ResolvedSharedFolder>;
  watch(paths: string[]): void;
  addListener(name: "onChange", listener: (event: SharedFoldersNativeEvents["onChange"]) => void): { remove(): void };
};

export type SharedFoldersNativeEvents = {
  onChange: { paths: string[] };
};

export type SyncModules = {
  ArdiaSync: SyncNative;
  ArdiaSharedFolders: SharedFoldersNative;
};
