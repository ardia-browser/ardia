import type { EventSubscription } from "expo-modules-core";
import type { ViewProps } from "react-native";
import type { PluginsNative } from "./generated/native";

export type PluginFolderEntry = {
  name: string;
  status: "ok" | "missing" | "link" | "notFile" | "tooBig" | "unreadable";
  text?: string;
  folderId?: string;
  official?: boolean;
  legacy?: boolean;
  legacyHash?: string;
  candidateOnly?: boolean;
  candidate?: OfficialCandidate;
  autoInstall?: boolean;
  ignoresUserFolder?: boolean;
};

export type OfficialCandidate = { folderId: string; text: string; legacyHash: string; version: string };
export type OfficialPinned = { name: string; version: string; folderId: string };
type OfficialFetchCode = "offline" | "failed" | "verify" | "cancelled" | "unsupported";
export type OfficialFetchResult = { ok: true; candidate: OfficialCandidate; reused?: boolean } | { ok: false; code: OfficialFetchCode; reason: string; cause?: string };
export type OfficialFetchProgress = { name: string; received: number; total: number };

export type PluginProgramsSpec = {
  name: string;
  folderId: string;
  approved: string;
  version: string | null;
  programs: { name: string; path: string; afterUpdate?: string[][] }[];
};
export type PluginAfterUpdateQuitStops = { consent: string; exitedOnTerm: number; killed: number };
export type PluginProgramRegistry = { claims: Record<string, string>; failClosed: boolean; legacyOwners: string[] };
export type PluginProgramsResult =
  | { ok: true; linked: string[]; refused: Record<string, string>; causes?: Record<string, string>; binDir: string; adopted: boolean; adoptBusy?: boolean; kept?: string }
  | { ok: false; reason?: string; stale?: true };

export type PluginStartSpec = {
  name: string;
  run: string[];
  memoryMB: number;
  network: boolean;
  folderId: string;
  approved: string;
  page: boolean;
  launch: number;
  runtime?: "js" | "process";
  entry?: string;
};
export type PluginStartResult = { ok: true; run: number; pid: number } | { ok: false; reason: string };
export type PluginExit = { name: string; run: number; status: number | null; signal: number | null; overMemory: boolean; channelRetired?: string | null };
export type PluginLine = { name: string; run: number; launch: number; line: string };
export type PluginRemoveResult = { ok: true } | { ok: false; reason: string };
export type PluginFetchSpec = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; allowedHosts: string[] };
export type PluginFetchResult =
  | { ok: true; status: number; statusText: string; url: string; headers: Record<string, string>; body: string }
  | { ok: false; reason: string };
export type PluginFileReadResult = { ok: true; text: string } | { ok: false; reason: string };
export type PluginStorageReadResult = { status: "ok"; text: string } | { status: "missing" } | { status: "error"; reason: string };
export type PluginFilesSpec = {
  op: "read" | "write" | "append" | "list" | "remove" | "stat" | "stage" | "publish" | "discard";
  plugin: string;
  root: string | null;
  path: string;
  data?: string;
  offset?: number;
  length?: number;
  exclusive?: boolean;
  recursive?: boolean;
  stage?: string;
  first?: boolean;
  operation?: string;
  rootIdentity?: PluginFolderIdentity;
  fileIdentity?: PluginFolderIdentity;
  stageIdentity?: PluginFolderIdentity;
  ticket: number;
};
export type PluginFolderIdentity = { device: number; inode: number };
export type PluginFolderCreateResult =
  | { ok: true; path: string; realPath: string; device: number; inode: number; location: "icloud" | "other" }
  | { ok: false; code: PluginFilesCode; message: string };
export type PluginFilesEntry = { path: string; kind: "file" | "dir"; size: number; mtimeMs: number; placeholder: boolean };
export type PluginFilesCode = "not_found" | "exists" | "too_large" | "bad_path" | "refused" | "unavailable";
export type PluginFilesResult =
  | { ok: true; found?: boolean; data?: string; size?: number; mtimeMs?: number; removed?: boolean; entries?: PluginFilesEntry[]; kind?: "file" | "dir"; device?: number; inode?: number }
  | { ok: false; code: PluginFilesCode; message: string };
export type PluginFolderInfo = { exists: boolean; realPath: string; location: "icloud" | "other"; protected: boolean; device?: number; inode?: number };

export type { PluginsNative };

type PluginPageEvent<T> = { nativeEvent: T };

export type PluginPageProps = ViewProps & {
  plugin: string;
  url: string;
  network: boolean;
  folderId: string;
  approved: string;
  run: number;
  context: string;
  themeCss?: string;
  routes?: boolean;
  routePath?: string;
  tabId?: string;
  onNavigate?: (e: PluginPageEvent<{ body: string }>) => void;
  onLoaded?: (e: PluginPageEvent<{ url: string; title: string }>) => void;
  onTitleChange?: (e: PluginPageEvent<{ title: string }>) => void;
  onNavigationChange?: (e: PluginPageEvent<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean }>) => void;
  onMessage?: (e: PluginPageEvent<{ body: string }>) => void;
};
