import type { BrowserState } from "../browser/store";
import { activeTabId, isPinnedRow, viewTabIds } from "../browser/model";
import { hiddenEmptyCard } from "../omnibox/newTabBarPolicy";
import { changedIds } from "../browser/changes";
import type { Tab } from "../browser/types";
import { hasPage } from "../tabs/pageSession";
import { splitRowPanes, splitTabIds, splitTabIdsOf } from "../splits/splits";
import { groupIndex, splitIndex, stableList } from "../browser/structure";
import { tileCells } from "../pins/tileFolders";
import { entryKey, parseEntry } from "./entryKey";
import { sameList } from "../../lib/lists";

type SidebarEntries = { tiles: string[]; cells: string[]; pinned: string[]; list: string[] };

export const ENTRY_TAB_FIELDS = ["pin", "liveItem", "profileId", "url", "page"] as const satisfies readonly (keyof Tab)[];

const placesAlike = (a: Tab | undefined, b: Tab | undefined) =>
  a === b || (!!a && !!b && a.pin === b.pin && a.liveItem === b.liveItem && a.profileId === b.profileId && !a.url === !b.url && hasPage(a) === hasPage(b));

function sameEntryTabs(tabs: BrowserState["tabs"], was: BrowserState["tabs"]): boolean {
  if (tabs === was) return true;
  for (const id of changedIds(tabs, was)) if (!placesAlike(tabs[id], was[id])) return false;
  return true;
}

export type EntriesInputs = Pick<BrowserState, "tabs" | "windows" | "groups" | "splits"> & Pick<BrowserState["settings"], "newTabOpens" | "minimalismMode">;

export const entriesInputs = (s: BrowserState): EntriesInputs => ({
  tabs: s.tabs,
  windows: s.windows,
  groups: s.groups,
  splits: s.splits,
  newTabOpens: s.settings.newTabOpens,
  minimalismMode: s.settings.minimalismMode,
});

export function sameEntriesInputs(s: BrowserState, was: EntriesInputs): boolean {
  const same =
    s.windows === was.windows &&
    s.groups === was.groups &&
    s.splits === was.splits &&
    s.settings.newTabOpens === was.newTabOpens &&
    s.settings.minimalismMode === was.minimalismMode &&
    sameEntryTabs(s.tabs, was.tabs);
  if (same) was.tabs = s.tabs;
  return same;
}

const memo = new Map<string, Map<string, { inputs: EntriesInputs; result: SidebarEntries }>>();

export function sidebarEntries(s: BrowserState, windowId: string, profileId?: string): SidebarEntries {
  let byProfile = memo.get(windowId);
  const cached = byProfile?.get(profileId ?? "");
  if (cached && sameEntriesInputs(s, cached.inputs)) return cached.result;
  const inputs = entriesInputs(s);
  let result = computeEntries(s, windowId, profileId);
  if (cached) {
    const was = cached.result;
    const tiles = sameList(result.tiles, was.tiles) ? was.tiles : result.tiles;
    const cells = sameList(result.cells, was.cells) ? was.cells : result.cells;
    const pinned = sameList(result.pinned, was.pinned) ? was.pinned : result.pinned;
    const list = sameList(result.list, was.list) ? was.list : result.list;
    result = tiles === was.tiles && cells === was.cells && pinned === was.pinned && list === was.list ? was : { tiles, cells, pinned, list };
  }
  if (!byProfile) memo.set(windowId, (byProfile = new Map()));
  byProfile.set(profileId ?? "", { inputs, result });
  if (memo.size > 8) for (const k of memo.keys()) if (!s.windows[k]) memo.delete(k);
  return result;
}

function computeEntries(s: BrowserState, windowId: string, profileId?: string): SidebarEntries {
  const tiles: string[] = [];
  const pinned: string[] = [];
  const list: string[] = [];
  const rootGroups = groupIndex(s.groups);
  const splits = splitIndex(s.splits);
  const seen = new Set<string>();
  for (const id of viewTabIds(s, windowId, profileId)) {
    const tab = s.tabs[id]!;
    if ((tab.liveItem && !tab.pin) || hiddenEmptyCard(s, tab)) continue;
    if (tab.pin) {
      if (!isPinnedRow(tab)) tiles.push(id);
      else {
        const entry = pinnedRowEntry(s, id, splits);
        if (!seen.has(entry)) pinned.push(entry);
        seen.add(entry);
      }
      continue;
    }
    const groupId = rootGroups.get(id)?.id;
    const entry = groupId ? entryKey("group", groupId) : splitEntry(s, id, splits);
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (groupId && s.groups[groupId]!.pinned) pinned.push(entry);
    else list.push(entry);
  }
  return { tiles, cells: tileCells(s.tabs, tiles), pinned, list };
}

export function numberedTabs(s: BrowserState, windowId: string): string[] {
  const { tiles, pinned, list } = sidebarEntries(s, windowId);
  const active = activeTabId(s, windowId);
  const profileId = s.windows[windowId]?.profileId;
  const latest = (ids: string[]) => ids.reduce<string | undefined>((a, b) => (!a || s.tabs[b]!.lastActiveAt > s.tabs[a]!.lastActiveAt ? b : a), undefined);
  const collapsedGroup = (groupId: string): string[] => {
    const keptRows = profileId ? keptEntries(s, windowId, profileId, groupId) : [];
    const kept = keptRows.flatMap(rowTab);
    const onScreen = new Set(keptRows.flatMap((entry) => entryTabIds(s, entry)));
    const members = s.groups[groupId]!.tabIds.filter((id) => s.tabs[id]);
    const header = latest(members.filter((id) => !onScreen.has(id))) ?? latest(members);
    return header ? [header, ...kept] : kept;
  };
  const rowTab = (entry: string): string[] => {
    const { kind, id } = parseEntry(entry);
    if (kind === "group") return s.groups[id]?.collapsed ? collapsedGroup(id) : groupEntries(s, id).flatMap(rowTab);
    if (kind !== "split") return [id];
    const panes = splitRowPanes(s, s.splits[id]);
    if (active && panes.includes(active)) return [active];
    const last = latest(panes);
    return last ? [last] : [];
  };
  return [...tiles, ...pinned.flatMap(rowTab), ...list.flatMap(rowTab)];
}

const groupMemo = new WeakMap<object, { tabs: BrowserState["tabs"]; splits: BrowserState["splits"]; groupsId: number; result: string[] }>();

const groupsIds = new WeakMap<object, number>();
let lastGroupsId = 0;

function groupsIdOf(groups: BrowserState["groups"]): number {
  let id = groupsIds.get(groups);
  if (id === undefined) groupsIds.set(groups, (id = ++lastGroupsId));
  return id;
}

const childIndex = new WeakMap<object, Map<string, BrowserState["groups"][string][]>>();
const NO_CHILDREN: BrowserState["groups"][string][] = [];

function childGroups(groups: BrowserState["groups"], parentId: string): BrowserState["groups"][string][] {
  let index = childIndex.get(groups);
  if (!index) {
    index = new Map();
    for (const g of Object.values(groups)) {
      if (!g.parentId) continue;
      const siblings = index.get(g.parentId);
      if (siblings) siblings.push(g);
      else index.set(g.parentId, [g]);
    }
    childIndex.set(groups, index);
  }
  return index.get(parentId) ?? NO_CHILDREN;
}

export function keptEntry(s: BrowserState, windowId: string, profileId: string, entries: string[]): string | null {
  const active = activeTabId(s, windowId, profileId);
  if (!active) return null;
  return entries.find((e) => holdsTab(s, e, active)) ?? null;
}

export function keptEntries(s: BrowserState, windowId: string, profileId: string, groupId: string): string[] {
  const shown = s.groups[groupId]?.shownTabIds ?? [];
  const active = activeTabId(s, windowId, profileId);
  const held = active ? [active, ...shown] : shown;
  return groupEntries(s, groupId).filter((e) => held.some((id) => holdsTab(s, e, id)));
}

export function showsExtraTabs(s: BrowserState, windowId: string, profileId: string, groupId: string): boolean {
  const active = activeTabId(s, windowId, profileId);
  return keptEntries(s, windowId, profileId, groupId).some((entry) => {
    if (!active || !holdsTab(s, entry, active)) return true;
    const { kind, id } = parseEntry(entry);
    return kind === "group" && !!s.groups[id]?.collapsed && showsExtraTabs(s, windowId, profileId, id);
  });
}

function entryTabIds(s: BrowserState, entry: string): string[] {
  const { kind, id } = parseEntry(entry);
  if (kind === "group") return s.groups[id]?.tabIds ?? [];
  if (kind === "split") return splitTabIdsOf(s.splits[id]) ?? [];
  return [id];
}

export function holdsTab(s: BrowserState, entry: string, tabId: string): boolean {
  const { kind, id } = parseEntry(entry);
  if (kind === "group") return !!s.groups[id]?.tabIds.includes(tabId);
  if (kind === "split") return !!splitTabIdsOf(s.splits[id])?.includes(tabId);
  return id === tabId;
}

export function groupEntries(s: BrowserState, groupId: string): string[] {
  const g = s.groups[groupId];
  if (!g) return [];
  const cached = groupMemo.get(g);
  const groupsId = groupsIdOf(s.groups);
  if (cached && cached.splits === s.splits && cached.groupsId === groupsId && sameEntryTabs(s.tabs, cached.tabs)) {
    cached.tabs = s.tabs;
    return cached.result;
  }
  const splits = splitIndex(s.splits);
  const childOf = new Map<string, string>();
  for (const c of childGroups(s.groups, groupId)) for (const id of c.tabIds) childOf.set(id, c.id);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of g.tabIds) {
    const child = childOf.get(id);
    const entry = child ? entryKey("group", child) : splitEntry(s, id, splits);
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  const result = stableList(cached?.result, out);
  groupMemo.set(g, { tabs: s.tabs, splits: s.splits, groupsId, result });
  return result;
}

function pinnedRowEntry(s: BrowserState, tabId: string, splits: ReturnType<typeof splitIndex>): string {
  for (const v of splits.get(tabId) ?? []) if (splitRowPanes(s, v).includes(tabId)) return entryKey("split", v.id);
  return entryKey("tab", tabId);
}

function splitEntry(s: BrowserState, tabId: string, splits = splitIndex(s.splits)): string {
  for (const v of splits.get(tabId) ?? []) {
    if (splitTabIds(v).filter((id) => s.tabs[id] && !s.tabs[id]!.pin).length >= 2) return entryKey("split", v.id);
  }
  return entryKey("tab", tabId);
}
