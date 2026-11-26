import { create } from "zustand";
import type { PluginManifest, RowValue } from "../../lib/pluginManifest";
import type { ConsentToken } from "../telemetry/choice";
import type { PluginSource } from "../../platform/plugins";
import { ownValue } from "../../lib/decode";

export type PluginListing = {
  name: string;
  manifest: PluginManifest | null;
  problems: string[];
  hash: string | null;
  folderId: string;
  source?: PluginSource;
  official?: boolean;
  version?: string;
  payloadDigest?: string;
  previousVersion?: string;
  previousFolderId?: string;
  previousNative?: boolean;
  devPath?: string;
  shadowsStore?: boolean;
};

export type PluginFetch = { state: "fetching"; received: number; total: number } | { state: "promoting" } | { state: "failed"; reason: string; code: string };

export function setPluginFetch(name: string, state: PluginFetch | null) {
  usePlugins.setState((s) => {
    const fetches = { ...s.fetches };
    if (state) fetches[name] = state;
    else delete fetches[name];
    return { fetches };
  });
}

export type ProgramsState =
  | { state: "linking"; hash: string; request: number }
  | { state: "linked"; hash: string; linked: string[]; refused: Record<string, string>; binDir: string }
  | { state: "failed"; hash: string; reason: string };

export type ProcessState =
  | { state: "starting" | "running"; run: number; since: number }
  | { state: "waiting"; until: number; failures: number }
  | { state: "crashed"; reason: string }
  | { state: "exited" }
  | { state: "failed"; reason: string };

export type PluginRecord = {
  enabled: boolean;
  approved: string | null;
  values: Record<string, RowValue>;
  applied: Record<string, { value: unknown; previous: unknown; order: number; over: string | null }>;
  controlGranted?: boolean;
  installed?: boolean;
  previous?: string;
  sites?: SiteSwitchValues;
  updated?: PluginUpdateNote;
  pendingUpdate?: PendingUpdate;
  revoked?: PluginRevoked;
  profiles?: "all" | string[];
  preapproved?: true;
};

export type PluginUpdateNote = { from: string | null; to: string | null; added: string[]; runtime?: true; rolledBack?: true };

export type PendingBundled = { name: string; folderId: string };

export type PendingUpdate = { version: string; folderId: string; added: string[]; dependencies: string[]; bundle?: PendingBundled[] };

export type PluginRevoked = { action: "disable" | "block"; reason: string; version?: string };

export type SiteSwitchValues = Record<string, Record<string, boolean>>;

export type PluginConsentRequest = { id: number; name: string; hash: string; bundle?: { name: string; hash: string }[]; added?: string[] };

export type PluginsStore = {
  loaded: boolean;
  scanned: boolean;
  listings: Record<string, PluginListing>;
  order: string[];
  records: Record<string, PluginRecord>;
  processes: Record<string, ProcessState>;
  programs: Record<string, ProgramsState>;
  candidates: Record<string, PluginListing>;
  fetches: Record<string, PluginFetch>;
  consent: PluginConsentRequest | null;
  unsaved: string | null;
};

export const usePlugins = create<PluginsStore>()(() => ({
  loaded: false,
  scanned: false,
  listings: {},
  order: [],
  records: {},
  processes: {},
  programs: {},
  candidates: {},
  fetches: {},
  consent: null,
  unsaved: null,
}));

export const NO_RECORD: PluginRecord = { enabled: false, approved: null, values: {}, applied: {} };

export const recordOf = (s: Pick<PluginsStore, "records">, name: string): PluginRecord => ownValue(s.records, name) ?? NO_RECORD;

export const approvalMatches = (listing: Pick<PluginListing, "hash"> | undefined, approved: string | null | undefined): boolean => !!approved && !!listing?.hash && approved === listing.hash;

export const recordApproves = (listing: PluginListing | undefined, record: PluginRecord | undefined): boolean =>
  !!record && (approvalMatches(listing, record.approved) || approvalMatches(listing, record.previous));

export function activeManifest(s: Pick<PluginsStore, "listings" | "records">, name: string): PluginManifest | null {
  const listing = ownValue(s.listings, name);
  const record = ownValue(s.records, name);
  if (!listing?.manifest || !listing.hash || !record?.enabled || record.revoked || !recordApproves(listing, record)) return null;
  return listing.manifest;
}

export const enabledInProfile = (record: Pick<PluginRecord, "profiles"> | undefined, profileId: string | null | undefined): boolean =>
  !record?.profiles || record.profiles === "all" || !profileId || record.profiles.includes(profileId);

export function shownManifest(s: Pick<PluginsStore, "listings" | "records">, name: string, profileId: string | null | undefined): PluginManifest | null {
  const manifest = activeManifest(s, name);
  if (!manifest || manifest.scope === "global") return manifest;
  return enabledInProfile(ownValue(s.records, name), profileId) ? manifest : null;
}

export function consentListing(s: Pick<PluginsStore, "listings" | "candidates">, name: string, hash: string): PluginListing | undefined {
  const candidate = ownValue(s.candidates, name);
  if (candidate?.hash === hash) return candidate;
  return ownValue(s.listings, name);
}

export const webViewsOnline = (s: Pick<PluginsStore, "listings" | "records">, name: string): boolean => activeManifest(s, name)?.permissions.network === "*";

export const activeNames = (s: Pick<PluginsStore, "listings" | "records" | "order">) => s.order.filter((name) => activeManifest(s, name));

export function needsReview(s: Pick<PluginsStore, "listings" | "records">, name: string): boolean {
  const listing = ownValue(s.listings, name);
  const record = ownValue(s.records, name);
  return !!record?.enabled && !!listing?.hash && !recordApproves(listing, record);
}

export const currentPlugins = () => usePlugins.getState();

export const UNSAVED = "Ardia couldn't save its plugin settings. Try again.";

export const clearUnsaved = (name: string) => {
  if (currentPlugins().unsaved === name) usePlugins.setState({ unsaved: null });
};

export type PluginsCommit = Pick<PluginsStore, "listings" | "records">;
const committing = new Set<(next: PluginsCommit, before: PluginsCommit) => void>();

export function beforePluginsCommit(listener: (next: PluginsCommit, before: PluginsCommit) => void): () => void {
  committing.add(listener);
  return () => void committing.delete(listener);
}

export function commitPlugins(patch: Partial<Pick<PluginsStore, "listings" | "order" | "records">>) {
  const before = usePlugins.getState();
  const next = { listings: patch.listings ?? before.listings, records: patch.records ?? before.records };
  for (const listener of [...committing]) listener(next, before);
  usePlugins.setState(patch);
}

const withdrawing = new Set<(next: PluginsCommit) => Promise<unknown> | void>();

export function beforePluginsWithdraw(listener: (next: PluginsCommit) => Promise<unknown> | void): () => void {
  withdrawing.add(listener);
  return () => void withdrawing.delete(listener);
}

const abandoning = new Set<(name: string, consent: ConsentToken | null) => void>();

export function onPluginWithdrawAbandoned(listener: (name: string, consent: ConsentToken | null) => void): () => void {
  abandoning.add(listener);
  return () => void abandoning.delete(listener);
}

export const abandonWithdrawal = (name: string, consent: ConsentToken | null) => {
  for (const listener of [...abandoning]) listener(name, consent);
};

export const withdrawalsFor = (next: PluginsCommit): Promise<unknown>[] => [...withdrawing].flatMap((listener) => listener(next) ?? []);
