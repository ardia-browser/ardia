import type { BookmarkNode as ImportedNode, ImportedFavicon, ImportedTab } from "../../platform/importModule";
import { isWebPageUrl, withoutFragment } from "../../lib/url";
import { ROW_PIN } from "../browser/model";
import { pinnedGroupMembers } from "../browser/structure";
import { useBrowser, type BrowserState } from "../browser/store";
import { adoptFavicons } from "../favicons/favicons";
import { paneChunks } from "../splits/splits";
import { openPages, pageKey, pinnedPages, tilePages } from "../tabs/pageKeys";
import { IDLE } from "../tabs/pageSession";
import { withNewTab } from "../tabs/tabs";

export const linksOf = (nodes: ImportedNode[]): string[] => nodes.flatMap((n) => (n.type === "url" ? (n.url ? [n.url] : []) : linksOf(n.children ?? [])));

export function importFavicons(profileId: string, favicons: ImportedFavicon[] | undefined, urls: string[]) {
  if (!favicons?.length || !urls.length) return;
  const wanted = new Set(urls.map(withoutFragment));
  adoptFavicons(profileId, favicons.filter((f) => wanted.has(withoutFragment(f.page))));
}

export function windowFor(profileId: string): string {
  const s = useBrowser.getState();
  const regular = s.ui.focusOrder.find((id) => s.windows[id] && s.windows[id]!.kind !== "private") ?? s.windowOrder.find((id) => s.windows[id]!.kind !== "private");
  return regular ?? s.createWindow({ spaceId: profileId });
}

export type IncomingTab = Pick<ImportedTab, "url" | "title" | "pinned" | "customTitle" | "splitId"> & { row?: boolean };

function freshTabs<T extends IncomingTab>(tabs: T[], pinned: Set<string>, open: Set<string>): T[] {
  const out: T[] = [];
  const keep = (t: T) => {
    const seen = t.pinned ? pinned : open;
    const key = pageKey(t.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (let i = 0; i < tabs.length; ) {
    const splitId = tabs[i]!.splitId;
    let end = i + 1;
    while (splitId && end < tabs.length && tabs[end]!.splitId === splitId) end++;
    const unit = tabs.slice(i, end).filter((t) => isWebPageUrl(t.url));
    i = end;
    if (unit.length < 2) {
      unit.forEach((t) => keep({ ...t, splitId: undefined }));
      continue;
    }
    const seen = unit[0]!.pinned ? pinned : open;
    if (unit.every((t) => seen.has(pageKey(t.url)))) continue;
    unit.forEach((t) => seen.add(pageKey(t.url)));
    out.push(...unit);
  }
  return out;
}

function pinnedAreaEnd(s: BrowserState, windowId: string): number {
  const area = pinnedGroupMembers(s.groups);
  return s.windows[windowId]!.tabIds.reduce((end, id, i) => (s.tabs[id]?.pin || area.has(id) ? i + 1 : end), 0);
}

export type ImportedTabs = { tabs: number; splits: number; ids: string[] };

export function importTabs(profileId: string, tabs: IncomingTab[], group: string | null, pinnedAgainst: "anyPin" | "tiles" = "anyPin", windowId?: string): number {
  return importTabsWithSplits(profileId, tabs, group, pinnedAgainst, windowId).tabs;
}

export function importTabsWithSplits(
  profileId: string,
  tabs: IncomingTab[],
  group: string | null,
  pinnedAgainst: "anyPin" | "tiles" = "anyPin",
  into?: string,
): ImportedTabs {
  const s = useBrowser.getState();
  const pinned = pinnedAgainst === "tiles" ? tilePages(s, profileId) : pinnedPages(s, profileId);
  const open = openPages(s, profileId);
  const usable = freshTabs(tabs, pinned, open);
  if (!usable.length) return { tabs: 0, splits: 0, ids: [] };
  const windowId = into ?? windowFor(profileId);
  let next = useBrowser.getState();
  const unpinned: string[] = [];
  const ids: string[] = [];
  const panes = new Map<string, string[]>();
  for (const t of usable) {
    const after = t.pinned ? undefined : unpinned.at(-1);
    const [made, id] = withNewTab(next, windowId, {
      url: t.url,
      spaceId: profileId,
      background: true,
      pinned: t.pinned,
      snapshot: { title: t.title, customTitle: t.customTitle ?? null, ...(t.pinned && t.row ? { pin: ROW_PIN } : {}) },
      index: after ? next.windows[windowId]!.tabIds.indexOf(after) + 1 : t.pinned && t.row ? pinnedAreaEnd(next, windowId) : undefined,
    });
    if (!id) continue;
    next = { ...made, tabs: { ...made.tabs, [id]: { ...made.tabs[id]!, page: IDLE } } };
    ids.push(id);
    if (!t.pinned) unpinned.push(id);
    if (t.splitId) panes.set(t.splitId, [...(panes.get(t.splitId) ?? []), id]);
  }
  useBrowser.setState(next);
  if (group && unpinned.length) useBrowser.getState().createGroup(unpinned, { name: group });
  let splits = 0;
  for (const ids of panes.values()) for (const chunk of paneChunks(ids)) if (useBrowser.getState().createSplit(chunk)) splits++;
  return { tabs: usable.length, splits, ids };
}
