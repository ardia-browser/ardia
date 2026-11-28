import { useBrowser, type BrowserState } from "../browser/store";
import { activeTab, pinKeyOf, pinnedSectionTitle } from "../browser/model";
import { ancestorIds } from "../groups/groups";
import { selectedTabIds } from "../pins/organize";
import { groupOf } from "../pins/tabGrouping";
import { noteFolderMovedByPinKey } from "../telemetry/usage";
import type { Tab, TabGroup } from "../browser/types";

type ListSpot = { windowId: string; key: string; end: string; list: string[]; index: number; order: number; groupId: string | null };

const listSpots = new Map<string, ListSpot>();
const folderSpots = new Map<string, ListSpot>();
let spotOrder = 0;
const store = () => useBrowser.getState();

export function movePinnedTitle(s: BrowserState, windowId: string) {
  const tab = activeTab(s, windowId);
  return tab && goesOut(tab, foldersOut(s, selectedTabs(s, windowId, tab))) ? "Move out of Pinned" : `Move to ${pinnedSectionTitle(s, tab)}`;
}

const selectedTabs = (s: BrowserState, windowId: string, tab: Tab) =>
  selectedTabIds(s, windowId).map((id) => s.tabs[id]!).filter((t) => t.profileId === tab.profileId);

const goesOut = (tab: Tab, folders: TabGroup[]) => !!tab.pin || folders.some((g) => g.tabIds.includes(tab.id));

const folderChain = (s: BrowserState, tabId: string) => {
  const chain: TabGroup[] = [];
  for (let g = groupOf(s, tabId); g; g = g.parentId ? s.groups[g.parentId] : undefined) chain.push(g);
  return chain;
};

function wholeFolders(s: BrowserState, tabs: Tab[]): TabGroup[] {
  const chosen = new Set(tabs.map((t) => t.id));
  const folders = new Map<string, TabGroup>();
  for (const t of tabs) {
    let whole: TabGroup | undefined;
    for (const g of folderChain(s, t.id)) {
      if (!g.tabIds.every((id) => chosen.has(id))) break;
      whole = g;
    }
    if (whole) folders.set(whole.id, whole);
  }
  return [...folders.values()];
}

function foldersOut(s: BrowserState, selected: Tab[]): TabGroup[] {
  const out = new Map<string, TabGroup>();
  for (const g of wholeFolders(s, selected)) if (g.pinned) out.set(g.id, g);
  for (const t of selected) {
    const pinnedByKey = folderChain(s, t.id).reverse().find((g) => g.pinned && folderSpots.has(pinKeyOf(g)));
    if (pinnedByKey) out.set(pinnedByKey.id, pinnedByKey);
  }
  return [...out.values()].filter((g) => !ancestorIds(s.groups, g.id).some((a) => out.has(a)));
}

const listTabIds = (s: BrowserState, windowId: string, profileId: string, except: Set<string>) =>
  (s.windows[windowId]?.tabIds ?? []).filter((id) => {
    const t = s.tabs[id];
    return t && !t.pin && t.profileId === profileId && !except.has(id) && !groupOf(s, id)?.pinned;
  });

const inWindowOrder = (s: BrowserState, g: TabGroup) => (s.windows[g.windowId]?.tabIds ?? []).filter((id) => g.tabIds.includes(id));

export function togglePinnedRows(windowId: string) {
  const s = store();
  const tab = activeTab(s, windowId);
  if (!tab) return;
  const selected = selectedTabs(s, windowId, tab);
  const out = foldersOut(s, selected);
  if (goesOut(tab, out)) return moveOutOfPinned(selected.filter((t) => t.pin), out);
  const folders = wholeFolders(s, selected).filter((g) => !g.pinned);
  const inFolder = new Set(folders.flatMap((g) => g.tabIds));
  moveToPinned(s, windowId, selected.filter((t) => !t.pin && !inFolder.has(t.id)), folders);
}

function moveToPinned(s: BrowserState, windowId: string, tabs: Tab[], folders: TabGroup[]) {
  const profileId = (tabs[0] ?? folders[0])?.profileId;
  if (!profileId) return;
  const list = listTabIds(s, windowId, profileId, new Set()).map((id) => pinKeyOf(s.tabs[id]!));
  const spotAt = (key: string, end: string, groupId: string | null): ListSpot => ({ windowId, key, end, list, index: list.indexOf(key), order: spotOrder++, groupId });
  for (const t of tabs) {
    const group = groupOf(s, t.id);
    const key = pinKeyOf(t);
    listSpots.set(key, spotAt(key, key, group && !group.pinned ? group.id : null));
  }
  for (const g of folders) {
    const ids = inWindowOrder(s, g);
    folderSpots.set(pinKeyOf(g), spotAt(pinKeyOf(s.tabs[ids[0]!]!), pinKeyOf(s.tabs[ids.at(-1)!]!), g.parentId ?? null));
  }
  if (tabs.length) s.pinTabs(tabs.map((t) => t.id), true, true);
  for (const g of folders) {
    store().moveGroup(g.id, { pinned: true });
    noteFolderMovedByPinKey("pinned");
  }
}

type Restore = ListSpot & ({ kind: "tab"; tabId: string } | { kind: "folder"; folderId: string });

const precedes = (a: Restore, b: Restore) =>
  [a.list, b.list].some((list) => {
    const i = list.indexOf(a.key);
    const j = list.indexOf(b.key);
    return i >= 0 && j >= 0 && i < j;
  });

function inListOrder(spots: Restore[]): Restore[] {
  const left = [...spots].sort((x, y) => x.index - y.index || x.order - y.order);
  const out: Restore[] = [];
  while (left.length) {
    const i = Math.max(0, left.findIndex((x) => !left.some((y) => y !== x && precedes(y, x))));
    out.push(left.splice(i, 1)[0]!);
  }
  return out;
}

const restoreIds = (s: BrowserState, r: Restore) => (r.kind === "tab" ? [r.tabId] : (s.groups[r.folderId]?.tabIds ?? []));

function moveOutOfPinned(tabs: Tab[], folders: TabGroup[]) {
  if (!tabs.length && !folders.length) return;
  const before = store();
  const spots = tabs.flatMap((t): Restore[] => {
    const spot = listSpots.get(pinKeyOf(t));
    if (!spot) return [];
    listSpots.delete(pinKeyOf(t));
    const tabId = before.windows[spot.windowId]?.tabIds.find((id) => before.tabs[id] && pinKeyOf(before.tabs[id]!) === spot.key);
    return tabId ? [{ ...spot, kind: "tab", tabId }] : [];
  });
  const unplaced: string[] = [];
  for (const g of folders) {
    const key = pinKeyOf(g);
    const spot = folderSpots.get(key);
    folderSpots.delete(key);
    const home = spot && Object.values(before.groups).find((x) => x.pinned && x.windowId === spot.windowId && pinKeyOf(x) === key);
    if (spot && home) spots.push({ ...spot, kind: "folder", folderId: home.id });
    else unplaced.push(g.id);
  }
  if (tabs.length) store().pinTabs(tabs.map((t) => t.id), false);
  for (const id of unplaced) {
    store().moveGroup(id, { pinned: false, parentId: null });
    noteFolderMovedByPinKey("unpinned");
  }
  const ordered = inListOrder(spots);
  const placed: Restore[] = [];
  for (const spot of ordered) {
    const s = store();
    const folder = spot.kind === "folder" ? s.groups[spot.folderId] : undefined;
    const t = spot.kind === "tab" ? s.tabs[spot.tabId] : undefined;
    const profileId = folder?.profileId ?? t?.profileId;
    if (spot.kind === "tab" ? !t || t.pin || t.windowId !== spot.windowId : !folder?.pinned || folder.windowId !== spot.windowId) continue;
    const pending = ordered.filter((o) => o !== spot && !placed.includes(o)).flatMap((o) => restoreIds(s, o));
    const now = listTabIds(s, spot.windowId, profileId!, new Set([...restoreIds(s, spot), ...pending]));
    const keys = now.map((id) => pinKeyOf(s.tabs[id]!));
    const prevKey = spot.list.slice(0, spot.index).reverse().find((k) => keys.includes(k));
    const nextKey = spot.list.slice(spot.index + 1).find((k) => keys.includes(k));
    const after = Math.max(prevKey ? keys.indexOf(prevKey) : -1, ...placed.filter((p) => precedes(p, spot)).map((p) => keys.indexOf(p.end)));
    const prev = after >= 0 ? now[after] : undefined;
    let beforeId = prev ? (now[after + 1] ?? null) : nextKey ? now[keys.indexOf(nextKey)]! : (now[spot.index] ?? null);
    const group = spot.groupId ? s.groups[spot.groupId] : undefined;
    const groupId = group && !group.pinned && group.windowId === spot.windowId && group.profileId === profileId ? group.id : undefined;
    if (groupId && !(beforeId && group!.tabIds.includes(beforeId))) {
      beforeId = prev && group!.tabIds.includes(prev) ? null : (group!.tabIds.find((id) => now.includes(id)) ?? null);
    }
    if (spot.kind === "tab") s.placeTabs([spot.tabId], { pinned: false, groupId, beforeId });
    else {
      s.moveGroup(spot.folderId, { pinned: false, parentId: groupId ?? null, beforeId });
      noteFolderMovedByPinKey("unpinned");
    }
    placed.push(spot);
  }
}

export function forgetListSpots() {
  listSpots.clear();
  folderSpots.clear();
}
