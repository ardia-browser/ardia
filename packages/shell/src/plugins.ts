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
export type PluginExit = { name: string; run: number; status: number | null; signal: number | null; overMemory: boolean };
export type PluginLine = { name: string; run: number; launch: number; line: string };
export type PluginRemoveResult = { ok: true } | { ok: false; reason: string };
export type PluginFetchSpec = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; allowedHosts: string[] };
export type PluginFetchResult =
  | { ok: true; status: number; statusText: string; url: string; headers: Record<string, string>; body: string }
  | { ok: false; reason: string };
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
  onLoaded?: (e: PluginPageEvent<{ url: string; title: string }>) => void;
  onTitleChange?: (e: PluginPageEvent<{ title: string }>) => void;
  onNavigationChange?: (e: PluginPageEvent<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean }>) => void;
  onMessage?: (e: PluginPageEvent<{ body: string }>) => void;
};
