import type { BrowserState } from "../browser/store";
import type { BrowserWindow, ClosedGroup, ClosedTab, ClosedWindow } from "../browser/types";
import { isIncognitoSpace } from "../browser/model";

export type RecentlyClosed = { tabs: ClosedTab[]; windows: ClosedWindow[]; groups: ClosedGroup[] };

export const RECENTLY_CLOSED_SHOWN = 10;

export function recentlyClosedIn(s: BrowserState, w: BrowserWindow | undefined): RecentlyClosed {
  const everyProfile = !w || w.kind === "private";
  const listed = (profileId: string | undefined) => everyProfile || (profileId && s.spaces[profileId] ? profileId : s.settings.defaultSpaceId) === w.spaceId;
  return {
    tabs: s.closedTabs.filter((c) => !isIncognitoSpace(c.tab.spaceId) && listed(c.tab.spaceId)),
    windows: s.closedWindows.filter((c) => listed(c.window.spaceId)),
    groups: s.closedGroups.filter((c) => everyProfile || c.tabs[0]?.spaceId === w.spaceId),
  };
}

export const closedWindowTitle = (c: ClosedWindow) => (c.tabs.length ? (c.tabs.length === 1 ? "Window (1 Tab)" : `Window (${c.tabs.length} Tabs)`) : "Window (Pinned Tabs)");

export function newestClosed(list: RecentlyClosed): (ClosedTab | ClosedWindow)[] {
  return [...list.tabs, ...list.windows].sort((a, b) => b.closedAt - a.closedAt).slice(0, RECENTLY_CLOSED_SHOWN);
}

export function clearableRecentlyClosed(s: BrowserState, windowId: string | null | undefined): RecentlyClosed | undefined {
  const w = windowId ? s.windows[windowId] : undefined;
  if (!w || w.kind === "private") return undefined;
  const list = recentlyClosedIn(s, w);
  return list.tabs.length || list.windows.length || list.groups.length ? list : undefined;
}
