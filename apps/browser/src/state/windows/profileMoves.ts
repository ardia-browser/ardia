import type { BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { engineProfile, findLast, isIncognitoSpace, navigationTo, pinKeyOf } from "../browser/model";
import { markPinned } from "../pins/pinChoices";
import { hasLoadedPage, hasPage, IDLE, loadedPage, withWake } from "../tabs/pageSession";
import { isTopApp, topAppsShared } from "../pins/topApps";
import { activated, apply, removeTabs } from "../tabs/tabs";
import { orderSections } from "../groups/groups";
import { dropping, type Drop } from "../drag/drops";
import { isRegularWindow } from "./small";
import { adoptParkedPins } from "../pins/parkedPins";

function sharedTopAppCopy(s: BrowserState, tab: Tab, spaceId: string): string | undefined {
  if (!isTopApp(tab) || !topAppsShared(s, tab.spaceId, spaceId)) return undefined;
  return s.windows[tab.windowId]?.tabIds.find((id) => s.tabs[id]?.spaceId === spaceId && isTopApp(s.tabs[id]!) && pinKeyOf(s.tabs[id]!) === pinKeyOf(tab));
}

const parkedTopAppCopy = (s: BrowserState, tab: Tab, spaceId: string) =>
  isTopApp(tab) && topAppsShared(s, tab.spaceId, spaceId) && !!s.parkedPins[spaceId]?.tabs.some((p) => !p.groupId && p.id === pinKeyOf(tab));

const unvisited = (s: BrowserState, windowId: string, spaceId: string) => !s.windows[windowId]?.tabIds.some((id) => s.tabs[id]?.spaceId === spaceId);

function withParkedPinsShown(s: BrowserState, tabs: Tab[], spaceId: string): BrowserState {
  return [...new Set(tabs.map((t) => t.windowId))].reduce((acc, windowId) => (unvisited(acc, windowId, spaceId) ? adoptParkedPins(acc, windowId, spaceId) : acc), s);
}

export function intoSpace(s: BrowserState, tabId: string, spaceId: string): BrowserState {
  const tab = s.tabs[tabId];
  const w = tab && s.windows[tab.windowId];
  if (!tab || !w || w.kind === "private" || !s.spaces[spaceId] || tab.spaceId === spaceId) return s;
  const next = removeTabs(s, [tabId], false);
  const base = next.windows[w.id] ?? { ...w, tabIds: [], activeTabIds: {} };
  const loaded = hasLoadedPage(tab);
  const moved: Tab = { ...tab, spaceId, page: engineProfile(s, tab.spaceId) === engineProfile(s, spaceId) ? tab.page : loaded ? loadedPage(navigationTo(tab.url)) : hasPage(tab) ? IDLE : withWake(tab.page, undefined), lastActiveAt: Date.now() };
  const pinChoices = tab.pin ? markPinned(next.pinChoices, spaceId, { tabs: [pinKeyOf(moved)], placed: [pinKeyOf(moved)] }) : next.pinChoices;
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
  ids.map((id) => s.tabs[id]).filter((t): t is Tab => !!t && !isIncognitoSpace(t.spaceId) && isRegularWindow(s.windows[t.windowId]));

const arriving = (s: BrowserState, t: Tab, spaceId: string) => t.spaceId !== spaceId && !sharedTopAppCopy(s, t, spaceId) && !parkedTopAppCopy(s, t, spaceId);

export const placedCopies = (s: BrowserState, tabIds: string[], spaceId: string): Record<string, string> =>
  Object.fromEntries(movable(s, tabIds).map((t) => [t.id, t.spaceId === spaceId ? t.id : (sharedTopAppCopy(s, t, spaceId) ?? t.id)]));

export const movesAcrossSpaces = (s: BrowserState, tabIds: string[], spaceId: string) => movable(s, tabIds).some((t) => arriving(s, t, spaceId));

export type SpaceDrop = { state: BrowserState; placed: Record<string, string> };

export function droppedInSpace(before: BrowserState, tabIds: string[], spaceId: string, drop: Drop): SpaceDrop {
  const none = { state: before, placed: {} };
  if (!before.spaces[spaceId]) return none;
  const dragged = movable(before, tabIds);
  if (!dragged.length || (drop.type === "none" && dragged.every((t) => t.spaceId === spaceId))) return none;
  const s = withParkedPinsShown(before, dragged, spaceId);
  const tabs = movable(s, tabIds);
  const copies = placedCopies(s, tabIds, spaceId);
  const placed = tabs.map((t) => copies[t.id] ?? t.id);
  let next = tabs.reduce((acc, t) => (arriving(s, t, spaceId) ? intoSpace(acc, t.id, spaceId) : acc), s);
  next = dropping(next, placed, drop);
  const last = findLast(placed, (id) => next.tabs[id]?.spaceId === spaceId);
  return { state: last ? apply(next, activated(next, last)) : next, placed: copies };
}
