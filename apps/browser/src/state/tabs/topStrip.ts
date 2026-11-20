import { useMemo } from "react";
import { useBrowser, type BrowserState } from "../browser/store";
import { usePageSpaceId } from "../browser/hooks";
import { activeTabId, tabLabel, viewTabIds } from "../browser/model";
import { groupIndex, splitIndex, stableList } from "../browser/structure";
import { movingTabIds, resolveDrop, slotDrop, type DragSource, type DropSpot, type Lane } from "../drag/drops";
import { hiddenEmptyCard } from "../omnibox/newTabBarPolicy";
import { groupLabel } from "../pins/tabGrouping";
import { folderCell, folderIn, folderLabel, folderMembers, tileFolderOf } from "../pins/tileFolders";
import { clickTab } from "../sidebar/actions";
import { entriesInputs, groupEntries, sameEntriesInputs, type EntriesInputs } from "../sidebar/entries";
import { renameFolder } from "../sidebar/tileFolderUi";
import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { entryKey, parseEntry } from "../sidebar/entryKey";
import { splitTabIds, splitTabIdsOf } from "../splits/splits";

export function tuckTarget(s: BrowserState, windowId: string, spaceId: string, groupId: string): string | undefined {
  const members = new Set(s.groups[groupId]?.tabIds ?? []);
  let best: string | undefined;
  for (const id of viewTabIds(s, windowId, spaceId)) {
    const t = s.tabs[id];
    if (!t || members.has(id)) continue;
    if (!best || t.lastActiveAt > s.tabs[best]!.lastActiveAt) best = id;
  }
  return best;
}


export type StripMember = { kind: "tab"; id: string; group: string | null } | { kind: "split" | "folder"; id: string; tabIds: string[]; group: string | null };
export type StripGroupEntry = { kind: "group"; id: string; collapsed: boolean; members: StripMember[] };
export type StripDock = { kind: "dock"; ids: string[]; members: Map<string, string[]> };
export type StripEntry = StripDock | StripGroupEntry | StripMember;

const stripMemo = new Map<string, { inputs: EntriesInputs; keys: string[]; entries: StripEntry[] }>();

function parseStrip(keys: string[], previousDock: StripDock | undefined): StripEntry[] {
  const out: StripEntry[] = [];
  const groups = new Map<string, StripGroupEntry>();
  const dockKeys: string[] = [];
  for (const key of keys) {
    const [kind, id, a, b] = key.split(":");
    if (kind === "pinned" || kind === "tilefolder") {
      dockKeys.push(key);
      const cell = kind === "tilefolder" ? folderCell(id!) : id!;
      const last = out[out.length - 1];
      const dock = last?.kind === "dock" ? last : { kind: "dock" as const, ids: [], members: new Map<string, string[]>() };
      if (dock !== last) out.push(dock);
      dock.ids.push(cell);
      if (kind === "tilefolder") dock.members.set(cell, a!.split(","));
      continue;
    }
    if (kind === "group") {
      const group: StripGroupEntry = { kind, id: id!, collapsed: a === "1", members: [] };
      groups.set(group.id, group);
      out.push(group);
      continue;
    }
    const member: StripMember = kind === "split" || kind === "folder" ? { kind, id: id!, tabIds: a!.split(","), group: b || null } : { kind: "tab", id: id!, group: a || null };
    const group = member.group ? groups.get(member.group) : undefined;
    if (group) group.members.push(member);
    else out.push(member);
  }
  const dockAt = out.findIndex((e) => e.kind === "dock");
  if (dockAt >= 0 && previousDock && dockSignature.get(previousDock) === dockKeys.join()) out[dockAt] = previousDock;
  else if (dockAt >= 0) dockSignature.set(out[dockAt] as StripDock, dockKeys.join());
  return out;
}

const dockSignature = new WeakMap<StripDock, string>();

function foldersUnderRoots(groups: BrowserState["groups"]): Map<string, string> {
  const folderOf = new Map<string, string>();
  for (const g of Object.values(groups)) {
    if (!g.parentId || groups[g.parentId]?.parentId) continue;
    for (const id of g.tabIds) folderOf.set(id, g.id);
  }
  return folderOf;
}

export function stripEntries(s: BrowserState, windowId: string, spaceId: string): StripEntry[] {
  const key = `${windowId}|${spaceId}`;
  const cached = stripMemo.get(key);
  if (cached && sameEntriesInputs(s, cached.inputs)) return cached.entries;
  const inputs = entriesInputs(s);
  const groups = groupIndex(s.groups);
  const folders = foldersUnderRoots(s.groups);
  const splits = splitIndex(s.splits);
  const seen = new Set<string>();
  const dock: string[] = [];
  const out: string[] = [];
  const activeId = s.windows[windowId]?.activeTabIds[spaceId];
  for (const id of viewTabIds(s, windowId, spaceId)) {
    const t = s.tabs[id]!;
    if (hiddenEmptyCard(s, t)) continue;
    const tileFolder = tileFolderOf(t);
    if (tileFolder) {
      const folderKey = entryKey("tileFolder", tileFolder.id);
      if (!seen.has(folderKey)) dock.push(`tilefolder:${tileFolder.id}:${folderMembers(s, windowId, tileFolder.id, spaceId).join(",")}`);
      seen.add(folderKey);
      if (id === activeId) dock.push(`pinned:${id}`);
      continue;
    }
    if (t.pin) {
      dock.push(`pinned:${id}`);
      continue;
    }
    const group = groups.get(id);
    if (group && !seen.has(group.id)) {
      seen.add(group.id);
      out.push(`group:${group.id}:${group.collapsed ? 1 : 0}`);
    }
    const folder = group && folders.get(id);
    if (folder) {
      if (!seen.has(folder)) out.push(`folder:${folder}:${s.groups[folder]!.tabIds.join(",")}:${group.id}`);
      seen.add(folder);
      continue;
    }
    const split = splits.get(id)?.[0];
    if (split) {
      if (!seen.has(split.id)) out.push(`split:${split.id}:${splitTabIds(split).join(",")}:${group?.id ?? ""}`);
      seen.add(split.id);
      continue;
    }
    out.push(`tab:${id}:${group?.id ?? ""}`);
  }
  const keys = stableList(cached?.keys, [...dock, ...out]);
  const entries = cached && keys === cached.keys ? cached.entries : parseStrip(keys, cached?.entries.find((e): e is StripDock => e.kind === "dock"));
  stripMemo.set(key, { inputs, keys, entries });
  if (stripMemo.size > 8) for (const k of stripMemo.keys()) if (!s.windows[k.split("|")[0]!]) stripMemo.delete(k);
  return entries;
}

type FolderMenuItem = ChoiceItem<{ tabId: string }>;

export function tileFolderMenuItems(s: BrowserState, windowId: string, folderId: string, activeId?: string, spaceId = s.windows[windowId]?.spaceId): FolderMenuItem[] {
  return [
    ...folderMembers(s, windowId, folderId, spaceId).map((id): FolderMenuItem => ({ value: { tabId: id }, title: tabLabel(s.tabs[id]!), checked: id === activeId })),
    { separator: true },
    { id: "rename", title: "Rename…", symbol: "pencil" },
  ];
}

export function folderMenuItems(s: BrowserState, groupId: string, activeId: string | undefined): FolderMenuItem[] {
  return groupEntries(s, groupId).flatMap((entry): FolderMenuItem[] => {
    const { kind, id } = parseEntry(entry);
    if (kind === "group") {
      const g = s.groups[id];
      return g ? [{ id: entry, title: groupLabel(s, g), symbol: "folder", children: folderMenuItems(s, id, activeId) }] : [];
    }
    const tabIds = kind === "split" ? (splitTabIdsOf(s.splits[id]) ?? []) : [id];
    return tabIds.flatMap((t): FolderMenuItem[] => (s.tabs[t] ? [{ value: { tabId: t }, title: tabLabel(s.tabs[t]!), checked: t === activeId }] : []));
  });
}

export const useStripEntries = (windowId: string, spaceId: string) => useBrowser((s) => stripEntries(s, windowId, spaceId));

const titleNeedsMemo = new Map<string, { tabs: BrowserState["tabs"]; order: string[] | undefined; signature: string }>();

export function titleNeedsSignature(s: BrowserState, windowId: string, spaceId: string): string {
  const key = `${windowId}|${spaceId}`;
  const order = s.windows[windowId]?.tabIds;
  const cached = titleNeedsMemo.get(key);
  if (cached && cached.tabs === s.tabs && cached.order === order) return cached.signature;
  const signature = computeTitleNeeds(s, windowId, spaceId);
  titleNeedsMemo.set(key, { tabs: s.tabs, order, signature });
  if (titleNeedsMemo.size > 16) for (const k of titleNeedsMemo.keys()) if (!s.windows[k.split("|")[0]!]) titleNeedsMemo.delete(k);
  return signature;
}

export function needingTitles(icons: readonly (readonly [id: string, icon: string])[]): string[] {
  const seen = new Map<string, number>();
  for (const [, icon] of icons) if (icon) seen.set(icon, (seen.get(icon) ?? 0) + 1);
  return icons.filter(([, icon]) => !icon || seen.get(icon)! > 1).map(([id]) => id);
}

function computeTitleNeeds(s: BrowserState, windowId: string, spaceId: string): string {
  const icons: [string, string][] = [];
  for (const id of viewTabIds(s, windowId, spaceId)) {
    const t = s.tabs[id];
    if (!t || t.pin) continue;
    icons.push([id, t.customIcon ?? t.favicon ?? ""]);
  }
  return needingTitles(icons).join("\n");
}

export function useStripTitleNeeds(windowId: string, spaceId: string): (tabId: string) => boolean {
  const signature = useBrowser((s) => titleNeedsSignature(s, windowId, spaceId));
  return useMemo(() => {
    const needs = new Set(signature ? signature.split("\n") : []);
    return (tabId: string) => needs.has(tabId);
  }, [signature]);
}

export const useShownTabIdFor = (windowId: string, spaceId: string) => useBrowser((s) => s.windows[windowId]?.activeTabIds[spaceId] ?? "");

export const useHasTuckTarget = (enabled: boolean, windowId: string, spaceId: string, groupId: string) =>
  useBrowser((s) => enabled && !!tuckTarget(s, windowId, spaceId, groupId));

export function useTileFolderLabel(windowId: string, folderId: string) {
  const profileId = usePageSpaceId();
  return useBrowser((s) => folderLabel(folderIn(s, windowId, folderId, profileId)));
}

export function tuckGroup(windowId: string, spaceId: string, groupId: string) {
  const s = useBrowser.getState();
  const target = tuckTarget(s, windowId, spaceId, groupId);
  if (target) s.activate(target);
}

export function inPinnedGroup(tabId: string | undefined): boolean {
  const groups = useBrowser.getState().groups;
  return !!tabId && Object.values(groups).some((g) => g.pinned && g.tabIds.includes(tabId));
}

export const currentMovingTabIds = (tabId: string) => movingTabIds(useBrowser.getState(), tabId);

export function dropTabsInSlot(ids: string[], slots: Parameters<typeof slotDrop>[2], from: number, to: number, lane: Lane): boolean {
  const s = useBrowser.getState();
  return s.dropTabs(ids, slotDrop(s, ids, slots, from, to, lane));
}

export function dropTabsAt(ids: string[], source: DragSource, spot: DropSpot): boolean {
  const s = useBrowser.getState();
  return s.dropTabs(ids, resolveDrop(s, source, spot));
}

export function moveInGroup(groupId: string, beforeId: string | null) {
  const s = useBrowser.getState();
  s.dropTabs([], resolveDrop(s, { kind: "group", groupId }, { zone: s.groups[groupId]?.pinned ? "pinnedRows" : "list", beforeId }));
}

export type StoreMark = object;
export const storeMark = (): StoreMark => useBrowser.getState();
export const storeChangedSince = (mark: StoreMark) => useBrowser.getState() !== mark;

export async function openFolderMenu(windowId: string, groupId: string) {
  const s = useBrowser.getState();
  const choice = await chooseFromMenu(folderMenuItems(s, groupId, activeTabId(s, windowId)));
  if (typeof choice === "object" && choice && useBrowser.getState().tabs[choice.tabId]) clickTab(windowId, choice.tabId);
}

export async function openTileFolderStripMenu(windowId: string, folderId: string) {
  const s = useBrowser.getState();
  const choice = await chooseFromMenu(tileFolderMenuItems(s, windowId, folderId, activeTabId(s, windowId)));
  if (choice === "rename") void renameFolder(windowId, folderId);
  else if (typeof choice === "object" && choice && useBrowser.getState().tabs[choice.tabId]) clickTab(windowId, choice.tabId);
}
