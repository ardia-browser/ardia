import { useBrowser, type BrowserState } from "../browser/store";
import { useSettings, useTab } from "../browser/hooks";
import { useKeyed } from "../browser/keyedWatch";
import { watchTabState } from "../tabs/tabStateWatch";
import { shownLiveOf } from "../tabs/tabLive";
import { activeTabId, pinSection } from "../browser/model";
import type { Tab } from "../browser/types";
import { isPageUnloaded } from "../pins/pinShare";
import { muteState, type MuteState } from "../tabs/mute";
import { useIsSleeping } from "../tabs/sleepingTabs";

export const ACTIVE = 1;
export const SELECTED = 2;
export const PLAYING = 4;
export const LOADING = 8;
export const FADED = 16;
const TAB_MUTED = 128;
const SITE_MUTED = 256;
export const ICON_MARKS = FADED;

export const isClosedTopApp = (s: BrowserState, tabId: string): boolean =>
  !s.settings.closedTopAppTiles && pinSection(s.tabs[tabId]) === "tile" && isPageUnloaded(s, tabId);

export const iconMarks = (s: BrowserState, tabId: string): number => ((s.settings.fadeUnloadedTabs && isPageUnloaded(s, tabId)) || isClosedTopApp(s, tabId) ? FADED : 0);

export const mutedBy = (flags: number): MuteState => (flags & SITE_MUTED ? "site" : flags & TAB_MUTED ? "tab" : null);

export const useIconMarks = (tabId: string | undefined, given: number | undefined): number =>
  useKeyed(watchTabState, given === undefined ? tabId : null, () => given ?? (tabId ? iconMarks(useBrowser.getState(), tabId) : 0));

export const titleStruck = (strikeSleeping: boolean, sleeping: boolean, marks: number): boolean => strikeSleeping && (sleeping || !!(marks & FADED));

export function useStruckTitle(tabId: string, marks?: number): boolean {
  const on = useSettings((s) => s.strikeSleepingTabs);
  const sleeping = useIsSleeping(on ? tabId : "");
  const iconMarks = useIconMarks(on ? tabId : undefined, on ? marks : 0);
  return titleStruck(on, sleeping, iconMarks);
}

export function rowFlags(s: BrowserState, windowId: string, tabId: string): number {
  const tab = s.tabs[tabId];
  const live = shownLiveOf(s, tabId);
  let flags = iconMarks(s, tabId);
  if (tab && activeTabId(s, tab.windowId, tab.profileId) === tabId) flags |= ACTIVE;
  if (s.selection[windowId]?.includes(tabId)) flags |= SELECTED;
  if (live.playingAudio) flags |= PLAYING;
  if (live.isLoading) flags |= LOADING;
  const mute = tab ? muteState(s, tab) : null;
  if (mute) flags |= mute === "site" ? SITE_MUTED : TAB_MUTED;
  return flags;
}

export function useRowState(tabId: string, windowId: string): { tab: Tab | undefined; flags: number } {
  const tab = useTab(tabId);
  const flags = useKeyed(watchTabState, tabId, () => rowFlags(useBrowser.getState(), windowId, tabId));
  return { tab, flags };
}
