import type { GroupPlacement } from "../pins/tabGrouping";
import type { StateCreator } from "zustand";
import type { BrowserState } from "../browser/store";
import { bookmarkProfileId, isPinnedRow, newId, pinKeyOf, snapshotTab, tabTitle } from "../browser/model";
import { closingGroup, nestedSnapshot, rebuildNested, restoreSnapshots } from "../pins/closedTabs";
import { groupLabel, movingGroup, withGroup, withRowsGrouped } from "../pins/tabGrouping";
import { withSplitRows } from "../splits/splits";
import { removeTabs, withNewTab } from "../tabs/tabs";
import type { BrowserWindow, ClosedGroup, ClosedGroupInfo, GroupColor, Tab, TabGroup } from "../browser/types";
import { depthsIn, descendantIds, innermostGroupOf, nestGroups, reparent } from "./groupNesting";
import { withShownTab, withoutShownTabs } from "./shownTabs";
import { pinnedGroupMembers } from "../browser/structure";
import { newTabHome } from "../tabs/newTabHome";
import { groupingOnto } from "../pins/placing";
import type { CloseOptions } from "../tabs/tabs";
import { isRegularWindow } from "../windows/small";
import { noteSharedGroupUngroup, noteSharedGroupUnpin } from "../telemetry/sharedGroupCounts";
import { keepUngroupedTabs, unpinsMirrors, withMirrorsUnpinned } from "./sharedUngroupSplits";

export { ancestorIds, canNest, commonGroup, depthOf, depthsIn, descendantIds, groupPath, innermostGroupOf, nestGroups, reparent, rootOf, rootsIn, withParent } from "./groupNesting";

type GroupTabsOptions = { pinned?: boolean; name?: string };

export type GroupsSlice = {
  groups: Record<string, TabGroup>;

  createGroup(tabIds: string[], options?: { name?: string; icon?: string | null; color?: GroupColor | null }): string;
  updateGroup(id: string, patch: Partial<Pick<TabGroup, "name" | "icon" | "color" | "collapsed" | "pinned" | "shownTabIds">>): void;
  addTabsToGroup(groupId: string, tabIds: string[]): void;
  removeTabsFromGroup(tabIds: string[]): void;
  ungroup(groupId: string): void;
  newNestedGroup(parentId: string): string;
  closeGroup(groupId: string, options?: CloseOptions): void;
  deleteGroup(groupId: string, options?: CloseOptions): void;
  closedGroups: ClosedGroup[];
  deletedGroups: ClosedGroup[];
  groupTabs(ids: string[], options?: GroupTabsOptions): string;
  groupOnto(ids: string[], targetId: string): string;
  moveGroup(groupId: string, placement: GroupPlacement): void;
  duplicateGroup(groupId: string): string;
  newTabInGroup(groupId: string): string;
  moveGroupToBookmarksBar(groupId: string, options?: CloseOptions): void;
};

export function syncGroupOrder(groups: Record<string, TabGroup>, window: BrowserWindow): Record<string, TabGroup> {
  groups = nestGroups(groups);
  const at = new Map(window.tabIds.map((id, i) => [id, i]));
  let next: Record<string, TabGroup> | null = null;
  for (const g of Object.values(groups)) {
    if (g.windowId !== window.id) continue;
    if (g.tabIds.every((id, i) => at.has(id) && (i === 0 || at.get(id)! > at.get(g.tabIds[i - 1]!)!))) continue;
    const members = new Set(g.tabIds);
    (next ??= { ...groups })[g.id] = { ...g, tabIds: window.tabIds.filter((id) => members.has(id)) };
  }
  return next ?? groups;
}

export function orderSections(ids: string[], tabs: Record<string, Tab>, groups: Record<string, TabGroup>): string[] {
  const pinnedGroup = pinnedGroupMembers(groups);
  const rank = (id: string) => (tabs[id]?.pin ? (isPinnedRow(tabs[id]) ? 1 : 0) : pinnedGroup.has(id) ? 1 : 2);
  const out = [0, 1, 2].flatMap((r) => ids.filter((id) => rank(id) === r));
  return out.every((id, i) => id === ids[i]) ? ids : out;
}

export function insertAll(list: string[], at: number, items: string[]) {
  const tail = list.splice(at);
  for (const x of items) list.push(x);
  for (const x of tail) list.push(x);
}

export function placeBlock(tabIds: string[], block: string[]): string[] {
  const members = new Set(block);
  const at = tabIds.findIndex((id) => members.has(id));
  const rest = tabIds.filter((id) => !members.has(id));
  const before = tabIds.slice(0, at).filter((id) => !members.has(id)).length;
  insertAll(rest, before, block);
  return rest;
}

export function placeGroups(tabIds: string[], groups: Record<string, TabGroup>, windowId: string): string[] {
  const depth = depthsIn(groups);
  const own = Object.values(groups)
    .filter((g) => g.windowId === windowId)
    .map((g) => [g, depth(g.id)] as const)
    .sort((a, z) => a[1] - z[1]);
  let at = new Map(tabIds.map((id, i) => [id, i]));
  for (const [g] of own) {
    const spots = g.tabIds.flatMap((id) => at.get(id) ?? []);
    const [low, high] = spots.reduce(([a, z], i) => [Math.min(a, i), Math.max(z, i)], [Infinity, -Infinity]);
    if (!spots.length || high - low + 1 === spots.length) continue;
    const members = new Set(g.tabIds);
    tabIds = placeBlock(tabIds, tabIds.filter((id) => members.has(id)));
    at = new Map(tabIds.map((id, i) => [id, i]));
  }
  return tabIds;
}

export function leaveGroups(groups: Record<string, TabGroup>, ids: Set<string>, keep?: Set<string>): Record<string, TabGroup> {
  if (!Object.values(groups).some((g) => !keep?.has(g.id) && g.tabIds.some((id) => ids.has(id)))) return groups;
  const next: Record<string, TabGroup> = {};
  for (const g of Object.values(groups)) {
    const tabIds = keep?.has(g.id) ? g.tabIds : g.tabIds.filter((id) => !ids.has(id));
    if (tabIds.length === g.tabIds.length) next[g.id] = g;
    else if (tabIds.length > (g.autoUngroup && !g.pinnedOpenerId ? 1 : 0)) next[g.id] = { ...g, tabIds };
  }
  return reparent(next, groups);
}

type GroupInfo = ClosedGroupInfo;

export const closedGroupInfo = (g: TabGroup): GroupInfo => ({ id: g.id, name: g.name, icon: g.icon, color: g.color, ...(g.pinned ? { pinned: true } : {}) });

export function rejoinGroups(
  groups: Record<string, TabGroup>,
  chain: GroupInfo[],
  tabIds: string[],
  windowId: string,
  profileId: string,
  made: Map<string, string> = new Map(),
): Record<string, TabGroup> {
  const here = (info: GroupInfo) => {
    const g = groups[made.get(info.id) ?? info.id];
    return g && g.windowId === windowId && g.profileId === profileId ? g : undefined;
  };
  const at = chain.findIndex(here);
  const next = { ...groups };
  let parentId: string | undefined;
  if (at >= 0) {
    const g = here(chain[at]!)!;
    next[g.id] = { ...g, tabIds: [...g.tabIds, ...tabIds.filter((id) => !g.tabIds.includes(id))] };
    parentId = g.id;
  }
  for (const info of chain.slice(0, at < 0 ? chain.length : at).reverse()) {
    const id = next[info.id] ? newId("g") : info.id;
    const { id: _, name, icon, color } = info;
    next[id] = { id, name, icon, color, windowId, profileId, collapsed: false, pinned: !!info.pinned, tabIds, createdAt: Date.now(), ...(parentId ? { parentId } : {}) };
    made.set(info.id, id);
    parentId = id;
  }
  return nestGroups(next);
}

export function withGroupsPlaced<S extends Pick<BrowserState, "groups" | "windows" | "tabs">>(s: S, windowId: string, groups: Record<string, TabGroup>): S {
  const w = s.windows[windowId]!;
  const tabIds = orderSections(placeGroups(w.tabIds, groups, windowId), s.tabs, groups);
  const window = tabIds.every((id, i) => id === w.tabIds[i]) ? w : { ...w, tabIds };
  return { ...s, windows: window === w ? s.windows : { ...s.windows, [windowId]: window }, groups: syncGroupOrder(groups, window) };
}

export function settleNesting(s: Pick<BrowserState, "groups" | "windows" | "tabs">): Pick<BrowserState, "groups" | "windows"> | null {
  if (!Object.values(s.groups).some((g) => g.parentId)) return null;
  let next = { groups: nestGroups(s.groups), windows: s.windows, tabs: s.tabs };
  for (const windowId of new Set(Object.values(next.groups).filter((g) => g.parentId).map((g) => g.windowId))) {
    if (next.windows[windowId]) next = withGroupsPlaced(next, windowId, next.groups);
  }
  return next.groups === s.groups && next.windows === s.windows ? null : { groups: next.groups, windows: next.windows };
}

export const createGroupsSlice: StateCreator<BrowserState, [], [], GroupsSlice> = (set, get) => ({
  groups: {},
  closedGroups: [],
  deletedGroups: [],

  createGroup(tabIds, options = {}) {
    const [next, id] = withGroup(get(), tabIds, { name: options.name, parentId: null });
    if (!id) return "";
    set({ groups: { ...next.groups, [id]: { ...next.groups[id]!, icon: options.icon ?? null, color: options.color ?? null } }, windows: next.windows });
    return id;
  },

  updateGroup(id, patch) {
    let mirrored = false;
    set((s) => {
      const g = s.groups[id];
      if (!g) return {};
      const hides = patch.shownTabIds?.length === 0;
      const startsOver = patch.collapsed !== undefined && patch.collapsed !== g.collapsed;
      const reset = hides || startsOver ? [id, ...descendantIds(s.groups, id)] : [];
      const groups = withoutShownTabs({ ...s.groups, [id]: { ...g, ...patch } }, reset);
      const w = s.windows[g.windowId];
      if (patch.pinned === undefined || patch.pinned === g.pinned || !w) return { groups };
      const nested = nestGroups(groups);
      const window = { ...w, tabIds: orderSections(w.tabIds, s.tabs, nested) };
      const local = { ...s, groups: syncGroupOrder(nested, window), windows: { ...s.windows, [w.id]: window } };
      mirrored = unpinsMirrors(s, local, id);
      return withMirrorsUnpinned(s, local, id);
    });
    if (mirrored) noteSharedGroupUnpin();
  },

  addTabsToGroup(groupId, tabIds) {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return {};
      const adding = withSplitRows(s, tabIds).filter((id) => {
        const t = s.tabs[id];
        return t && !t.pin && t.windowId === group.windowId && t.profileId === group.profileId && !group.tabIds.includes(id);
      });
      if (!adding.length) return {};
      const w = s.windows[group.windowId]!;
      const block = placeBlock(w.tabIds, [...group.tabIds, ...adding]);
      const nested = nestGroups({ ...leaveGroups(s.groups, new Set(adding)), [groupId]: { ...group, tabIds: [...group.tabIds, ...adding] } });
      const groups = adding.reduce(withShownTab, nested);
      const window = { ...w, tabIds: placeGroups(block, groups, w.id) };
      return { groups: syncGroupOrder(groups, window), windows: { ...s.windows, [w.id]: window } };
    });
  },

  removeTabsFromGroup(tabIds) {
    set((s) => {
      let groups = s.groups;
      const windows = { ...s.windows };
      const touched = new Set<string>();
      const leaving = new Map<string, Set<string>>();
      for (const id of withSplitRows(s, tabIds)) {
        const g = innermostGroupOf(groups, id);
        if (g && windows[g.windowId]) leaving.set(g.id, (leaving.get(g.id) ?? new Set()).add(id));
      }
      for (const [groupId, out] of leaving) {
        const g = groups[groupId]!;
        const w = windows[g.windowId]!;
        touched.add(w.id);
        const kept = g.tabIds.filter((x) => !out.has(x));
        if (kept.length) {
          const order = w.tabIds.filter((x) => !out.has(x));
          insertAll(order, order.indexOf(kept.at(-1)!) + 1, w.tabIds.filter((x) => out.has(x)));
          windows[w.id] = { ...w, tabIds: order };
          groups = { ...groups, [g.id]: { ...g, tabIds: kept } };
        } else {
          const { [g.id]: _, ...rest } = groups;
          groups = reparent(rest, groups);
        }
      }
      let next = { tabs: s.tabs, windows, groups };
      for (const windowId of touched) next = withGroupsPlaced(next, windowId, next.groups);
      return { groups: next.groups, windows: next.windows };
    });
  },

  ungroup(groupId) {
    let mirrored = false;
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return {};
      const shared = group.pinned && s.settings.shareTabsAcrossWindows && isRegularWindow(s.windows[group.windowId]);
      const removing = shared
        ? Object.values(s.groups).filter((g) => g.pinned && g.profileId === group.profileId && pinKeyOf(g) === pinKeyOf(group) && isRegularWindow(s.windows[g.windowId]))
        : [group];
      const rest = { ...s.groups };
      for (const g of removing) delete rest[g.id];
      const groups = reparent(rest, s.groups);
      let next = { tabs: s.tabs, windows: s.windows, groups };
      for (const windowId of new Set(removing.map((g) => g.windowId))) {
        if (s.windows[windowId]) next = withGroupsPlaced(next, windowId, next.groups);
      }
      if (!shared) return { groups: next.groups, windows: next.windows };
      mirrored = new Set(removing.map((g) => g.windowId)).size > 1;
      return keepUngroupedTabs({ ...s, groups: next.groups, windows: next.windows }, group.windowId, new Set(removing.flatMap((g) => g.tabIds)));
    });
    if (mirrored) noteSharedGroupUngroup();
  },

  newNestedGroup(parentId) {
    const s = get();
    const p = s.groups[parentId];
    const w = p && s.windows[p.windowId];
    if (!p || !w) return "";
    const [next, tabId] = withNewTab(s, w.id, { profileId: p.profileId, index: w.tabIds.indexOf(p.tabIds.at(-1)!) + 1 });
    const group: TabGroup = {
      id: newId("g"),
      windowId: w.id,
      profileId: p.profileId,
      name: "",
      icon: null,
      color: null,
      collapsed: false,
      pinned: p.pinned,
      tabIds: [tabId],
      createdAt: Date.now(),
      parentId,
    };
    const groups = nestGroups({ ...next.groups, [parentId]: { ...p, collapsed: false }, [group.id]: group });
    set(withGroupsPlaced(next, w.id, groups));
    return group.id;
  },

  closeGroup(groupId, options) {
    set(closingGroup(get(), groupId, false, options?.userClose));
  },

  deleteGroup(groupId, options) {
    set(closingGroup(get(), groupId, true, options?.userClose));
  },

  groupTabs(ids, { pinned = true, name }: GroupTabsOptions = {}) {
    const [next, id] = withRowsGrouped(get(), ids, { pinned, name });
    if (id) set({ ...next, selection: { ...next.selection, [next.groups[id]!.windowId]: [] } });
    return id;
  },

  groupOnto(ids, targetId) {
    const [next, id] = groupingOnto(get(), ids, targetId);
    if (id) set(next);
    return id;
  },

  moveGroup(groupId, p) {
    let mirrored = false;
    set((s) => {
      const moved = movingGroup(s, groupId, p);
      mirrored = unpinsMirrors(s, { ...s, ...moved }, groupId);
      return moved;
    });
    if (mirrored) noteSharedGroupUnpin();
  },

  duplicateGroup(groupId) {
    let s = get();
    const g = s.groups[groupId];
    const w = g && s.windows[g.windowId];
    if (!g || !w) return "";
    const after = w.tabIds.indexOf(g.tabIds.at(-1)!) + 1;
    const [restored, ids] = restoreSnapshots(
      s,
      w.id,
      g.tabIds.map((id, i) => ({ tab: { ...snapshotTab(s.tabs[id]!), pin: null, lastActiveAt: undefined }, index: after + i })),
    );
    let groupId2: string;
    [s, groupId2] = withGroup(restored, ids, { name: g.name, pinned: g.pinned, parentId: g.parentId ?? null });
    if (groupId2) {
      s = { ...s, groups: { ...s.groups, [groupId2]: { ...s.groups[groupId2]!, icon: g.icon, color: g.color } } };
      s = rebuildNested(s, groupId2, g.id, ids, nestedSnapshot(get(), g));
    }
    set(s);
    return groupId2;
  },

  newTabInGroup(groupId) {
    const s = get();
    const g = s.groups[groupId];
    const w = g && s.windows[g.windowId];
    if (!g || !w) return "";
    const home = newTabHome(s, w.id, g.profileId);
    if (home.cancelled) return "";
    const [next, id] = withNewTab(s, w.id, { url: home.url, replaced: home.replaced, profileId: g.profileId, index: w.tabIds.indexOf(g.tabIds.at(-1)!) + 1 });
    const groups = nestGroups({ ...next.groups, [groupId]: { ...g, collapsed: false, tabIds: [...g.tabIds, id] } });
    set(withGroupsPlaced(next, w.id, groups));
    home.settle(id, get, (tabId) => set(removeTabs(get(), [tabId], false)));
    return id;
  },

  moveGroupToBookmarksBar(groupId, options) {
    const s = get();
    const g = s.groups[groupId];
    if (!g) return;
    const profileId = bookmarkProfileId(s, s.windows[g.windowId]);
    const file = (group: TabGroup, parentId?: string) => {
      const folder = get().addBookmarkFolder({ profileId, title: groupLabel(s, group), ...(parentId ? { parentId } : {}) });
      const children = Object.values(s.groups).filter((c) => c.parentId === group.id);
      const filed = new Set<string>();
      for (const id of group.tabIds) {
        const child = children.find((c) => c.tabIds.includes(id));
        if (child) {
          if (filed.has(child.id)) continue;
          filed.add(child.id);
          file(child, folder);
          continue;
        }
        const t = s.tabs[id];
        if (t?.url) get().addBookmark({ profileId, url: t.url, title: tabTitle(t), favicon: t.favicon, parentId: folder });
      }
    };
    file(g);
    set(closingGroup(get(), groupId, false, options?.userClose));
  },
});
