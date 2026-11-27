import { openWindow, switchToTab } from "../browser/actions";
import { useBrowser } from "../browser/store";
import { activeTabId, viewTabIds } from "../browser/model";
import type { Tab } from "../browser/types";
import type { Suggestion } from "@ardia/core";
import { openSplitPane } from "../splits/actions";
import { splitViewAvailable } from "../splits/splits";
import { gateOpening, settleOpening } from "../tabs/openingGate";
import { noteSplit } from "../telemetry/usage";
import { noteBarLoad } from "../telemetry/barLoadFocus";
import { originalProfile } from "../windows/small";
import { navigateTyped, noteTypedOpen } from "../plugins/typedAddresses";
import { pluginPageOf, pluginPagePath, showsPluginPage } from "../plugins/pageNames";
import { tabDestination } from "../pages/urls";
import { notePlugin } from "../telemetry/pluginCounts";

export type Disposition = "current" | "newTab" | "newWindow" | "split";

export function dispositionFor(mods: { metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): Disposition {
  if (mods.altKey) return "split";
  if (mods.metaKey) return "newTab";
  if (mods.shiftKey) return "newWindow";
  return "current";
}

export function openFromBar(url: string, tabId: string, disposition: Disposition) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!url || !tab) return;
  const w = s.windows[tab.windowId];
  if (disposition === "current") {
    navigateTyped(tabId, url, () => s.navigate(tabId, url));
    return noteBarLoad(tabId);
  }
  if (disposition === "split") {
    s.closePanel(tab.windowId);
    const gated = gateOpening(url, { tabId: null, windowId: tab.windowId, profileId: tab.profileId, via: "newTab" }, null);
    settleOpening(gated, null, (verdict) => {
      if (!(verdict && "cancel" in verdict)) openBesideOrBehind(tabId, verdict?.url ?? url);
    });
    return;
  }
  s.closePanel(tab.windowId);
  if (disposition === "newTab") return void noteTypedOpen(s.newTab(tab.windowId, { url, profileId: tab.profileId, openerId: tab.url ? tabId : undefined }), url);
  openWindow(w?.kind === "private" ? { kind: "private", url, profileId: originalProfile(s, w) } : { profileId: tab.profileId, url });
}

export const barSplitsFrom = (tabId: string) => splitViewAvailable && !!useBrowser.getState().tabs[tabId]?.url;

function openBesideOrBehind(tabId: string, url: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab) return;
  const beside = openSplitPane(tab.windowId, { anchorTabId: tabId, url, side: "right" });
  if (!beside) s.newTab(tab.windowId, { url, profileId: tab.profileId, background: true, gated: true });
  noteSplit(beside ? "barSplitOpens" : "barSplitFullTabs");
}

export function pluginRowTab(providerId: string, url: string, windowId: string, disposition: Disposition): string | null {
  if (providerId.startsWith("plugin:")) notePlugin("plugin_omnibox_picks");
  const s = useBrowser.getState();
  const name = pluginPageOf(url);
  if (disposition === "newTab" || !s.windows[windowId] || name === null) return null;
  const path = pluginPagePath(url);
  return viewTabIds(s, windowId).find((id) => { const t = s.tabs[id]; return !!t && showsPluginPage(tabDestination(t), name, path); }) ?? null;
}

export function shownTabOf(s: Suggestion, windowId: string, disposition: Disposition, opensTab: boolean): string | null {
  const shown = s.kind === "page" ? (s.tabId ?? null) : s.kind === "provider" ? pluginRowTab(s.providerId, s.url, windowId, disposition) : null;
  return opensTab && disposition === "newTab" ? null : shown;
}

export function switchedFromBar(targetTabId: string | null, url: string, barTabId: string, disposition: Disposition): boolean {
  if (!targetTabId) return false;
  switchFromBar(targetTabId, url, barTabId, disposition);
  return true;
}

export function switchFromBar(targetTabId: string, url: string, barTabId: string, disposition: Disposition) {
  if (disposition !== "current") return openFromBar(url, barTabId, disposition);
  const s = useBrowser.getState();
  const bar = s.tabs[barTabId];
  if (bar) s.closePanel(bar.windowId);
  switchToTab(targetTabId);
}

export function otherOpenTabs(windowId: string, limit: number): Tab[] {
  const s = useBrowser.getState();
  const active = activeTabId(s, windowId);
  return viewTabIds(s, windowId)
    .map((id) => s.tabs[id]!)
    .filter((t) => t.id !== active && t.url)
    .slice(0, limit);
}
