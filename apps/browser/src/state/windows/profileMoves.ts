import type { BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { isIncognitoProfile, navigationTo, pinKeyOf } from "../browser/model";
import { dropping, type Drop } from "../drag/drops";
import { orderSections } from "../groups/groups";
import { markPinned } from "../pins/pinChoices";
import { isTopApp, topAppsShared } from "../pins/topApps";
import { hasLoadedPage, hasPage, IDLE, loadedPage, withWake } from "../tabs/pageSession";
import { activated, apply, removeTabs } from "../tabs/tabs";
import { splitsWithin, withSplitsBack } from "./groupMoves";

const PLACES_TABS: Drop["type"][] = ["tabs", "folder"];

export function droppingInProfile(s: BrowserState, tabIds: string[], profileId: string, drop: Drop): BrowserState {
  const moving = movableToProfile(s, tabIds, profileId);
  const shown = moving[0];
  if (!shown || !PLACES_TABS.includes(drop.type)) return s;
  const windowId = s.tabs[shown]!.windowId;
  const paired = splitsWithin(s, moving);
  const moved = withSplitsBack(moving.reduce((acc, id) => intoProfile(acc, id, profileId), s), paired, windowId);
  const placed = dropping(moved, moving, drop);
  return apply(placed, activated(placed, shown));
}

export function movableToProfile(s: BrowserState, tabIds: string[], profileId: string): string[] {
  if (!s.profiles[profileId]) return [];
  return tabIds.filter((id) => {
    const tab = s.tabs[id];
    const w = tab && s.windows[tab.windowId];
    if (!tab || !w || w.kind === "private" || isIncognitoProfile(tab.profileId) || tab.profileId === profileId) return false;
    return !(isTopApp(tab) && topAppsShared(s, tab.profileId, profileId));
  });
}

export function intoProfile(s: BrowserState, tabId: string, profileId: string): BrowserState {
  const tab = s.tabs[tabId];
  const w = tab && s.windows[tab.windowId];
  if (!tab || !w || w.kind === "private" || !s.profiles[profileId] || tab.profileId === profileId) return s;
  const next = removeTabs(s, [tabId], false);
  const base = next.windows[w.id] ?? { ...w, tabIds: [], activeTabIds: {} };
  const loaded = hasLoadedPage(tab);
  const moved: Tab = { ...tab, profileId, page: loaded ? loadedPage(navigationTo(tab.url)) : hasPage(tab) ? IDLE : withWake(tab.page, undefined), lastActiveAt: Date.now() };
  const pinChoices = tab.pin ? markPinned(next.pinChoices, profileId, { tabs: [pinKeyOf(moved)], placed: [pinKeyOf(moved)] }) : next.pinChoices;
  const tabs = { ...next.tabs, [tabId]: moved };
  const index = Math.min(w.tabIds.indexOf(tabId), base.tabIds.length);
  const tabIds = [...base.tabIds];
  tabIds.splice(index, 0, tabId);
  return {
    ...next,
    tabs,
    pinChoices,
    windows: { ...next.windows, [w.id]: { ...base, tabIds: orderSections(tabIds, tabs, next.groups) } },
    windowOrder: next.windowOrder.includes(w.id) ? next.windowOrder : s.windowOrder,
  };
}
