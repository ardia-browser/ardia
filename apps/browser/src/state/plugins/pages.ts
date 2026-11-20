import { create } from "zustand";
import type { PageSide } from "../../lib/pluginManifest";
import { minimizedUrl } from "../../lib/urlParts";
import { useBrowser } from "../browser/store";
import { activeTabId, viewTabIds } from "../browser/model";
import { openSplitPane } from "../splits/actions";
import { notePlugin } from "../telemetry/pluginCounts";
import { isPagePath, pluginPageOf, pluginPagePath, pluginPageUrl } from "./pageNames";
import { activeManifest, currentPlugins, usePlugins, type PluginsStore } from "./store";
import { eligibleKind, isEligibleTab } from "../automation/automationWindows";

export { isPagePath, pluginPageOf, pluginPagePath, pluginPageUrl };

export type PageContext = { tabId: string; url: string; title: string };
type HandedContext = { plugin: string; approved: string; pageUrl: string; context: PageContext };

export const usePluginPages = create<{ contexts: Record<string, HandedContext> }>()(() => ({ contexts: {} }));

function isLive(handed: HandedContext, tabId: string): boolean {
  const plugins = currentPlugins();
  return (
    useBrowser.getState().tabs[tabId]?.url === handed.pageUrl &&
    !!activeManifest(plugins, handed.plugin)?.permissions.includes("tabs") &&
    plugins.records[handed.plugin]?.approved === handed.approved
  );
}

export function pageContextOf(tabId: string): PageContext | null {
  const handed = usePluginPages.getState().contexts[tabId];
  return handed && isLive(handed, tabId) ? handed.context : null;
}

export function dropStalePageContexts() {
  const { contexts } = usePluginPages.getState();
  const stale = Object.keys(contexts).filter((tabId) => !isLive(contexts[tabId]!, tabId));
  if (!stale.length) return;
  usePluginPages.setState((p) => {
    const kept = { ...p.contexts };
    for (const tabId of stale) delete kept[tabId];
    return { contexts: kept };
  });
}

let watchingContexts = false;

export function watchPageContexts() {
  if (watchingContexts) return;
  watchingContexts = true;
  useBrowser.subscribeTo(["tabs"], (s, prev) => {
    if (s.tabs !== prev.tabs) dropStalePageContexts();
  });
  usePlugins.subscribe((s, prev) => {
    if (s.records !== prev.records || s.listings !== prev.listings) dropStalePageContexts();
  });
}

function withParam(url: string, key: string, value: string): string {
  const cut = url.indexOf("#");
  const [head, fragment] = cut < 0 ? [url, ""] : [url.slice(0, cut), url.slice(cut)];
  return `${head}${head.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}${fragment}`;
}

export function pageViewUrl(s: Pick<PluginsStore, "listings" | "records">, name: string, path = ""): string | null {
  const page = activeManifest(s, name)?.page;
  if (!page || !isPagePath(path)) return null;
  const file = `ardia-plugin://${name}/${page.source.file.split("/").map(encodeURIComponent).join("/")}`;
  return path ? withParam(file, "ardiaPath", path) : file;
}

export function shownContext(s: Pick<PluginsStore, "listings" | "records">, name: string, context: PageContext | null): PageContext | null {
  const permissions = activeManifest(s, name)?.permissions ?? [];
  if (!context || !permissions.includes("tabs")) return null;
  return permissions.includes("fullUrls") ? context : { ...context, url: minimizedUrl(context.url) };
}

function contextOf(name: string, tabId: string | null): PageContext | null {
  const m = activeManifest(currentPlugins(), name);
  const s = useBrowser.getState();
  const tab = tabId ? s.tabs[tabId] : undefined;
  if (!m || !tab || !m.permissions.includes("tabs") || !isEligibleTab(s, tab.id) || pluginPageOf(tab.url)) return null;
  return { tabId: tab.id, url: tab.url, title: tab.customTitle || tab.title };
}

export function openPluginPage(windowId: string, name: string, how: { split?: boolean; side?: PageSide; context?: boolean; path?: string } = {}): string | null {
  if (!activeManifest(currentPlugins(), name)?.page) return null;
  const path = how.path ?? "";
  if (!isPagePath(path)) return null;
  const s = useBrowser.getState();
  if (!eligibleKind(s, windowId)) return null;
  const url = pluginPageUrl(name, path);
  const anchor = activeTabId(s, windowId);
  const existing = viewTabIds(s, windowId).find((id) => {
    const at = s.tabs[id]?.url ?? "";
    return pluginPageOf(at) === name && pluginPagePath(at) === path;
  }) ?? null;
  const context = how.context ? contextOf(name, anchor ?? null) : null;
  let tabId: string | null;
  if (how.split && anchor && anchor !== existing) {
    tabId = openSplitPane(windowId, existing ? { tabId: existing, anchorTabId: anchor, side: how.side ?? "right" } : { url, anchorTabId: anchor, side: how.side ?? "right" });
    if (tabId) notePlugin("plugin_split_opens");
  } else if (existing) {
    s.activate(existing);
    tabId = existing;
  } else {
    tabId = s.newTab(windowId, { url });
  }
  if (!tabId) return null;
  notePlugin("plugin_page_opens");
  const approved = currentPlugins().records[name]?.approved ?? "";
  const pageUrl = useBrowser.getState().tabs[tabId]?.url ?? url;
  usePluginPages.setState((p) => {
    const contexts = { ...p.contexts };
    if (context) contexts[tabId] = { plugin: name, approved, pageUrl, context };
    else delete contexts[tabId];
    return { contexts };
  });
  return tabId;
}

