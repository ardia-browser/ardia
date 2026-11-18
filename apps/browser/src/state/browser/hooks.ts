import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { isBookmarked } from "../bookmarks/bookmarks";
import { useBrowser, type BrowserState } from "./store";
import { activeTabId, bookmarkSpaceId, IDLE_LIVE, spaceFor, sidebarSideOf, tabLayoutOf, tabsShownIn, type SidebarSide } from "./model";
import type { Settings } from "../settings/settings";
import type { BrowserWindow, FindState, Space, Tab, TabGroup, TabLive } from "./types";
import { CLOSED_FIND, DEFAULT_WINDOW_UI } from "../windows/ui";
import { downloadsIn } from "../downloads/downloadsSlice";
import { focusedWindowOf } from "../windows/ui";
import { ALL, useKeyed, watchSettings, watchTabRecord, watchWindowRecord } from "./keyedWatch";
import { useTabState } from "../tabs/tabStateWatch";
import { shownLiveOf, watchLive } from "../tabs/tabLive";

export const WindowContext = createContext<string | null>(null);

export function useWindowId(): string {
  return useContext(WindowContext) ?? focusedWindowOf(useBrowser.getState()) ?? "";
}

function useWindowField<T>(select: (w: BrowserWindow) => T, fallback: T): T {
  const id = useWindowId();
  return useKeyed(watchWindowRecord, id, () => {
    const w = useBrowser.getState().windows[id];
    return w ? select(w) : fallback;
  });
}

export const PageSpaceContext = createContext<string | null>(null);

export function usePageSpaceId(): string {
  const page = useContext(PageSpaceContext);
  const own = useWindowSpaceId();
  return page ?? own;
}

export const useIsIncognito = () => useWindowField((w) => w.kind === "private", false);
export const useTabsShown = (windowId: string) => useBrowser((s) => tabsShownIn(s, windowId));
export const useSidebarOpen = () => useTabsShown(useWindowId());
export const useWindowSpaceId = () => useWindowField((w) => w.spaceId, "");

export function useWindowSpace(): Space {
  const spaceId = useWindowSpaceId();
  return useBrowser((s) => spaceFor(s, spaceId));
}

export const useSpaces = (): Space[] => useBrowser(useShallow((s) => s.spaceOrder.map((id) => s.spaces[id]!)));

export function useActiveTabId(): string | undefined {
  const id = useWindowId();
  return useBrowser((s) => activeTabId(s, id));
}

export function useActiveTab(): Tab | undefined {
  const id = useWindowId();
  return useBrowser((s) => {
    const active = activeTabId(s, id);
    return active ? s.tabs[active] : undefined;
  });
}

export const useIsActiveTab = (tabId: string) =>
  useTabState(tabId, (s) => {
    const tab = s.tabs[tabId];
    return !!tab && activeTabId(s, tab.windowId, tab.spaceId) === tabId;
  });

export function useTab(tabId: string | undefined): Tab | undefined;
export function useTab<T>(tabId: string | undefined, select: (tab: Tab | undefined) => T): T;
export function useTab<T>(tabId: string | undefined, select?: (tab: Tab | undefined) => T) {
  return useKeyed(watchTabRecord, tabId, () => {
    const tab = tabId ? useBrowser.getState().tabs[tabId] : undefined;
    return select ? select(tab) : tab;
  });
}

export const useWindow = <T>(windowId: string | null | undefined, select: (w: BrowserWindow | undefined) => T): T =>
  useKeyed(watchWindowRecord, windowId, () => select(windowId ? useBrowser.getState().windows[windowId] : undefined));

export const useSpace = <T>(spaceId: string | null | undefined, select: (p: Space | undefined) => T): T =>
  useBrowser((s) => select(spaceId ? s.spaces[spaceId] : undefined));

export const useGroup = <T>(groupId: string | null | undefined, select: (g: TabGroup | undefined) => T): T =>
  useBrowser((s) => select(groupId ? s.groups[groupId] : undefined));

const inert = () => () => {};

function watchShownLive(tabId: string, listener: () => void): () => void {
  const offLive = watchLive(tabId, listener);
  const offTab = watchTabRecord(tabId, listener);
  return () => {
    offLive();
    offTab();
  };
}

export function useTabLive(tabId: string | undefined): TabLive;
export function useTabLive<T>(tabId: string | undefined, select: (live: TabLive) => T): T;
export function useTabLive<T>(tabId: string | undefined, select?: (live: TabLive) => T) {
  const subscribe = useMemo(() => (tabId ? (listener: () => void) => watchShownLive(tabId, listener) : inert), [tabId]);
  const read = () => {
    const live = tabId ? shownLiveOf(useBrowser.getState(), tabId) : IDLE_LIVE;
    return select ? select(live) : live;
  };
  return useSyncExternalStore(subscribe, read, read);
}

export const useFind = (tabId: string | undefined): FindState => useBrowser((s) => (tabId && s.find[tabId]) || CLOSED_FIND);

export function useWindowUi() {
  const id = useWindowId();
  return useBrowser((s) => s.windowUi[id] ?? DEFAULT_WINDOW_UI);
}

export const useSettings = <T>(select: (settings: Settings) => T): T => useKeyed(watchSettings, ALL, () => select(useBrowser.getState().settings));

export const useChosenSettings = (): readonly string[] => useBrowser((s) => s.settingsMeta.chosen);

export function useIsBookmarked(url: string): boolean {
  const id = useWindowId();
  return useBrowser((s) => isBookmarked(s, bookmarkSpaceId(s, s.windows[id]), url));
}

export const useAppDark = (): boolean => useBrowser((s) => s.ui.appDark);

export const useTabLayout = (windowId?: string | null): "sidebar" | "top" => useBrowser((s) => tabLayoutOf(s, windowId));

export const useSidebarSide = (windowId?: string | null): SidebarSide => useBrowser((s) => sidebarSideOf(s, windowId));

export const useWindowFullScreen = (windowId?: string | null): boolean => useBrowser((s) => !!windowId && !!s.windows[windowId]?.fullScreen);

export const useDownloads = <T>(windowId: string, select: (downloads: BrowserState["downloads"]) => T): T => useBrowser((s) => select(downloadsIn(s, windowId)));
