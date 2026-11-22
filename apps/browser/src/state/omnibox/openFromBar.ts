import { openWindow, switchToTab } from "../browser/actions";
import { useBrowser } from "../browser/store";
import { activeTabId, viewTabIds } from "../browser/model";
import type { Tab } from "../browser/types";
import { openSplitPane } from "../splits/actions";
import { splitViewAvailable } from "../splits/splits";
import { gateOpening, isGatedUrl, settleOpening } from "../tabs/openingGate";
import { openTypedElsewhere, routedInApp } from "../airTraffic/inAppLinks";
import { consentToken } from "../telemetry/consentPeriod";
import { noteSplit } from "../telemetry/usage";
import { noteBarLoad } from "../telemetry/barLoadFocus";
import { originalProfile } from "../windows/small";

export type Disposition = "current" | "newTab" | "newWindow" | "split";

export function dispositionFor(mods: { metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): Disposition {
  if (mods.altKey) return "split";
  if (mods.metaKey) return "newTab";
  if (mods.shiftKey) return "newWindow";
  return "current";
}

export function commitTypedUrl(url: string, page: { windowId: string; profileId: string; tabId: string }) {
  if (!isGatedUrl(url)) return useBrowser.getState().navigate(page.tabId, url);
  const consent = consentToken();
  const gated = gateOpening(url, { ...page, via: "typed" }, `tab:${page.tabId}`);
  settleOpening(gated, `tab:${page.tabId}`, (verdict) => {
    if (verdict && "cancel" in verdict) return;
    const s = useBrowser.getState();
    if (!s.tabs[page.tabId]) return;
    const target = verdict?.url ?? url;
    if (!routedInApp(target, page, "typed", consent)) return s.navigate(page.tabId, target, { userInitiated: !verdict, gated: true });
    const after = useBrowser.getState();
    if (after.windowUi[page.windowId]?.panel.open) after.closePanel(page.windowId);
  });
}

export function openFromBar(url: string, tabId: string, disposition: Disposition, typedUrl = false) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!url || !tab) return;
  const w = s.windows[tab.windowId];
  if (disposition === "current") {
    if (typedUrl) commitTypedUrl(url, { windowId: tab.windowId, profileId: tab.profileId, tabId });
    else s.navigate(tabId, url);
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
  const open = (target: string, gated: boolean) => {
    const now = useBrowser.getState();
    if (disposition === "newTab") return void now.newTab(tab.windowId, { url: target, profileId: tab.profileId, openerId: tab.url && now.tabs[tabId] ? tabId : undefined, gated });
    openWindow(w?.kind === "private" ? { kind: "private", url: target, profileId: originalProfile(now, w) } : { profileId: tab.profileId, url: target });
  };
  if (typedUrl) return openTypedElsewhere(url, { windowId: tab.windowId, profileId: tab.profileId, tabId }, open);
  open(url, false);
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
