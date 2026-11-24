import { withEntry } from "../browser/changes";
import type { BrowserState } from "../browser/store";
import { rejoinGroups } from "../groups/groups";
import { withShownTab } from "../groups/shownTabs";
import { findLast, inPinnedContainer, isIncognitoProfile, makeTab, newId, pinKeyOf, resolveWindowId } from "../browser/model";
import { restoreId } from "../tabs/adoptIds";
import { adoptedPage, hasPage } from "../tabs/pageSession";
import { adoptParkedPins } from "../pins/parkedPins";
import { holderOf, swapPinPage } from "../pins/pinShare";
import { isOpenRegularWindow, lastActiveProfile } from "./small";
import { activated, apply, withNewTab } from "../tabs/tabs";
import type { ClosedTab, ClosedWindow, SplitView, TabGroup } from "../browser/types";
import { mapSlotIds, slotTabIds } from "../splits/splits";
import { emptyWindow, smallWindow, withWindow } from "./newWindow";
import { orderSections } from "../groups/groups";
import { clearableRecentlyClosed, newestClosed } from "./recentlyClosedList";

function restoreGroup(groups: Record<string, TabGroup>, g: Omit<TabGroup, "tabIds">, tabIds: string[]): [Record<string, TabGroup>, string] {
  const id = groups[g.id] ? newId("g") : g.id;
  return [{ ...groups, [id]: { ...g, id, tabIds } }, id];
}

function shownProfile(s: BrowserState, windowId: string | undefined, profileId: string | undefined): boolean {
  return !windowId || profileId === s.windows[windowId]!.profileId;
}

export function lastClosedTab(s: BrowserState, windowId: string | undefined): ClosedTab | undefined {
  return findLast(
    s.closedTabs,
    (c) => canRestoreTabInto(s, c, windowId) && (isIncognitoProfile(c.tab.profileId) || shownProfile(s, windowId, c.tab.profileId)),
  );
}

export function lastClosedEntry(s: BrowserState, windowId: string | null | undefined): { id: string; closedAt: number } | undefined {
  const target = resolveWindowId(s, windowId);
  const regular = (p: string | undefined) => s.windows[target ?? ""]?.kind !== "private" && shownProfile(s, target, p);
  const lastWindow = findLast(s.closedWindows, (c) => regular(c.window.profileId));
  const lastGroup = findLast(s.closedGroups, (c) => regular(c.tabs[0]?.profileId));
  return [lastWindow, lastGroup, lastClosedTab(s, target)].reduce<{ id: string; closedAt: number } | undefined>(
    (latest, e) => (e && (!latest || e.closedAt > latest.closedAt) ? e : latest),
    undefined,
  );
}

export function withoutRecentlyClosed(s: BrowserState, windowId: string | null | undefined): { cleared: number; next: Pick<BrowserState, "closedTabs" | "closedWindows" | "closedGroups"> } | undefined {
  const list = clearableRecentlyClosed(s, windowId);
  if (!list) return undefined;
  const reopensNext = lastWindowToRestore(s);
  const shown = newestClosed(list);
  const gone = new Set<string>([...list.tabs, ...list.windows.filter((c) => c !== reopensNext || shown.includes(c)), ...list.groups].map((c) => c.id));
  const next = {
    closedTabs: s.closedTabs.filter((c) => !gone.has(c.id)),
    closedWindows: s.closedWindows.filter((c) => !gone.has(c.id)),
    closedGroups: s.closedGroups.filter((c) => !gone.has(c.id)),
  };
  return gone.size ? { cleared: gone.size, next } : undefined;
}

const closedBefore = (closed: ClosedTab[], entry: ClosedTab) =>
  entry.closeBatch ? closed.filter((c) => c.closeBatch === entry.closeBatch && c.index < entry.index).length : 0;

function canRestoreTabInto(s: BrowserState, c: ClosedTab, windowId: string | undefined): boolean {
  const w = windowId ? s.windows[windowId] : undefined;
  if (isIncognitoProfile(c.tab.profileId)) return c.windowId === windowId;
  return w?.kind !== "private";
}

export function restoreTab(s: BrowserState, entry: ClosedTab, requested?: string | null): BrowserState {
  const owner = entry.tab.profileId;
  const key = entry.pinKey ?? entry.tabId;
  if (entry.pinnedTile && key && entry.tabId && !s.tabs[entry.tabId] && s.parkedPins[owner]?.tabs.some((p) => p.id === key)) {
    const target = resolveWindowId(s, requested);
    let windowId = target && s.windows[target]!.kind !== "private" && s.windows[target]!.profileId === owner ? target : undefined;
    let next = s;
    if (!windowId) {
      windowId = newId("w");
      next = withWindow(next, emptyWindow(windowId, owner, "main", null));
    }
    next = adoptParkedPins(next, windowId, owner);
    const adopted = next.windows[windowId]!.tabIds.find((id) => next.tabs[id]?.profileId === owner && next.tabs[id]!.pin && pinKeyOf(next.tabs[id]!) === key);
    if (adopted) return restoreTab(next, { ...entry, tabId: adopted, restoreFrom: entry.restoreFrom ?? entry.tabId, pinKey: undefined }, windowId);
  }
  const closedTabs = s.closedTabs.filter((c) => c.id !== entry.id);
  if (entry.small && !isIncognitoProfile(entry.tab.profileId)) {
    const id = newId("w");
    const profileId = s.profiles[entry.tab.profileId] ? entry.tab.profileId : lastActiveProfile(s);
    const next = withWindow({ ...s, closedTabs }, smallWindow(id, profileId));
    return withNewTab(next, id, {
      url: entry.tab.url || undefined,
      profileId,
      snapshot: { ...entry.tab, pin: null, profileId },
      adoptId: entry.tabId && entry.tab.url ? restoreId(entry.restoreFrom ?? entry.tabId) : undefined,
    })[0];
  }
  const tile = entry.pinnedTile && entry.tabId ? s.tabs[entry.tabId] : undefined;
  const swapped = tile && !hasPage(tile) && holderOf(s, tile.id) ? swapPinPage({ ...s, closedTabs }, tile.id) : null;
  if (swapped) return apply(swapped.state, activated(swapped.state, swapped.holderId));
  if (tile) {
    const unloaded = !hasPage(tile);
    const tabs = unloaded
      ? withEntry(s.tabs, tile.id, { ...tile, url: entry.tab.url, title: entry.tab.title, favicon: entry.tab.favicon, muted: entry.tab.muted, page: adoptedPage(restoreId(entry.restoreFrom ?? tile.id)) })
      : s.tabs;
    const next: BrowserState = { ...s, closedTabs, tabs };
    return apply(next, activated(next, tile.id));
  }
  const original = s.windows[entry.windowId];
  let windowId = original && canRestoreTabInto(s, entry, original.id) ? original.id : resolveWindowId(s, requested);
  let next: BrowserState = { ...s, closedTabs };
  if (!windowId || !canRestoreTabInto(s, entry, windowId)) {
    if (isIncognitoProfile(entry.tab.profileId)) return next;
    windowId = newId("w");
    next = withWindow(next, emptyWindow(windowId, s.profiles[entry.tab.profileId] ? entry.tab.profileId : s.settings.defaultProfileId, "main", null));
  }
  const w = next.windows[windowId]!;
  const profileId = isIncognitoProfile(entry.tab.profileId) || s.profiles[entry.tab.profileId] ? entry.tab.profileId : w.profileId;
  const [withTab, tabId] = withNewTab(next, windowId, {
    url: entry.tab.url || undefined,
    profileId,
    snapshot: entry.tab,
    index: w.id === entry.windowId ? entry.index - closedBefore(closedTabs, entry) : undefined,
    adoptId: entry.tabId && entry.tab.url ? restoreId(entry.restoreFrom ?? entry.tabId) : undefined,
  });
  next = withTab;
  if (entry.group) next = { ...next, groups: withShownTab(rejoinGroups(next.groups, [entry.group, ...(entry.parents ?? [])], [tabId], windowId, profileId), tabId) };
  return next;
}

export function restoreWindow(s: BrowserState, entry: ClosedWindow): BrowserState {
  const id = newId("w");
  const profileOk = (p: string) => (s.profiles[p] ? p : s.settings.defaultProfileId);
  const w = emptyWindow(id, profileOk(entry.window.profileId), "main", entry.window.frame);
  if (entry.window.restoredFrame) w.restoredFrame = entry.window.restoredFrame;
  if (entry.window.maximized) w.maximized = true;
  if (entry.window.tabLayout) w.tabLayout = entry.window.tabLayout;
  if (entry.window.autoHideTabs !== undefined) w.autoHideTabs = entry.window.autoHideTabs;
  const tabs = { ...s.tabs };
  const ids: string[] = [];
  for (const { active, tabId, ...snap } of entry.tabs) {
    const t = makeTab(id, profileOk(snap.profileId), "", { ...snap, profileId: profileOk(snap.profileId) });
    if (tabId && snap.url) t.page = { kind: "idle", wake: restoreId(tabId) };
    tabs[t.id] = t;
    ids.push(t.id);
    if (active || !w.activeTabIds[t.profileId]) w.activeTabIds[t.profileId] = t.id;
  }
  w.tabIds = orderSections(ids, tabs, {});
  let groups = s.groups;
  const restored = new Map<string, string>();
  for (const { tabIndexes, parentId: _, ...g } of entry.groups) {
    const members = tabIndexes.map((i) => ids[i]).filter((t): t is string => !!t);
    if (!members.length) continue;
    const [next, groupId] = restoreGroup(groups, { ...g, windowId: id }, members);
    groups = next;
    restored.set(g.id, groupId);
  }
  for (const g of entry.groups) {
    const groupId = restored.get(g.id);
    const parent = g.parentId && restored.get(g.parentId);
    if (groupId && parent) groups = { ...groups, [groupId]: { ...groups[groupId]!, parentId: parent } };
  }
  const splits = restoredSplits(s.splits, entry, ids, id);
  let next = withWindow({ ...s, tabs, groups, splits, closedWindows: s.closedWindows.filter((c) => c.id !== entry.id) }, w);
  next = adoptParkedPins(next, id, w.profileId);
  const pin = entry.activePin ? next.windows[id]!.tabIds.find((t) => inPinnedContainer(next, t) && pinKeyOf(next.tabs[t]!) === entry.activePin) : undefined;
  let shown = pin ?? w.activeTabIds[w.profileId] ?? next.windows[id]!.tabIds[0];
  if (!shown) [next, shown] = withNewTab(next, id);
  return apply(next, activated(next, shown));
}

function restoredSplits(splits: Record<string, SplitView>, entry: ClosedWindow, ids: string[], windowId: string): Record<string, SplitView> {
  let next = splits;
  const taken = new Set<string>();
  for (const v of entry.splits ?? []) {
    const slots = mapSlotIds(v.slots, (i) => ids[Number(i)] ?? "");
    const panes = slots.flatMap(slotTabIds);
    if (panes.length < 2 || panes.some((p) => !p || taken.has(p))) continue;
    panes.forEach((p) => taken.add(p));
    const splitId = newId("split");
    next = { ...next, [splitId]: { id: splitId, windowId, orientation: v.orientation, slots } };
  }
  return next;
}

export function lastWindowToRestore(s: BrowserState): ClosedWindow | undefined {
  const entry = s.closedWindows.at(-1);
  if (!entry?.lastWindow || Object.values(s.windows).some(isOpenRegularWindow)) return undefined;
  return entry;
}
