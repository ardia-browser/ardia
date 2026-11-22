import { useBrowser, type BrowserState } from "../../browser/src/state/browser/store";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { useFullscreenTab } from "../../browser/src/state/tabs/pageState";
import { useWindowChrome } from "../../browser/src/state/windows/windowButtons";
import { WINDOW_CHROME, WINDOW_CONTROLS, windowControlsWidth, type WindowChrome } from "../../browser/src/lib/windowChrome";
import { CARD_INSET } from "../../browser/src/lib/windowLayout";
import { sidebarWidthIn } from "../../browser/src/state/sidebar/shownWidth";
import { SIDEBAR_FOOTER_DOWNLOADS } from "../../browser/src/components/sidebar/geometry";
import { addressBarInSidebar, pageFrameIn, sidebarCaptionRoom, sidebarHeaderCollapsed, windowControlsPlace } from "../../browser/src/state/windows/layout";
import { windowButtonsRendered } from "./windowControlsRules";

export * from "../../browser/src/state/windows/layout";

export const trailingButtonsRendered = (s: BrowserState, windowId: string, pageFullScreen: boolean, chrome: WindowChrome = WINDOW_CHROME): boolean =>
  windowButtonsRendered({ placed: chrome.trailingWidth > 0 && windowControlsPlace(s, windowId, pageFrameIn(s, windowId), chrome) !== null, pageFullScreen });

export const menuBesideWindowButtons = (s: BrowserState, windowId: string, pageFullScreen: boolean, chrome: WindowChrome = WINDOW_CHROME): boolean =>
  chrome.trailingButtons.includes("menu") && trailingButtonsRendered(s, windowId, pageFullScreen, chrome);

export const linuxSidebarCaptionRoom = (s: BrowserState, windowId: string, pageFullScreen: boolean, chrome: WindowChrome = WINDOW_CHROME): number =>
  trailingButtonsRendered(s, windowId, pageFullScreen, chrome) ? sidebarCaptionRoom(s, windowId, chrome) : 0;

export const linuxSidebarHeaderCollapsed = (s: BrowserState, windowId: string, pageFullScreen: boolean, chrome: WindowChrome = WINDOW_CHROME): boolean =>
  sidebarHeaderCollapsed(s, windowId, chrome) && menuBesideWindowButtons(s, windowId, pageFullScreen, chrome);

const CONTROLS_GAP = 3;

export function headerFitsDownloads(s: BrowserState, windowId: string, pageFullScreen: boolean, chrome: WindowChrome = WINDOW_CHROME): boolean {
  if (!linuxSidebarCaptionRoom(s, windowId, pageFullScreen, chrome)) return true;
  const controlsLeft = sidebarWidthIn(s, windowId) - WINDOW_CONTROLS.edge - windowControlsWidth(chrome.trailingButtons.length);
  return Math.max(chrome.leadingWidth + 6, CARD_INSET) + SIDEBAR_FOOTER_DOWNLOADS.size + CONTROLS_GAP <= controlsLeft;
}

export const linuxDownloadsInSidebarFooter = (s: BrowserState, windowId: string, pageFullScreen: boolean, chrome: WindowChrome = WINDOW_CHROME): boolean =>
  addressBarInSidebar(s, windowId) || linuxSidebarHeaderCollapsed(s, windowId, pageFullScreen, chrome) || !headerFitsDownloads(s, windowId, pageFullScreen, chrome);

export function useSidebarHeaderCollapsed(): boolean {
  useWindowChrome();
  const windowId = useWindowId();
  const pageFullScreen = !!useFullscreenTab(windowId);
  return useBrowser((s) => linuxSidebarHeaderCollapsed(s, windowId, pageFullScreen));
}

export function useDownloadsInSidebarFooter(): boolean {
  useWindowChrome();
  const windowId = useWindowId();
  const pageFullScreen = !!useFullscreenTab(windowId);
  return useBrowser((s) => linuxDownloadsInSidebarFooter(s, windowId, pageFullScreen));
}

export function useMenuBesideWindowButtons(): boolean {
  useWindowChrome();
  const windowId = useWindowId();
  const pageFullScreen = !!useFullscreenTab(windowId);
  return useBrowser((s) => menuBesideWindowButtons(s, windowId, pageFullScreen));
}

export function useSidebarCaptionRoom(): number {
  useWindowChrome();
  const windowId = useWindowId();
  const pageFullScreen = !!useFullscreenTab(windowId);
  return useBrowser((s) => linuxSidebarCaptionRoom(s, windowId, pageFullScreen));
}
