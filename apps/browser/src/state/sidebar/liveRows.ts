import type { BrowserState } from "../browser/store";
import { activeTabId, viewTabIds } from "../browser/model";
import { folderRows, liveTabOpen, liveTabPlace, type FolderRow } from "../live/rows";
import type { useLive } from "../live/store";

type LiveState = ReturnType<typeof useLive.getState>;

export const liveStrays = (s: BrowserState, windowId: string, profileId: string, folderId: string, itemIds: Set<string>, hiddenIds: Set<string>): string[] =>
  viewTabIds(s, windowId, profileId).filter((id) => s.tabs[id]?.liveItem?.folderId === folderId && liveTabPlace(s.tabs[id]!.liveItem!.itemId, itemIds, hiddenIds) === "stray");

export function liveActiveTab(s: BrowserState, windowId: string, profileId: string, folderId: string, itemIds: Set<string>, hiddenIds: Set<string>): string | null {
  const id = activeTabId(s, windowId, profileId) ?? "";
  const liveItem = s.tabs[id]?.liveItem;
  return liveItem?.folderId === folderId && liveTabPlace(liveItem.itemId, itemIds, hiddenIds) !== "hidden" ? id : null;
}

export const liveItemTab = (s: BrowserState, windowId: string, profileId: string, folderId: string, itemId: string): string | null =>
  liveTabOpen(s.tabs, folderId, [itemId]) ? (viewTabIds(s, windowId, profileId).find((id) => s.tabs[id]?.liveItem?.itemId === itemId && s.tabs[id]?.liveItem?.folderId === folderId) ?? null) : null;

export function liveFolderKeep(rows: FolderRow[], strays: string[], activeTab: string | null, activeItem: string | null): string | null {
  if (!activeTab) return null;
  if (strays.includes(activeTab)) return `stray:${activeTab}`;
  return rows.find((r) => (r.kind === "item" && r.item.id === activeItem) || (r.kind === "stack" && r.items.some((i) => i.id === activeItem)))?.key ?? null;
}

export function liveFolderTabRows(s: BrowserState, l: LiveState, windowId: string, profileId: string, folderId: string): string[][] {
  const folder = l.folders[folderId];
  if (!folder) return [];
  const items = l.items[folderId] ?? [];
  const rows = folderRows(folder, items, l.showAll);
  const itemIds = new Set(items.map((i) => i.id));
  const hiddenIds = new Set([...(l.hidden[folderId] ?? []), ...(l.repoHidden[folderId] ?? [])].map((i) => i.id));
  const strays = liveStrays(s, windowId, profileId, folderId, itemIds, hiddenIds);
  const active = liveActiveTab(s, windowId, profileId, folderId, itemIds, hiddenIds);
  const keep = folder.collapsed ? liveFolderKeep(rows, strays, active, active ? (s.tabs[active]?.liveItem?.itemId ?? null) : null) : null;
  const shown = (key: string) => !folder.collapsed || key === keep;
  const tabOf = (itemId: string) => liveItemTab(s, windowId, profileId, folderId, itemId);
  const out: string[][] = [];
  for (const row of rows) {
    if (!shown(row.key)) continue;
    const members = row.kind === "item" ? [row.item] : row.kind === "stack" && l.expandedStacks[row.id] !== false ? row.items : [];
    for (const item of members) {
      const tab = tabOf(item.id);
      if (tab) out.push([tab]);
    }
  }
  for (const id of strays) if (shown(`stray:${id}`)) out.push([id]);
  return out;
}
