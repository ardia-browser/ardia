import { create } from "zustand";
import type { PluginManifest } from "../../lib/pluginManifest";
import type { ConsentToken } from "../telemetry/choice";

export type PluginListing = {
  name: string;
  manifest: PluginManifest | null;
  problems: string[];
  hash: string | null;
  folderId: string;
  bundled?: boolean;
  replacesBundled?: boolean;
  ignoresUserFolder?: boolean;
};

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
  values: Record<string, string | boolean>;
  applied: Record<string, { value: unknown; previous: unknown; order: number; over: string | null }>;
  controlGranted?: boolean;
  installed?: boolean;
};

export type PluginsStore = {
  loaded: boolean;
  scanned: boolean;
  listings: Record<string, PluginListing>;
  order: string[];
  records: Record<string, PluginRecord>;
  processes: Record<string, ProcessState>;
  programs: Record<string, ProgramsState>;
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
  consent: null,
}));

export const NO_RECORD: PluginRecord = { enabled: false, approved: null, values: {}, applied: {} };

const ownRecord = (s: Pick<PluginsStore, "records">, name: string): PluginRecord | undefined => (Object.hasOwn(s.records, name) ? s.records[name] : undefined);

export const recordOf = (s: Pick<PluginsStore, "records">, name: string): PluginRecord => ownRecord(s, name) ?? NO_RECORD;

export const isAlwaysOn = (listing: PluginListing | undefined): boolean => !!listing?.bundled && !!listing.manifest?.alwaysOn && !!listing.hash;

export function isInstalled(s: Pick<PluginsStore, "listings" | "records">, name: string): boolean {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  return isAlwaysOn(listing) && (!!listing!.manifest!.autoInstall || ownRecord(s, name)?.installed === true);
}

export function activeManifest(s: Pick<PluginsStore, "listings" | "records">, name: string): PluginManifest | null {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  if (isAlwaysOn(listing)) return isInstalled(s, name) ? listing!.manifest : null;
  const record = ownRecord(s, name);
  if (!listing?.manifest || !listing.hash || !record?.enabled || record.approved !== listing.hash) return null;
  return listing.manifest;
}

export const activeNames = (s: Pick<PluginsStore, "listings" | "records" | "order">) => s.order.filter((name) => activeManifest(s, name));

export function needsReview(s: Pick<PluginsStore, "listings" | "records">, name: string): boolean {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  if (isAlwaysOn(listing)) return false;
  const record = ownRecord(s, name);
  return !!record?.enabled && !!listing?.hash && record.approved !== listing.hash;
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
