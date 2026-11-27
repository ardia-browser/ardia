import type { BrowserState } from "../browser/store";
import { activeTabId, inPinnedContainer, pinSection, viewTabIds } from "../browser/model";
import { splitOf } from "../splits/splits";
import { shownLiveOf } from "../tabs/tabLive";
import { samePageKey } from "../../lib/url";

type SamePageTabs = { held: boolean; closable: string[] };

function samePageTabs(s: BrowserState, windowId: string): Map<string, SamePageTabs> {
  const pages = new Map<string, SamePageTabs>();
  for (const id of viewTabIds(s, windowId)) {
    const t = s.tabs[id]!;
    if (!t.url) continue;
    const pinned = inPinnedContainer(s, id);
    if (pinned && pinSection(t) === "tile") continue;
    const key = samePageKey(t.url);
    let page = pages.get(key);
    if (!page) pages.set(key, (page = { held: false, closable: [] }));
    if (pinned || splitOf(s, id) || shownLiveOf(s, id).playingAudio) page.held = true;
    else page.closable.push(id);
  }
  return pages;
}

function keptCopy(s: BrowserState, page: SamePageTabs, selected: string | undefined): string | undefined {
  if (selected && page.closable.includes(selected)) return selected;
  if (page.held) return undefined;
  return page.closable.reduce((best, id) => (s.tabs[id]!.lastActiveAt > s.tabs[best]!.lastActiveAt ? id : best));
}

export function duplicateTabIds(s: BrowserState, windowId: string): string[] {
  const selected = activeTabId(s, windowId);
  const closing = new Set<string>();
  for (const page of samePageTabs(s, windowId).values()) {
    if (page.closable.length + (page.held ? 1 : 0) < 2) continue;
    const kept = keptCopy(s, page, selected);
    for (const id of page.closable) if (id !== kept) closing.add(id);
  }
  return closing.size ? viewTabIds(s, windowId).filter((id) => closing.has(id)) : [];
}

export const hasDuplicateTabs = (s: BrowserState, windowId: string): boolean => duplicateTabIds(s, windowId).length > 0;
