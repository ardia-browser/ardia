import { useMemo } from "react";
import { useBrowser, type BrowserState } from "../browser/store";
import { usePageProfileId } from "../browser/hooks";
import { activeTabId, tabLabel, viewTabIds } from "../browser/model";
import { movingTabIds, resolveDrop, slotDrop, type DragSource, type DropSpot, type Lane } from "../drag/drops";
import { groupLabel } from "../pins/tabGrouping";
import { folderIn, folderLabel, folderMembers } from "../pins/tileFolders";
import { clickTab } from "../sidebar/actions";
import { groupEntries } from "../sidebar/entries";
import { renameFolder } from "../sidebar/tileFolderUi";
import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { parseEntry } from "../sidebar/entryKey";
import { splitTabIdsOf } from "../splits/splits";

function tuckTarget(s: BrowserState, windowId: string, profileId: string, groupId: string): string | undefined {
  const members = new Set(s.groups[groupId]?.tabIds ?? []);
  let best: string | undefined;
  for (const id of viewTabIds(s, windowId, profileId)) {
    const t = s.tabs[id];
    if (!t || members.has(id)) continue;
    if (!best || t.lastActiveAt > s.tabs[best]!.lastActiveAt) best = id;
  }
  return best;
}


import { stripEntries } from "./stripEntries";
export { stripEntries, type StripDock, type StripEntry, type StripGroupEntry, type StripMember } from "./stripEntries";

type FolderMenuItem = ChoiceItem<{ tabId: string }>;

export function tileFolderMenuItems(s: BrowserState, windowId: string, folderId: string, activeId: string | undefined): FolderMenuItem[] {
  return [
    ...folderMembers(s, windowId, folderId).map((id): FolderMenuItem => ({ value: { tabId: id }, title: tabLabel(s.tabs[id]!), checked: id === activeId })),
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

export const useStripEntries = (windowId: string, profileId: string) => useBrowser((s) => stripEntries(s, windowId, profileId));

const titleNeedsMemo = new Map<string, { tabs: BrowserState["tabs"]; order: string[] | undefined; signature: string }>();

function titleNeedsSignature(s: BrowserState, windowId: string, profileId: string): string {
  const key = `${windowId}|${profileId}`;
  const order = s.windows[windowId]?.tabIds;
  const cached = titleNeedsMemo.get(key);
  if (cached && cached.tabs === s.tabs && cached.order === order) return cached.signature;
  const signature = computeTitleNeeds(s, windowId, profileId);
  titleNeedsMemo.set(key, { tabs: s.tabs, order, signature });
  if (titleNeedsMemo.size > 16) for (const k of titleNeedsMemo.keys()) if (!s.windows[k.split("|")[0]!]) titleNeedsMemo.delete(k);
  return signature;
}

export function needingTitles(icons: readonly (readonly [id: string, icon: string])[]): string[] {
  const seen = new Map<string, number>();
  for (const [, icon] of icons) if (icon) seen.set(icon, (seen.get(icon) ?? 0) + 1);
  return icons.filter(([, icon]) => !icon || seen.get(icon)! > 1).map(([id]) => id);
}

function computeTitleNeeds(s: BrowserState, windowId: string, profileId: string): string {
  const icons: [string, string][] = [];
  for (const id of viewTabIds(s, windowId, profileId)) {
    const t = s.tabs[id];
    if (!t || t.pin) continue;
    icons.push([id, t.customIcon ?? t.favicon ?? ""]);
  }
  return needingTitles(icons).join("\n");
}

export function useStripTitleNeeds(windowId: string, profileId: string): (tabId: string) => boolean {
  const signature = useBrowser((s) => titleNeedsSignature(s, windowId, profileId));
  return useMemo(() => {
    const needs = new Set(signature ? signature.split("\n") : []);
    return (tabId: string) => needs.has(tabId);
  }, [signature]);
}

export const useShownTabIdFor = (windowId: string, profileId: string) => useBrowser((s) => s.windows[windowId]?.activeTabIds[profileId] ?? "");

export const useHasTuckTarget = (enabled: boolean, windowId: string, profileId: string, groupId: string) =>
  useBrowser((s) => enabled && !!tuckTarget(s, windowId, profileId, groupId));

export function useTileFolderLabel(windowId: string, folderId: string) {
  const profileId = usePageProfileId();
  return useBrowser((s) => folderLabel(folderIn(s, windowId, folderId, profileId)));
}

export function tuckGroup(windowId: string, profileId: string, groupId: string) {
  const s = useBrowser.getState();
  const target = tuckTarget(s, windowId, profileId, groupId);
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

type StoreMark = object;
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
