import type { EventSubscription } from "expo-modules-core";
import type { ViewProps } from "react-native";

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
export type OfficialPinned = {
  name: string;
  version: string;
  folderId: string;
  credentialPrograms?: string[];
  title?: string;
  blurb?: string;
  icon?: string;
  symbol?: string;
  accent?: string;
};
export type OfficialFetchCode = "offline" | "failed" | "verify" | "cancelled" | "unsupported";
export type OfficialFetchResult = { ok: true; candidate: OfficialCandidate; reused?: boolean } | { ok: false; code: OfficialFetchCode; reason: string };
export type OfficialFetchProgress = { name: string; received: number; total: number };

export type PluginProgramsSpec = {
  name: string;
  folderId: string;
  approved: string;
  version: string | null;
  programs: { name: string; path: string; afterUpdate?: string[][] }[];
};
export type PluginAfterUpdateQuitStops = { consent: string; exitedOnTerm: number; killed: number };
export type PluginProgramRegistry = { claims: Record<string, string>; failClosed: boolean; legacyOwners: string[]; providers?: Record<string, string> };
export type CredentialProviderResult = { ok: boolean; reason?: string };
export type CredentialRunWanted = { name: string };
export type PluginProgramsResult =
  | { ok: true; linked: string[]; refused: Record<string, string>; binDir: string; adopted: boolean; adoptBusy?: boolean; kept?: string }
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
export type PluginExit = { name: string; run: number; status: number | null; signal: number | null; overMemory: boolean; intended?: boolean };
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
  remove(name: string, official: boolean, folderId: string | null): Promise<PluginRemoveResult>;
  linkPrograms(spec: PluginProgramsSpec): Promise<PluginProgramsResult>;
  unlinkPrograms(name: string, programs: string[], remove: boolean): Promise<{ ok: boolean }>;
  sweepPrograms(active: string[]): Promise<void>;
  takeAfterUpdateQuitStops(): Promise<PluginAfterUpdateQuitStops>;
  setAfterUpdateQuitConsent(consent: string): void;
  legacyProgramsInstalled(): Promise<string[]>;
  programRegistry(): Promise<PluginProgramRegistry>;
  revealLog(name: string): void;
  revealFolder(): void;
  devSnapshotPage(name: string, path: string): Promise<boolean>;
  officialPlugins(): Promise<OfficialPinned[] | null>;
  fetchOfficial(name: string): Promise<OfficialFetchResult>;
  cancelOfficialFetch(name: string): void;
  promoteOfficial(name: string, folderId: string, approved: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  hostFetch(spec: PluginFetchSpec): Promise<PluginFetchResult>;
  storageRead(name: string): Promise<PluginStorageReadResult>;
  storageWrite(name: string, text: string): Promise<{ ok: boolean; reason?: string }>;
  readPluginFile(name: string, folderId: string, approved: string, path: string): Promise<PluginFileReadResult>;
  setCredentialProvider(name: string, enabled: boolean): Promise<CredentialProviderResult>;
  forgetCredentialProvider(name: string): Promise<CredentialProviderResult>;
  addListener(name: "onLine", listener: (e: PluginLine) => void): EventSubscription;
  addListener(name: "onExit", listener: (e: PluginExit) => void): EventSubscription;
  addListener(name: "onOfficialFetch", listener: (e: OfficialFetchProgress) => void): EventSubscription;
  addListener(name: "onCredentialRunWanted", listener: (e: CredentialRunWanted) => void): EventSubscription;
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
