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
import { adoptParkedPins } from "../pins/parkedPins";

function sharedTopAppCopy(s: BrowserState, tab: Tab, profileId: string): string | undefined {
  if (!isTopApp(tab) || !topAppsShared(s, tab.profileId, profileId)) return undefined;
  return s.windows[tab.windowId]?.tabIds.find((id) => s.tabs[id]?.profileId === profileId && isTopApp(s.tabs[id]!) && pinKeyOf(s.tabs[id]!) === pinKeyOf(tab));
}

const parkedTopAppCopy = (s: BrowserState, tab: Tab, profileId: string) =>
  isTopApp(tab) && topAppsShared(s, tab.profileId, profileId) && !!s.parkedPins[profileId]?.tabs.some((p) => !p.groupId && p.id === pinKeyOf(tab));

const unvisited = (s: BrowserState, windowId: string, profileId: string) => !s.windows[windowId]?.tabIds.some((id) => s.tabs[id]?.profileId === profileId);

function withParkedPinsShown(s: BrowserState, tabs: Tab[], profileId: string): BrowserState {
  return [...new Set(tabs.map((t) => t.windowId))].reduce((acc, windowId) => (unvisited(acc, windowId, profileId) ? adoptParkedPins(acc, windowId, profileId) : acc), s);
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

const movable = (s: BrowserState, ids: string[]) =>
  ids.map((id) => s.tabs[id]).filter((t): t is Tab => !!t && !isIncognitoProfile(t.profileId) && isRegularWindow(s.windows[t.windowId]));

const arriving = (s: BrowserState, t: Tab, profileId: string) => t.profileId !== profileId && !sharedTopAppCopy(s, t, profileId) && !parkedTopAppCopy(s, t, profileId);

export const placedCopies = (s: BrowserState, tabIds: string[], profileId: string): Record<string, string> =>
  Object.fromEntries(movable(s, tabIds).map((t) => [t.id, t.profileId === profileId ? t.id : (sharedTopAppCopy(s, t, profileId) ?? t.id)]));

export const movesAcrossProfiles = (s: BrowserState, tabIds: string[], profileId: string) => movable(s, tabIds).some((t) => arriving(s, t, profileId));

export function droppedInProfile(before: BrowserState, tabIds: string[], profileId: string, drop: Drop): BrowserState {
  if (!before.profiles[profileId]) return before;
  const dragged = movable(before, tabIds);
  if (!dragged.length || (drop.type === "none" && dragged.every((t) => t.profileId === profileId))) return before;
  const s = withParkedPinsShown(before, dragged, profileId);
  const tabs = movable(s, tabIds);
  const copies = placedCopies(s, tabIds, profileId);
  const placed = tabs.map((t) => copies[t.id] ?? t.id);
  let next = tabs.reduce((acc, t) => (arriving(s, t, profileId) ? intoProfile(acc, t.id, profileId) : acc), s);
  next = dropping(next, placed, drop);
  const last = findLast(placed, (id) => next.tabs[id]?.profileId === profileId);
  return last ? apply(next, activated(next, last)) : next;
}
