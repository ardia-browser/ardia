import type { BrowserState } from "../browser/store";
import type { Tab, TabGroup } from "../browser/types";
import { findLast, makeTab, pinKeyOf } from "../browser/model";
import { ASLEEP, hasPage } from "../tabs/pageSession";
import { isRegularWindow } from "../windows/small";
import { removeFromSplits, splitOf, splitTabIdsOf } from "../splits/splits";
import { groupKeptOpen } from "./closeGuard";
import { ancestorIds, innermostGroupOf, orderSections, placeGroups, syncGroupOrder } from "./groups";

export const EMPTY_FOLDER_URL = "about:blank";
const EMPTY_FOLDER_TITLE = "Empty Folder";

export const emptyFolderRow = (windowId: string, profileId: string): Tab => ({
  ...makeTab(windowId, profileId, EMPTY_FOLDER_URL, { title: EMPTY_FOLDER_TITLE, customTitle: EMPTY_FOLDER_TITLE }),
  page: ASLEEP,
});

const isBlank = (t: Tab | undefined) => !!t && [t.url, t.pinnedUrl].every((url) => !url || url === EMPTY_FOLDER_URL);

export const isEmptyFolderRow = (t: Tab | undefined) => isBlank(t) && !hasPage(t!);

export function withoutEmptyFolderRows(s: BrowserState, ids: string[]): string[] {
  const holdsFolder = (id: string) =>
    isBlank(s.tabs[id]) && Object.values(s.groups).some((g) => g.tabIds.length === 1 && g.tabIds[0] === id && groupKeptOpen(g.id));
  return ids.some(holdsFolder) ? ids.filter((id) => !holdsFolder(id)) : ids;
}

export const outsideKeptFolders = (s: BrowserState, ids: string[]) =>
  ids.filter((id) => !Object.values(s.groups).some((g) => g.tabIds.includes(id) && groupKeptOpen(g.id)));

export function keptFolderOf(s: Pick<BrowserState, "groups">, id: string): string | undefined {
  const inner = innermostGroupOf(s.groups, id);
  return inner?.pinned && [inner.id, ...ancestorIds(s.groups, inner.id)].some((group) => groupKeptOpen(group, s)) ? inner.id : undefined;
}

export function apartAtKeptFolderEdge(s: BrowserState, anchorId: string, members: string[], joining: string[], paired: string[]): [BrowserState, string[]] {
  const home = keptFolderOf(s, anchorId);
  const staying = new Set(paired.filter((id) => id !== anchorId && !joining.includes(id) && keptFolderOf(s, id) !== home));
  return staying.size ? [{ ...s, splits: removeFromSplits(s.splits, staying) }, members.filter((id) => !staying.has(id))] : [s, members];
}

export function withEmptiedFoldersKept(before: BrowserState, after: BrowserState, left: ReadonlySet<string>): BrowserState {
  const emptied = Object.values(before.groups).filter((g) => !after.groups[g.id] && after.windows[g.windowId] && g.tabIds.some((id) => left.has(id)) && groupKeptOpen(g.id));
  if (!emptied.length) return after;
  const placeOf = (g: TabGroup) => before.windows[g.windowId]!.tabIds.indexOf(g.tabIds[0]!);
  let next = after;
  for (const g of emptied.sort((a, z) => placeOf(z) - placeOf(a))) {
    const w = next.windows[g.windowId]!;
    const row = emptyFolderRow(g.windowId, g.profileId);
    const above = findLast(before.windows[g.windowId]!.tabIds.slice(0, placeOf(g)), (id) => !left.has(id) && w.tabIds.includes(id));
    const tabIds = [...w.tabIds];
    let at = above ? tabIds.indexOf(above) + 1 : 0;
    const panes = splitTabIdsOf(splitOf(next, above)) ?? [];
    while (at < tabIds.length && panes.includes(tabIds[at]!)) at++;
    tabIds.splice(at, 0, row.id);
    const tabs = { ...next.tabs, [row.id]: row };
    const groups = { ...next.groups, [g.id]: { ...g, tabIds: [row.id] } };
    const window = { ...w, tabIds: orderSections(placeGroups(tabIds, groups, w.id), tabs, groups) };
    next = { ...next, tabs, groups: syncGroupOrder(groups, window), windows: { ...next.windows, [w.id]: window } };
  }
  return next;
}

export function withKeptFoldersMovedAlong(before: BrowserState, after: BrowserState, targetId: string): BrowserState {
  const target = after.windows[targetId];
  if (!isRegularWindow(target)) return after;
  const shown = (g: TabGroup) =>
    Object.values(after.groups).some((x) => x.pinned && !x.parentId && x.profileId === g.profileId && pinKeyOf(x) === pinKeyOf(g));
  const following = Object.values(before.groups).filter(
    (g) => !after.windows[g.windowId] && groupKeptOpen(g.id) && g.tabIds.every((id) => after.tabs[id]?.windowId === targetId) && !shown(g),
  );
  if (!following.length) return after;
  const roots = new Set(following.map((g) => g.id));
  const groups = { ...after.groups };
  for (const g of Object.values(before.groups)) {
    if (roots.has(g.id) || ancestorIds(before.groups, g.id).some((id) => roots.has(id))) groups[g.id] = { ...g, windowId: targetId };
  }
  const window = { ...target!, tabIds: orderSections(placeGroups(target!.tabIds, groups, targetId), after.tabs, groups) };
  return { ...after, groups: syncGroupOrder(groups, window), windows: { ...after.windows, [targetId]: window } };
}
