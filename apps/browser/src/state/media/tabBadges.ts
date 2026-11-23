import { changedIds } from "../browser/changes";
import { keyedWatch, useKeyed, type KeyedWatch } from "../browser/keyedWatch";
import { useBrowser } from "../browser/store";
import { watchPeekOpenedFrom } from "../peek/hooks";
import { peekOpenedFrom } from "../peek/peek";
import { usePages } from "../tabs/pageState";
import { useMedia } from "./media";

const watchCapturing = keyedWatch(
  () => usePages,
  (s, prev, wake) => {
    if (s.pages === prev.pages) return;
    for (const id of changedIds(s.pages, prev.pages)) if (!s.pages[id]?.mediaAccess !== !prev.pages[id]?.mediaAccess) wake(id);
  },
);

const watchShared = keyedWatch(
  () => useMedia,
  (s, prev, wake) => {
    if (s.sharedTabs !== prev.sharedTabs) for (const id of changedIds(s.sharedTabs, prev.sharedTabs)) wake(id);
  },
);

const watchTabBadges: KeyedWatch = (tabId, listener) => {
  const stops = [watchCapturing(tabId, listener), watchShared(tabId, listener), watchPeekOpenedFrom(tabId, listener)];
  return () => stops.forEach((stop) => stop());
};

export const tabHasBadges = (tabId: string): boolean =>
  !!usePages.getState().pages[tabId]?.mediaAccess || !!useMedia.getState().sharedTabs[tabId] || !!peekOpenedFrom(useBrowser.getState(), tabId);

export const useTabHasBadges = (tabId: string): boolean => useKeyed(watchTabBadges, tabId, () => tabHasBadges(tabId));
