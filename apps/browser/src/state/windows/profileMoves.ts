import type { BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { findLast, isIncognitoProfile, navigationTo, pinKeyOf } from "../browser/model";
import { markPinned } from "../pins/pinChoices";
import { hasLoadedPage, hasPage, IDLE, loadedPage, withWake } from "../tabs/pageSession";
import { isTopApp, topAppsShared } from "../pins/topApps";
import { activated, apply, removeTabs } from "../tabs/tabs";
import { orderSections } from "../groups/groups";
import { dropping, type Drop } from "../drag/drops";
import { isRegularWindow } from "./small";

function sharedTopAppCopy(s: BrowserState, tab: Tab, profileId: string): string | undefined {
  if (!isTopApp(tab) || !topAppsShared(s, tab.profileId, profileId)) return undefined;
  return s.windows[tab.windowId]?.tabIds.find((id) => s.tabs[id]?.profileId === profileId && isTopApp(s.tabs[id]!) && pinKeyOf(s.tabs[id]!) === pinKeyOf(tab));
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

export function droppedInProfile(s: BrowserState, tabIds: string[], profileId: string, drop: Drop): BrowserState {
  if (!s.profiles[profileId]) return s;
  const tabs = tabIds.map((id) => s.tabs[id]).filter((t): t is Tab => !!t && t.profileId !== profileId && !isIncognitoProfile(t.profileId) && isRegularWindow(s.windows[t.windowId]));
  if (!tabs.length) return s;
  const copies = new Map(tabs.map((t) => [t.id, sharedTopAppCopy(s, t, profileId)]));
  const placed = tabs.map((t) => copies.get(t.id) ?? t.id);
  let next = tabs.reduce((acc, t) => (copies.get(t.id) ? acc : intoProfile(acc, t.id, profileId)), s);
  next = dropping(next, placed, drop);
  const last = findLast(placed, (id) => next.tabs[id]?.profileId === profileId);
  return last ? apply(next, activated(next, last)) : next;
}
