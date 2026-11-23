import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { surfaceKey, usePluginSurfaces, type PluginSurfacesStore, type SidePanel } from "./surfaces";
import { pluginToolbarItems } from "./toolbar";
import { pluginThemes } from "./themes";
import { activeManifest, activeNames, consentListing, currentPlugins, needsReview, recordOf, usePlugins, webViewsOnline, type PluginsStore } from "./store";
import { pageContextOf, pageViewUrl, shownContext, usePluginPages } from "./pages";
import { useBrowser } from "../browser/store";
import { useKeyed, watchWindowRecord } from "../browser/keyedWatch";
import { eligibleKind } from "../automation/automationWindows";
import { valuesOf } from "./values";
import { consentVerbOf } from "./consentWords";
import { fullControlLine } from "./consent";
import { ownValue } from "../../lib/decode";

export const usePluginOrder = () => usePlugins((s) => s.order);
export { useOfficialPlugins } from "./official";
export const usePluginListing = (name: string) => usePlugins((s) => s.listings[name]);
export const usePluginFullControl = (name: string) =>
  usePlugins((s) => {
    const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : ownValue(s.candidates, name);
    return !!listing?.manifest && fullControlLine(listing.manifest) !== null;
  });
export const useConsentListing = (name: string, hash: string) => usePlugins((s) => consentListing(s, name, hash));
export const useConsentVerb = (name: string, hash: string) => usePlugins((s) => consentVerbOf(s, name, hash));
export const useOfficialFetch = (name: string) => usePlugins((s) => ownValue(s.fetches, name));
export const usePluginTitle = (name: string | null | undefined) => usePlugins((s) => (name && Object.hasOwn(s.listings, name) ? (s.listings[name]!.manifest?.title ?? name) : null));
export const usePluginRecord = (name: string) => usePlugins((s) => recordOf(s, name));
export const usePluginActive = (name: string) => usePlugins((s) => !!activeManifest(s, name));
export const usePluginNeedsReview = (name: string) => usePlugins((s) => needsReview(s, name));
export const usePluginProcess = (name: string) => usePlugins((s) => s.processes[name]);
export const usePluginPrograms = (name: string) => usePlugins((s) => s.programs[name]);
export const usePluginUnsaved = (name: string) => usePlugins((s) => s.unsaved === name);
export function usePluginsWithPrograms(): { name: string; title: string }[] {
  const key = usePlugins((s) => JSON.stringify(s.order.flatMap((name) => { const m = activeManifest(s, name); return m?.programs.length ? [{ name, title: m.title }] : []; })));
  return useMemo(() => JSON.parse(key) as { name: string; title: string }[], [key]);
}
export const usePluginConsent = () => usePlugins((s) => s.consent);
export const usePluginValues = (name: string) => usePlugins(useShallow((s: PluginsStore) => valuesOf(s, name)));
export function usePluginPageContext(tabId: string, name: string): string {
  usePluginPages((s) => s.contexts[tabId]);
  useBrowser((s) => s.tabs[tabId]?.url);
  usePlugins((s) => s.records);
  usePlugins((s) => s.listings[name]);
  const shown = shownContext(currentPlugins(), name, pageContextOf(tabId));
  return shown ? JSON.stringify(shown) : "";
}
export const usePluginPageUrl = (name: string, path: string) => usePlugins((s) => pageViewUrl(s, name, path));
export const usePluginFolderId = (name: string) => usePlugins((s) => s.listings[name]?.folderId ?? "");
export const usePluginPageRun = (name: string) =>
  usePlugins((s) => {
    const state = ownValue(s.processes, name);
    return state?.state === "running" ? state.run : 0;
  });
export const usePluginApproval = (name: string) => usePlugins((s) => recordOf(s, name).approved ?? "");
export const usePluginNetwork = (name: string) => usePlugins((s) => webViewsOnline(s, name));
export const usePluginPageSpec = (name: string) => usePlugins((s) => s.listings[name]?.manifest?.page ?? null);
export const usePluginManifest = (name: string) => usePlugins((s) => activeManifest(s, name));
export const usePluginToolbarItems = () => {
  const plugins = usePlugins(useShallow((s: PluginsStore) => ({ listings: s.listings, records: s.records, order: s.order })));
  const surfaces = usePluginSurfaces(useShallow((s: PluginSurfacesStore) => ({ toolbarState: s.toolbarState })));
  return useMemo(() => pluginToolbarItems(plugins, surfaces), [plugins, surfaces]);
};
export const usePluginSurfaceTree = (plugin: string, surfaceId: string) => usePluginSurfaces((s) => s.trees[surfaceKey(plugin, surfaceId)] ?? null);
export const usePluginToolbarState = (plugin: string, itemId: string) => usePluginSurfaces((s) => s.toolbarState[surfaceKey(plugin, itemId)] ?? null);
export const usePluginSidePanel = (windowId: string) => usePluginSurfaces((s) => s.sidePanels[windowId] ?? null);
const NO_SIDE_PANELS: SidePanel[] = [];
export const usePluginRetainedSidePanels = (windowId: string) => usePluginSurfaces((s) => s.retainedSidePanels[windowId] ?? NO_SIDE_PANELS);
export const usePluginWindowEligible = (windowId: string) => useKeyed(watchWindowRecord, windowId, () => eligibleKind(useBrowser.getState(), windowId) !== null);
export const usePluginPopover = (windowId: string) => usePluginSurfaces((s) => s.popovers[windowId] ?? null);
export const usePluginCommandView = (windowId: string) => usePluginSurfaces((s) => s.commandViews[windowId] ?? null);
export const usePluginQuickPick = () => usePluginSurfaces((s) => s.quickPick);
export const usePluginInputBox = () => usePluginSurfaces((s) => s.inputBox);
export const usePluginSidebarViews = () => {
  const plugins = usePlugins(useShallow((s: PluginsStore) => ({ listings: s.listings, records: s.records, order: s.order })));
  return useMemo(() => activeNames(plugins).flatMap((plugin) => activeManifest(plugins, plugin)!.contributes.sidebarViews.map((v) => ({ ...v, plugin }))), [plugins]);
};
export const usePluginThemes = () => {
  const plugins = usePlugins(useShallow((s: PluginsStore) => ({ listings: s.listings, records: s.records, order: s.order })));
  return useMemo(() => pluginThemes(plugins), [plugins]);
};
