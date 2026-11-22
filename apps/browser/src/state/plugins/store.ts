import { create } from "zustand";
import type { PluginManifest, RowValue } from "../../lib/pluginManifest";
import type { ConsentToken } from "../telemetry/choice";
import type { OfficialPinned } from "../../platform/plugins";

export type PluginListing = {
  name: string;
  manifest: PluginManifest | null;
  problems: string[];
  hash: string | null;
  folderId: string;
  official?: boolean;
  legacy?: boolean;
  legacyHash?: string;
  ignoresUserFolder?: boolean;
};

export type OfficialFetch = { state: "fetching"; received: number; total: number } | { state: "promoting" } | { state: "failed"; reason: string; code: string };

export function setOfficialFetch(name: string, state: OfficialFetch | null) {
  usePlugins.setState((s) => {
    const fetches = { ...s.fetches };
    if (state) fetches[name] = state;
    else delete fetches[name];
    return { fetches };
  });
}

export type ProgramsState =
  | { state: "linking"; hash: string; request: number }
  | { state: "linked"; hash: string; linked: string[]; refused: Record<string, string>; binDir: string; adoption?: "retrying" | "busy" | "failed" }
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
};

export type PluginsStore = {
  loaded: boolean;
  scanned: boolean;
  listings: Record<string, PluginListing>;
  order: string[];
  records: Record<string, PluginRecord>;
  processes: Record<string, ProcessState>;
  programs: Record<string, ProgramsState>;
  candidates: Record<string, PluginListing>;
  pinned: OfficialPinned[] | null;
  fetches: Record<string, OfficialFetch>;
  consent: { id: number; name: string; hash: string } | null;
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
  pinned: null,
  fetches: {},
  consent: null,
}));

export const NO_RECORD: PluginRecord = { enabled: false, approved: null, values: {}, applied: {} };

const ownRecord = (s: Pick<PluginsStore, "records">, name: string): PluginRecord | undefined => (Object.hasOwn(s.records, name) ? s.records[name] : undefined);

export const recordOf = (s: Pick<PluginsStore, "records">, name: string): PluginRecord => ownRecord(s, name) ?? NO_RECORD;

export const approvalMatches = (listing: Pick<PluginListing, "hash" | "legacyHash"> | undefined, approved: string | null | undefined): boolean =>
  !!approved && !!listing?.hash && (approved === listing.hash || (!!listing.legacyHash && approved === listing.legacyHash));

export const recordApproves = (listing: PluginListing | undefined, record: PluginRecord | undefined): boolean =>
  !!record && (approvalMatches(listing, record.approved) || approvalMatches(listing, record.previous));

export const keepsInstalledFlag = (listing: PluginListing | undefined): boolean => !!listing?.official && !!listing.manifest?.alwaysOn;

export function activeManifest(s: Pick<PluginsStore, "listings" | "records">, name: string): PluginManifest | null {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  const record = ownRecord(s, name);
  if (!listing?.manifest || !listing.hash || !record?.enabled || !recordApproves(listing, record)) return null;
  return listing.manifest;
}

export function consentListing(s: Pick<PluginsStore, "listings" | "candidates">, name: string, hash: string): PluginListing | undefined {
  const candidate = Object.hasOwn(s.candidates, name) ? s.candidates[name] : undefined;
  if (candidate?.hash === hash) return candidate;
  return Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
}

export const webViewsOnline = (s: Pick<PluginsStore, "listings" | "records">, name: string): boolean => activeManifest(s, name)?.permissions.network === "*";

export const activeNames = (s: Pick<PluginsStore, "listings" | "records" | "order">) => s.order.filter((name) => activeManifest(s, name));

export function needsReview(s: Pick<PluginsStore, "listings" | "records">, name: string): boolean {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  const record = ownRecord(s, name);
  return !!record?.enabled && !!listing?.hash && !recordApproves(listing, record);
}

export const currentPlugins = () => usePlugins.getState();

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
