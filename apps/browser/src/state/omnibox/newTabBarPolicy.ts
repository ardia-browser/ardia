import type { BrowserState } from "../browser/store";
import { closesWindow, pinnedItemsRemain, viewTabIds } from "../browser/model";
import { splitOf } from "../splits/splits";
import type { Tab } from "../browser/types";
import { hasPage, isAsleep } from "../tabs/pageSession";
import { keptWithTopApp } from "../tabs/tabs";
import { newTabOpensOf } from "../settings/settings";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";

export const NEW_TAB_BAR_POLICY = {
  closeTabKeyOnlyDismissesBar: true,
  dismissOnWindowDeactivation: !PLATFORM_FEATURES.holdsBarOnKeyLoss,
  showOnceOverNewEmptyWindow: true,
  showOnLaunch: true,
  closingLastTabLeavesEmptyWindow: true,
};

export const newTabOpensBar = (s: Pick<BrowserState, "settings">) => newTabOpensOf(s.settings) === "commandBar";

export function isEmptyCardTab(s: Pick<BrowserState, "splits">, tab: Tab | undefined): tab is Tab {
  return !!tab && !tab.pin && !tab.url && !hasPage(tab) && !splitOf(s as BrowserState, tab.id);
}

export const hiddenEmptyCard = (s: BrowserState, tab: Tab) => !tab.pin && newTabOpensBar(s) && isEmptyCardTab(s, tab);

export function closesBesideKeptTopApps(s: BrowserState, id: string): boolean {
  const tab = s.tabs[id];
  const w = tab && s.windows[tab.windowId];
  if (!s.settings.keepTopAppsRunning || !w || tab.profileId !== w.profileId || !isEmptyCardTab(s, tab)) return false;
  return viewTabIds(s, w.id).every((t) => t === id || isAsleep(s.tabs[t]!) || keptWithTopApp(s, t));
}

export const lastTabOfWindow = (s: BrowserState, id: string) => closesWindow(s, id) || closesBesideKeptTopApps(s, id);

let lastTabKeepsWindow = false;
export const setLastTabKeepsWindow = (keeps: boolean) => void (lastTabKeepsWindow = keeps);

export function leavesEmptyWindow(s: BrowserState, id: string): boolean {
  const tab = s.tabs[id];
  const w = tab && s.windows[tab.windowId];
  if (!w || w.kind === "small") return false;
  if (lastTabKeepsWindow) return lastTabOfWindow(s, id);
  if (!isEmptyCardTab(s, tab) && pinnedItemsRemain(s, id)) return closesWindow(s, id);
  if (!NEW_TAB_BAR_POLICY.closingLastTabLeavesEmptyWindow || !newTabOpensBar(s)) return false;
  if (w.kind === "private" || isEmptyCardTab(s, tab)) return false;
  return closesWindow(s, id);
}
