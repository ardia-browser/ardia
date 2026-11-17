import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { isAsleep } from "../tabs/pageSession";
import { useLive } from "../live/store";
import { changedIds } from "../browser/changes";

const closedAway = (s: BrowserState, prev: BrowserState, tabId: string | undefined) =>
  !!tabId && (!s.tabs[tabId] || (isAsleep(s.tabs[tabId]) && !isAsleep(prev.tabs[tabId])));

const asked = new Map<string, Set<(tabId: string) => void>>();

export const revealTab = (windowId: string, tabId: string) => asked.get(windowId)?.forEach((reveal) => reveal(tabId));

export function watchRevealTargets(windowId: string, found: (switched: string | null, opened: string | null) => void) {
  const ask = (tabId: string) => found(tabId, null);
  const askers = asked.get(windowId) ?? new Set();
  asked.set(windowId, askers.add(ask));
  const unsubscribe = watchStoreTargets(windowId, found);
  return () => {
    unsubscribe();
    askers.delete(ask);
    if (!askers.size) asked.delete(windowId);
  };
}

const watchStoreTargets = (windowId: string, found: (switched: string | null, opened: string | null) => void) =>
  useBrowser.subscribe((s, prev) => {
    if (s.windows === prev.windows && s.tabs === prev.tabs) return;
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
    found(switched, opened);
  });

export const selectedTabIn = (windowId: string) => activeTabId(useBrowser.getState(), windowId);

const pinsMoved = (s: BrowserState, prev: BrowserState) => changedIds(s.tabs, prev.tabs).some((id) => s.tabs[id]?.pin !== prev.tabs[id]?.pin);

export function watchRowsMoved(moved: () => void) {
  const stopBrowser = useBrowser.subscribe((s, prev) => {
    if (s.windows !== prev.windows || s.groups !== prev.groups || pinsMoved(s, prev)) moved();
  });
  const stopLive = useLive.subscribe((l, prev) => {
    if (l.folderOrder !== prev.folderOrder || l.folders !== prev.folders) moved();
  });
  return () => {
    stopBrowser();
    stopLive();
  };
}
