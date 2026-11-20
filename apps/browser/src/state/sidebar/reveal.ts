import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { revealTargets, type RevealTargets } from "./revealTargets";
import { useLive } from "../live/store";
import { changedIds } from "../browser/changes";

const asked = new Map<string, Set<(tabId: string) => void>>();

export const revealTab = (windowId: string, tabId: string) => asked.get(windowId)?.forEach((reveal) => reveal(tabId));

export function watchRevealTargets(windowId: string, found: (targets: RevealTargets, viaPill: boolean) => void) {
  const ask = (tabId: string) => found({ switched: tabId, opened: null }, true);
  const askers = asked.get(windowId) ?? new Set();
  asked.set(windowId, askers.add(ask));
  const unsubscribe = watchStoreTargets(windowId, found);
  return () => {
    unsubscribe();
    askers.delete(ask);
    if (!askers.size) asked.delete(windowId);
  };
}

const watchStoreTargets = (windowId: string, found: (targets: RevealTargets, viaPill: boolean) => void) =>
  useBrowser.subscribe((s, prev) => {
    if (s.windows === prev.windows && s.tabs === prev.tabs) return;
    const targets = revealTargets(s, prev, windowId);
    if (targets.switched || targets.opened) found(targets, false);
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
