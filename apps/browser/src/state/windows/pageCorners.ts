import { windowControls, type PageRounding } from "../../platform/windowControls";
import { useBrowser, type BrowserState } from "../browser/store";
import { pageFrameInsetOf, pageFrameOf } from "../../lib/windowLayout";
import { WINDOW_CHROME } from "../../lib/windowChrome";
import { activeTabId, autoHidesTabsIn } from "../browser/model";
import { bookmarksShown } from "../bookmarks/visibility";
import { splitOf } from "../splits/splits";
import { isSmallWindow } from "./small";
import { addressBarInSidebar, windowCornerRadius } from "./layout";

const sent = new Map<string, string>();

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
  if (!w || isSmallWindow(w) || w.kind === "private" || splitOf(s, activeTabId(s, windowId))) return false;
  return bookmarksShown(s.settings) && s.settings.bookmarksBar === "always";
}

function pageReachesCardTop(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  if (!w || bookmarksBarAbovePages(s, windowId)) return false;
  return isSmallWindow(w) || addressBarInSidebar(s, windowId);
}

export function pageRoundingIn(s: BrowserState, windowId: string, fixedRadius: number | null = WINDOW_CHROME.pageCornerRadius, windowRadius: () => number = windowCornerRadius): PageRounding {
  const card = pageFrameOf(drawnPageFrame(s, windowId), windowRadius(), 0, fixedRadius).radius;
  const top = pageReachesCardTop(s, windowId) ? card : 0;
  return { radius: top, corners: [top, top, card, card] };
}

export function syncPageCorners(s: BrowserState, send = windowControls.setPageRounding, fixedRadius: number | null = WINDOW_CHROME.pageCornerRadius) {
  for (const id of Object.keys(s.windows)) {
    const rounding = pageRoundingIn(s, id, fixedRadius);
    const said = `${rounding.radius}:${rounding.corners.join(",")}`;
    if (sent.get(id) === said) continue;
    sent.set(id, said);
    send(id, rounding);
  }
  for (const id of [...sent.keys()]) if (!s.windows[id]) sent.delete(id);
}

export function startPageCornerSync() {
  if (WINDOW_CHROME.pageCornerRadius === null) return;
  const sync = () => syncPageCorners(useBrowser.getState());
  sync();
  useBrowser.subscribe(sync);
}
