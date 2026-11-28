import type { BrowserState } from "../browser/store";
import { activeTabId, viewTabIds } from "../browser/model";
import { folderRows, liveTabOpen, liveTabPlace, type FolderRow } from "../live/rows";
import type { useLive } from "../live/store";

type LiveState = ReturnType<typeof useLive.getState>;

export const liveStrays = (s: BrowserState, windowId: string, profileId: string, folderId: string, itemIds: Set<string>, hiddenIds: Set<string>): string[] =>
  viewTabIds(s, windowId, profileId).filter((id) => s.tabs[id]?.liveItem?.folderId === folderId && liveTabPlace(s.tabs[id]!.liveItem!.itemId, itemIds, hiddenIds) === "stray");

function liveActiveTab(s: BrowserState, windowId: string, profileId: string, folderId: string, itemIds: Set<string>, hiddenIds: Set<string>): string | null {
  const id = activeTabId(s, windowId, profileId) ?? "";
  const liveItem = s.tabs[id]?.liveItem;
  return liveItem?.folderId === folderId && liveTabPlace(liveItem.itemId, itemIds, hiddenIds) !== "hidden" ? id : null;
}

export const liveItemTab = (s: BrowserState, windowId: string, profileId: string, folderId: string, itemId: string): string | null =>
  liveTabOpen(s.tabs, folderId, [itemId]) ? (viewTabIds(s, windowId, profileId).find((id) => s.tabs[id]?.liveItem?.itemId === itemId && s.tabs[id]?.liveItem?.folderId === folderId) ?? null) : null;

export function liveKeptTabs(s: BrowserState, windowId: string, profileId: string, folderId: string, shown: readonly string[], itemIds: Set<string>, hiddenIds: Set<string>): string[] {
  const active = liveActiveTab(s, windowId, profileId, folderId, itemIds, hiddenIds);
  const kept = active ? [active] : [];
  if (!shown.length) return kept;
  const inView = s.windows[windowId]?.tabIds ?? [];
  for (const id of shown) {
    const tab = s.tabs[id];
    if (!tab?.liveItem || kept.includes(id) || tab.profileId !== profileId || tab.liveItem.folderId !== folderId || !inView.includes(id) || liveTabPlace(tab.liveItem.itemId, itemIds, hiddenIds) === "hidden") continue;
    kept.push(id);
  }
  return kept;
}

export function liveFolderKeep(rows: FolderRow[], strays: string[], keptTabs: readonly string[], tabs: BrowserState["tabs"]): string[] {
  const keys: string[] = [];
  for (const tabId of keptTabs) {
    const item = tabs[tabId]?.liveItem?.itemId;
    const key = strays.includes(tabId)
      ? `stray:${tabId}`
      : rows.find((r) => (r.kind === "item" && r.item.id === item) || (r.kind === "stack" && r.items.some((i) => i.id === item)))?.key;
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function liveFolderShowsExtra(rows: FolderRow[], strays: string[], kept: readonly string[], focused: string | undefined, tabs: BrowserState["tabs"]): boolean {
  if (!kept.length) return false;
  const focusedRows = focused && kept.includes(focused) ? liveFolderKeep(rows, strays, [focused], tabs).length : 0;
  return liveFolderKeep(rows, strays, kept, tabs).length > focusedRows;
}

export function liveFolderTabRows(s: BrowserState, l: LiveState, windowId: string, profileId: string, folderId: string): string[][] {
  const folder = l.folders[folderId];
  if (!folder) return [];
  const items = l.items[folderId] ?? [];
  const rows = folderRows(folder, items, l.showAll);
  const itemIds = new Set(items.map((i) => i.id));
  const hiddenIds = new Set([...(l.hidden[folderId] ?? []), ...(l.repoHidden[folderId] ?? [])].map((i) => i.id));
  const strays = liveStrays(s, windowId, profileId, folderId, itemIds, hiddenIds);
  const kept = folder.collapsed ? liveKeptTabs(s, windowId, profileId, folderId, l.shownTabs[folderId] ?? [], itemIds, hiddenIds) : [];
  const keep = new Set(liveFolderKeep(rows, strays, kept, s.tabs));
  const shown = (key: string) => !folder.collapsed || keep.has(key);
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
