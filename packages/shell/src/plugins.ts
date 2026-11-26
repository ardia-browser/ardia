import type { EventSubscription } from "expo-modules-core";
import type { ViewProps } from "react-native";
import type { PluginsNative } from "./generated/native";

export type PluginSource = "local" | "store" | "dev";

export type PluginStoreCandidate = { folderId: string; text: string; version: string };

export type PluginFolderEntry = {
  name: string;
  status: "ok" | "missing" | "link" | "notFile" | "tooBig" | "unreadable" | "unchecked";
  reason?: string;
  source: PluginSource;
  text?: string;
  folderId?: string;
  candidates?: PluginStoreCandidate[];
  previous?: PluginStoreCandidate;
  devPath?: string;
  shadowsStore?: boolean;
};

export type PluginArtifactSpec = { name: string; id: string; version: string; url: string; sha256: string; sizeBytes: number; officialSig?: string; platform?: string };
type PluginArtifactCode = "offline" | "failed" | "verify" | "cancelled" | "unsupported";
export type PluginArtifactResult = { ok: true; candidate: PluginStoreCandidate & { payloadDigest: string }; reused?: boolean; official?: boolean } | { ok: false; code: PluginArtifactCode; reason: string; cause?: string };
export type PluginArtifactProgress = { name: string; received: number; total: number };
export type PluginLocalInstallResult = { ok: true; name: string; id: string; source: PluginSource; sha256?: string; candidate?: PluginStoreCandidate } | { ok: false; reason: string };
export type PluginStoreSwitchResult = { ok: true; folderId?: string } | { ok: false; reason: string };
export type PluginLegacyAdoption = { ok: boolean; found: boolean; moved: string[]; leftover?: boolean; reason?: string };

export type PluginProgramsSpec = {
  name: string;
  folderId: string;
  approved: string;
  version: string | null;
  programs: { name: string; path: string; afterUpdate?: string[][] }[];
};
export type PluginAfterUpdateQuitStops = { consent: string; exitedOnTerm: number; killed: number };
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
  sidecar?: boolean;
};
export type PluginStartResult = { ok: true; run: number; pid: number } | { ok: false; reason: string };
export type PluginExit = { name: string; run: number; status: number | null; signal: number | null; overMemory: boolean };
export type PluginLine = { name: string; run: number; launch: number; line: string };
export type PluginRemoveResult = { ok: true } | { ok: false; reason: string };
export type PluginFetchSpec = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; allowedHosts: string[] };
export type PluginFetchResult =
  | { ok: true; status: number; statusText: string; url: string; headers: Record<string, string>; body: string }
  | { ok: false; reason: string };
export type PluginStreamSpec = PluginFetchSpec & { name: string; run: number; stream: string };
export type PluginStreamHead = { ok: true; status: number; statusText: string; url: string; headers: Record<string, string> } | { ok: false; reason: string };
export type PluginSocketSpec = { name: string; run: number; socket: string; url: string; protocols: string[]; headers: Record<string, string>; allowedHosts: string[] };
export type PluginSocketOpen = { ok: true; open: boolean; protocol: string } | { ok: false; reason: string };
export type PluginNetOutcome = { ok: true } | { ok: false; reason: string };
export type PluginUsageRow = { name: string; run: number; memoryBytes: number; cpuMs: number; streams: number; sockets: number };
export type PluginAuthSpec = { plugin: string; run: number; scope: string; pluginName: string; authorizeUrl: string; clientId: string; scopes: string[]; extraParams: Record<string, string> };
export type PluginAuthResult = { ok: true; code: string; verifier: string; redirectUri: string } | { ok: false; reason: string; cancelled?: boolean };
export type PluginPickSpec = { name: string; run: number; multiple: boolean; types: string[]; title?: string; maxBytes?: number };
export type PluginDropSpec = { name: string; run: number; paths: string[]; maxBytes?: number };
export type PluginPickedFile = { name: string; size: number; mimeType: string; data: string; encoding: "base64" | "utf8"; handle?: string };
export type PluginChunkResult = { ok: true; data: string; eof: boolean } | { ok: false; reason: string };
export type PluginImageSpec = { url: string; timeoutMs: number; allowedHosts: string[] };
export type PluginImageResult = { ok: true; url: string } | { ok: false; reason: string };
export type PluginPickResult = { ok: true; files: PluginPickedFile[] } | { ok: false; reason: string; cancelled?: boolean };
export type PluginSaveSpec = { name: string; run: number; fileName: string };
export type PluginSaveResult = { ok: true; saved: boolean; name?: string; handle?: string } | { ok: false; reason: string };
export type PluginFileReadResult = { ok: true; text: string } | { ok: false; reason: string };
export type PluginStorageReadResult = { status: "ok"; text: string } | { status: "missing" } | { status: "error"; reason: string };

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
  storeKey?: string;
  onLoaded?: (e: PluginPageEvent<{ url: string; title: string }>) => void;
  onTitleChange?: (e: PluginPageEvent<{ title: string }>) => void;
  onNavigationChange?: (e: PluginPageEvent<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean }>) => void;
  onMessage?: (e: PluginPageEvent<{ body: string }>) => void;
};
