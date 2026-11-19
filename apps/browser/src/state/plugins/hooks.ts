import { useShallow } from "zustand/react/shallow";
import { activeManifest, currentPlugins, needsReview, recordOf, usePlugins, type PluginsStore } from "./store";
import { pageContextOf, pageViewUrl, shownContext, usePluginPages } from "./pages";
import { useBrowser } from "../browser/store";
import { valuesOf } from "./values";

export const usePluginOrder = () => usePlugins((s) => s.order);
export { useOfficialPlugins } from "./official";
export const usePluginListing = (name: string) => usePlugins((s) => s.listings[name]);
export const usePluginRecord = (name: string) => usePlugins((s) => recordOf(s, name));
export const usePluginActive = (name: string) => usePlugins((s) => !!activeManifest(s, name));
export const usePluginNeedsReview = (name: string) => usePlugins((s) => needsReview(s, name));
export const usePluginProcess = (name: string) => usePlugins((s) => s.processes[name]);
export const usePluginPrograms = (name: string) => usePlugins((s) => s.programs[name]);
export const usePluginUnsaved = (name: string) => usePlugins((s) => s.unsaved === name);
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
    const state = Object.hasOwn(s.processes, name) ? s.processes[name] : undefined;
    return state?.state === "running" ? state.run : 0;
  });
export const usePluginApproval = (name: string) => usePlugins((s) => recordOf(s, name).approved ?? "");
export const usePluginNetwork = (name: string) => usePlugins((s) => !!activeManifest(s, name)?.permissions.includes("network"));
export const usePluginPageSpec = (name: string) => usePlugins((s) => s.listings[name]?.manifest?.page ?? null);
