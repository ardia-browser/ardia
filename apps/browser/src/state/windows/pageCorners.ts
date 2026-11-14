import { windowControls } from "../../platform/windowControls";
import { useBrowser, type BrowserState } from "../browser/store";
import { pageFrameInsetOf, pageFrameOf } from "../../lib/windowLayout";
import { WINDOW_CHROME } from "../../lib/windowChrome";
import { autoHidesTabsIn } from "../browser/model";
import { bookmarksShown } from "../bookmarks/visibility";
import { isSmallWindow } from "./small";
import { addressBarInSidebar, windowCornerRadius } from "./layout";

const sent = new Map<string, number>();

function drawnPageFrame(s: BrowserState, windowId: string): number {
  return pageFrameInsetOf(s.settings.pageFrame, {
    borderlessMode: s.settings.borderlessMode,
    zeroInFullScreen: s.settings.pageFrameZeroInFullScreen,
    fullScreen: !!s.windows[windowId]?.fullScreen,
    zeroWhenTabsHidden: s.settings.pageFrameZeroWhenTabsHidden,
    tabsHidden: autoHidesTabsIn(s, windowId),
  });
}

function bookmarksBarAbovePages(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  return !!w && !isSmallWindow(w) && w.kind !== "private" && bookmarksShown(s.settings) && s.settings.bookmarksBar === "always";
}

function pageReachesCardTop(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  if (!w || bookmarksBarAbovePages(s, windowId)) return false;
  return isSmallWindow(w) || addressBarInSidebar(s, windowId);
}

export function pageCornerRadiusIn(s: BrowserState, windowId: string, fixedRadius: number | null = WINDOW_CHROME.pageCornerRadius, windowRadius: () => number = windowCornerRadius): number {
  if (!pageReachesCardTop(s, windowId)) return 0;
  const inset = drawnPageFrame(s, windowId);
  return pageFrameOf(inset, windowRadius(), 0, fixedRadius).radius;
}

export function syncPageCorners(s: BrowserState, send: (windowId: string, radius: number) => void = windowControls.setPageCornerRadius, fixedRadius: number | null = WINDOW_CHROME.pageCornerRadius) {
  for (const id of Object.keys(s.windows)) {
    const radius = pageCornerRadiusIn(s, id, fixedRadius);
    if (sent.get(id) === radius) continue;
    sent.set(id, radius);
    send(id, radius);
  }
  for (const id of [...sent.keys()]) if (!s.windows[id]) sent.delete(id);
}

export function startPageCornerSync() {
  if (WINDOW_CHROME.pageCornerRadius === null) return;
  const sync = () => syncPageCorners(useBrowser.getState());
  sync();
  useBrowser.subscribe(sync);
}
