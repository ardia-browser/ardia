import { requireOptionalNativeModule } from "expo-modules-core";
import type { SyncModules } from "./generated/native.ts";
import type { Transport } from "./scopeState.ts";

export type FolderInfo = {
  path: string;
  defaultPath: string;
  iCloudAvailable: boolean;
  inICloud: boolean;
  exists: boolean;
  writable: boolean;
  hasSyncData: boolean;
};

export type PhraseResult =
  | { ok: true }
  | { error: "wordCount"; count: number }
  | { error: "unknownWord"; word: string }
  | { error: "checksum" }
  | { error: "noData" }
  | { error: "mismatch" }
  | { error: "keychain" };

export type SealedLogin = { origin: string; username: string; created: number } & ({ sealed: string; passwordless?: undefined } | { passwordless: true; sealed?: undefined });

export type SyncCore = "rust" | "native";
export type SyncOpenFailure = "format" | "authentication" | "too_large" | "other";

export type SyncNative = SyncModules["ArdiaSync"];

export const SyncNative = requireOptionalNativeModule<SyncModules["ArdiaSync"]>("ArdiaSync");

export const folderTransport = (native: SyncNative, folder: string): Transport => ({
  write: (scope, payload) => native.write(folder, scope, payload),
  read: (scope, known) => native.read(folder, scope, known),
  remove: (scope, ids) => native.remove(folder, scope, ids),
});
