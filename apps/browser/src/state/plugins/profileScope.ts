import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import { ownValue } from "../../lib/decode";
import { activeManifest, activeNames, shownManifest, type PluginsStore } from "./store";
import type { PluginManifest } from "../../lib/pluginManifest";

export const windowProfileId = (windowId: string | undefined): string | null => (windowId ? (useBrowser.getState().windows[windowId]?.profileId ?? null) : null);

export const shownNames = (s: Pick<PluginsStore, "listings" | "records" | "order">, profileId: string | null): string[] => activeNames(s).filter((name) => shownManifest(s, name, profileId));

export function eventProfileId(data: Record<string, unknown>): string | null {
  const b = useBrowser.getState();
  if (typeof data.profileId === "string" && b.profiles[data.profileId]) return data.profileId;
  if (typeof data.tabId === "string" && b.tabs[data.tabId]) return b.tabs[data.tabId]!.profileId;
  if (typeof data.groupId === "string" && b.groups[data.groupId]) return b.groups[data.groupId]!.profileId;
  if (typeof data.windowId === "string") return windowProfileId(data.windowId);
  return null;
}

export function manifestInProfile(s: Pick<PluginsStore, "listings" | "records">, name: string, profileId: string | null): PluginManifest | null {
  const manifest = activeManifest(s, name);
  if (!manifest || manifest.scope === "global") return manifest;
  const profiles = ownValue(s.records, name)?.profiles;
  if (!profiles || profiles === "all") return manifest;
  return profileId !== null && profiles.includes(profileId) ? manifest : null;
}

export function limitedProfiles(s: Pick<PluginsStore, "listings" | "records">, name: string): string[] | null {
  if (activeManifest(s, name)?.scope !== "profile") return null;
  const profiles = ownValue(s.records, name)?.profiles;
  return Array.isArray(profiles) ? profiles : null;
}

const kept = <T,>(all: Record<string, T>, keep: (value: T) => boolean): Record<string, T> => Object.fromEntries(Object.entries(all).filter(([, value]) => keep(value)));

export function profileView(s: BrowserState, profiles: readonly string[]): BrowserState {
  const allowed = new Set(profiles);
  const engines = new Set(profiles.map((id) => engineProfile(s, id)));
  const windows = kept(s.windows, (w) => allowed.has(w.profileId));
  return {
    ...s,
    windows,
    windowOrder: s.windowOrder.filter((id) => Object.hasOwn(windows, id)),
    tabs: kept(s.tabs, (t) => allowed.has(t.profileId)),
    groups: kept(s.groups, (g) => allowed.has(g.profileId)),
    downloads: s.downloads.filter((d) => engines.has(d.profile ?? "")),
    ui: { ...s.ui, focusOrder: s.ui.focusOrder.filter((id) => Object.hasOwn(windows, id)) },
  };
}
