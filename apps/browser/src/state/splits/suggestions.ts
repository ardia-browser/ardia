import { tabTitle } from "../browser/model";
import type { BrowserState } from "../browser/store";
import { byRecentUse, matchingRows } from "../sidebar/groupPanelRows";
import { splitTabIds, splitTabIdsOf } from "./splits";

export const SPLIT_SUGGESTION_LIMIT = 5;

export function splitSuggestions(s: Pick<BrowserState, "tabs" | "windows" | "splits">, tabId: string, text: string): string[] {
  const tab = s.tabs[tabId];
  const w = tab && s.windows[tab.windowId];
  if (!w) return [];
  const inSplit = new Set(splitTabIdsOf(Object.values(s.splits).find((v) => splitTabIds(v).includes(tabId))) ?? [tabId]);
  const rows = w.tabIds
    .map((id) => s.tabs[id]!)
    .filter((t) => t && t.url && t.profileId === tab.profileId && !inSplit.has(t.id))
    .map((t) => ({ id: t.id, title: tabTitle(t), url: t.url, usedAt: t.lastActiveAt }));
  return matchingRows(text, byRecentUse(rows))
    .slice(0, SPLIT_SUGGESTION_LIMIT)
    .map((r) => r.id);
}
