import type { BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { isAsleep } from "../tabs/pageSession";

export type RevealTargets = { switched: string | null; opened: string | null };

const closedAway = (s: BrowserState, prev: BrowserState, tabId: string | undefined) =>
  !!tabId && (!s.tabs[tabId] || (isAsleep(s.tabs[tabId]) && !isAsleep(prev.tabs[tabId])));

export function revealTargets(s: BrowserState, prev: BrowserState, windowId: string): RevealTargets {
  let switched: string | null = null;
  let opened: string | null = null;
  const active = activeTabId(s, windowId);
  const previous = activeTabId(prev, windowId);
  if (active && active !== previous && !closedAway(s, prev, previous)) switched = active;
  const w = s.windows[windowId];
  const before = prev.windows[windowId];
  if (w && before && w.tabIds !== before.tabIds) {
    const had = new Set(before.tabIds);
    for (const id of w.tabIds) if (!had.has(id) && s.tabs[id]?.openerId && id !== active) opened = id;
  }
  return { switched, opened };
}
