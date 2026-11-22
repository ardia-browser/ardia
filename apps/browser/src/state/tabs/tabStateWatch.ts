import { changedIds } from "../browser/changes";
import { keyedWatch, recordWatch, useKeyed, type KeyedWatch } from "../browser/keyedWatch";
import { useLifecycle } from "./sleepingTabs";
import { useBrowser, type BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { tabEngine } from "../engines/engines";
import { shares } from "../pins/pinShare";
import { navigationOf } from "./pageSession";
import { watchLive } from "./tabLive";

const wakeIds = (ids: Iterable<string> | undefined, wake: (id: string) => void) => {
  if (ids) for (const id of ids) wake(id);
};

const openerEngine = (t: Tab | undefined) => (t?.engine && (t.url || navigationOf(t)) ? t.engine : undefined);

const sharingShapeChanged = (tab: Tab, was: Tab | undefined) =>
  !was ||
  tab.pin?.as !== was.pin?.as ||
  tab.pinKey !== was.pinKey ||
  tab.profileId !== was.profileId ||
  tab.windowId !== was.windowId ||
  tab.page.kind !== was.page.kind ||
  !tab.url !== !was.url ||
  !tab.liveItem !== !was.liveItem;

function reachesOtherTabs(s: BrowserState, prev: BrowserState, id: string): boolean {
  const tab = s.tabs[id];
  const was = prev.tabs[id];
  if (!tab || openerEngine(tab) !== openerEngine(was)) return true;
  if ((shares(s, tab) || shares(prev, was)) && sharingShapeChanged(tab, was)) return true;
  return tabEngine(s, id) !== tabEngine(prev, id);
}

const pinnedGroupChanged = (s: BrowserState, prev: BrowserState) =>
  s.groups !== prev.groups && changedIds(s.groups, prev.groups).some((id) => s.groups[id]?.pinned || prev.groups[id]?.pinned);

export function tabStateChanges(s: BrowserState, prev: BrowserState, wake: (id: string) => void): true | undefined {
  const wide = s.settings !== prev.settings || s.profiles !== prev.profiles || s.privateSiteMutes !== prev.privateSiteMutes;
  if (wide || s.splits !== prev.splits || s.peeks !== prev.peeks || pinnedGroupChanged(s, prev)) return true;
  if (s.windows !== prev.windows)
    for (const id of changedIds(s.windows, prev.windows)) {
      const w = s.windows[id];
      const was = prev.windows[id];
      if (w?.kind !== was?.kind) return true;
      if (w?.activeTabIds === was?.activeTabIds) continue;
      wakeIds(w && Object.values(w.activeTabIds), wake);
      wakeIds(was && Object.values(was.activeTabIds), wake);
    }
  if (s.tabs !== prev.tabs)
    for (const id of changedIds(s.tabs, prev.tabs)) {
      if (reachesOtherTabs(s, prev, id)) return true;
      wake(id);
    }
  if (s.selection !== prev.selection)
    for (const id of changedIds(s.selection, prev.selection)) {
      wakeIds(s.selection[id], wake);
      wakeIds(prev.selection[id], wake);
    }
}

const watchStoreTabState = keyedWatch<BrowserState>(() => useBrowser, tabStateChanges);
const watchSleeping = recordWatch(() => useLifecycle, (l) => l.discarded);

export const watchTabState: KeyedWatch = (tabId, listener) => {
  const offStore = watchStoreTabState(tabId, listener);
  const offLive = watchLive(tabId, listener);
  const offSleeping = watchSleeping(tabId, listener);
  return () => {
    offStore();
    offLive();
    offSleeping();
  };
};

export const useTabState = <T,>(tabId: string | null | undefined, read: (s: BrowserState) => T): T =>
  useKeyed(watchTabState, tabId, () => read(useBrowser.getState()));
