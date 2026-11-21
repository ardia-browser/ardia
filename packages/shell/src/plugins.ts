import type { EventSubscription } from "expo-modules-core";
import type { ViewProps } from "react-native";

export type PluginFolderEntry = {
  name: string;
  status: "ok" | "missing" | "link" | "notFile" | "tooBig" | "unreadable";
  text?: string;
  folderId?: string;
  bundled?: boolean;
  replacesBundled?: boolean;
  ignoresUserFolder?: boolean;
};

export type PluginProgramsSpec = {
  name: string;
  folderId: string;
  approved: string;
  version: string | null;
  programs: { name: string; path: string; afterUpdate?: string[][] }[];
};
export type PluginProgramRegistry = { claims: Record<string, string>; failClosed: boolean; legacyOwners: string[] };
export type PluginProgramsResult =
  | { ok: true; linked: string[]; refused: Record<string, string>; binDir: string; adopted: boolean; adoptBusy?: boolean }
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
export type PluginExit = { name: string; run: number; status: number | null; signal: number | null; overMemory: boolean };
export type PluginLine = { name: string; run: number; launch: number; line: string };
export type PluginRemoveResult = { ok: true } | { ok: false; reason: string };
export type PluginFetchSpec = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; allowedHosts: string[] };
export type PluginFetchResult =
  | { ok: true; status: number; statusText: string; url: string; headers: Record<string, string>; body: string }
  | { ok: false; reason: string };
export type PluginFileReadResult = { ok: true; text: string } | { ok: false; reason: string };
export type PluginStorageReadResult = { status: "ok"; text: string } | { status: "missing" } | { status: "error"; reason: string };

export type PluginsNative = {
  folder(): string;
  list(): Promise<PluginFolderEntry[]>;
  start(spec: PluginStartSpec): Promise<PluginStartResult>;
  stop(name: string, run: number, graceMs: number): Promise<void>;
  reply(name: string, run: number, line: string): void;
  event(name: string, run: number, line: string): void;
  call(name: string, run: number, line: string): void;
  remove(name: string): Promise<PluginRemoveResult>;
  linkPrograms(spec: PluginProgramsSpec): Promise<PluginProgramsResult>;
  unlinkPrograms(name: string, programs: string[], remove: boolean): Promise<{ ok: boolean }>;
  sweepPrograms(active: string[]): Promise<void>;
  legacyProgramsInstalled(): Promise<string[]>;
  programRegistry(): Promise<PluginProgramRegistry>;
  revealLog(name: string): void;
  revealFolder(): void;
  devSnapshotPage(name: string, path: string): Promise<boolean>;
  hostFetch(spec: PluginFetchSpec): Promise<PluginFetchResult>;
  storageRead(name: string): Promise<PluginStorageReadResult>;
  storageWrite(name: string, text: string): Promise<{ ok: boolean; reason?: string }>;
  readPluginFile(name: string, folderId: string, approved: string, path: string): Promise<PluginFileReadResult>;
  addListener(name: "onLine", listener: (e: PluginLine) => void): EventSubscription;
  addListener(name: "onExit", listener: (e: PluginExit) => void): EventSubscription;
};

export type PluginPageEvent<T> = { nativeEvent: T };

export type PluginPageProps = ViewProps & {
  plugin: string;
  url: string;
  network: boolean;
  folderId: string;
  approved: string;
  run: number;
  context: string;
  themeCss?: string;
  onLoaded?: (e: PluginPageEvent<{ url: string; title: string }>) => void;
  onTitleChange?: (e: PluginPageEvent<{ title: string }>) => void;
  onNavigationChange?: (e: PluginPageEvent<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean }>) => void;
  onMessage?: (e: PluginPageEvent<{ body: string }>) => void;
};
