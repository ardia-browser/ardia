import { isNativeTier } from "@ardia/plugin-sdk/registry";
import { systemInfo } from "../../platform/app";
import type { PluginFolderEntry } from "../../platform/plugins";
import { useBrowser } from "../browser/store";
import { listingOf } from "./appChecks";
import { chosenCandidate } from "./candidates";
import { currentLock } from "./lockfile";
import { currentPlugins, type PluginListing } from "./store";

const MAX_PLUGINS = 64;

const READ_PROBLEMS: Record<Exclude<PluginFolderEntry["status"], "ok">, string> = {
  missing: "The folder has no plugin.json",
  link: "plugin.json is a link; it must be a file in the plugin's folder",
  notFile: "plugin.json isn't a file",
  tooBig: "plugin.json is over 1 MB",
  unreadable: "plugin.json couldn't be read",
  unchecked: "Ardia couldn't check the folder's files",
};

const readProblem = (e: PluginFolderEntry) => (e.status === "ok" ? null : e.status === "unchecked" && e.reason ? `${READ_PROBLEMS.unchecked}: ${e.reason}` : READ_PROBLEMS[e.status]);

function nativeTierText(text: string): boolean {
  try {
    const doc: unknown = JSON.parse(text);
    return typeof doc === "object" && doc !== null && isNativeTier(doc as Parameters<typeof isNativeTier>[0]);
  } catch {
    return true;
  }
}

const officialStore = (e: PluginFolderEntry, listing: PluginListing) =>
  e.source === "store" && !!listing.manifest?.official && currentLock()[listing.manifest.id]?.official === true;

const sourceFlags = (e: PluginFolderEntry): Partial<PluginListing> => ({
  source: e.source,
  ...(e.source === "dev" && e.devPath ? { devPath: e.devPath } : {}),
  ...(e.shadowsStore ? { shadowsStore: true } : {}),
  ...(e.previous ? { previousVersion: e.previous.version, previousFolderId: e.previous.folderId, previousNative: nativeTierText(e.previous.text) } : {}),
});

export function listingsOf(entries: PluginFolderEntry[]): PluginListing[] {
  const settings = useBrowser.getState().settings;
  const version = systemInfo().appVersion;
  return entries.slice(0, MAX_PLUGINS).flatMap((e) => {
    if (e.status !== "ok" && e.source === "store" && !e.text) return [];
    const listing = listingOf(e.name, e.status === "ok" ? (e.text ?? "") : null, readProblem(e), settings, version, e.folderId ?? "", e.source);
    return [{ ...listing, ...sourceFlags(e), ...(officialStore(e, listing) ? { official: true } : {}) }];
  });
}

export function candidatesOf(entries: PluginFolderEntry[]): PluginListing[] {
  const settings = useBrowser.getState().settings;
  const version = systemInfo().appVersion;
  return entries.flatMap((e) => {
    const wanted = chosenCandidate(e.name, currentPlugins().records[e.name]);
    const c = wanted ? e.candidates?.find((candidate) => candidate.folderId === wanted) : undefined;
    if (!c) return [];
    const listing = listingOf(e.name, c.text, null, settings, version, c.folderId, "store");
    return [{ ...listing, source: "store" as const, version: c.version, ...(officialStore(e, listing) ? { official: true } : {}) }];
  });
}
