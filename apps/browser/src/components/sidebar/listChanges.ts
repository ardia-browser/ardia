import type { BrowserState } from "../../state/browser/store";
import { entryTabIds, groupEntries } from "../../state/sidebar/entries";

export const closedIn = (before: BrowserState, after: BrowserState) => (entry: string) => {
  const ids = entryTabIds(before, entry);
  return ids.length > 0 && ids.every((id) => !after.tabs[id]);
};

export const openedIn = (before: BrowserState, after: BrowserState) => (entry: string) => {
  const ids = entryTabIds(after, entry);
  return ids.length > 0 && ids.every((id) => !before.tabs[id]);
};

export type GroupChange = "same" | "grown" | "extended" | "other";

export function groupGrowsAtEnd(before: BrowserState, after: BrowserState, groupId: string): boolean {
  const last = groupEntries(after, groupId).at(-1);
  return !!last && !groupEntries(before, groupId).includes(last);
}

export function groupChange(before: BrowserState, after: BrowserState, groupId: string): GroupChange {
  const was = before.groups[groupId];
  const now = after.groups[groupId];
  if (!was || !now) return "other";
  const had = new Set(was.tabIds);
  const has = new Set(now.tabIds);
  const gone = was.tabIds.filter((id) => !has.has(id));
  const came = now.tabIds.filter((id) => !had.has(id));
  if (!gone.length && !came.length) return "same";
  const expanded = !was.collapsed && !now.collapsed;
  if (expanded && !came.length && gone.every((id) => !after.tabs[id])) return "extended";
  if (!expanded || gone.length || !came.every((id) => !before.tabs[id])) return "other";
  return groupGrowsAtEnd(before, after, groupId) ? "grown" : "extended";
}
