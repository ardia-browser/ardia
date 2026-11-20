import { create } from "zustand";
import { autoHidesTabsIn, sidebarSideOf, tabLayoutOf, tabsShownIn } from "../browser/model";
import { switchOn } from "../../platform/killSwitches";
import { ARC_LIGHTS_CENTER, lightsCenter, sidebarLightsCenter, toolbarLightsCenter, TOP_STRIP_LIGHTS_CENTER } from "./dockMotion";
import { frameCornerRadius, onWindowEvent, windowFrame, type LightsPlace } from "../../platform/windows";
import { rootSizeOfFrame } from "../settings/interfaceScale";
import { DEFAULT_SIDEBAR_WIDTH, pageFrameInsetOf } from "../../lib/windowLayout";
import { useBrowser, type BrowserState } from "../browser/store";
import { useWindowId } from "../browser/hooks";
import { useSettingValue } from "../tabs/tabWatch";
import { BROWSER_WINDOW_BUTTONS, captionClearTop, captionRoom, WINDOW_CHROME, WINDOW_CONTROLS, windowControlsWidth, type WindowChrome } from "../../lib/windowChrome";
import { toolbarRowOf } from "../../lib/toolbarRow";
import { SMALL_BAR_HEIGHT } from "./small";
import type { CaptionRegion } from "../../platform/windowControls";
import { sidebarWidthIn } from "../sidebar/shownWidth";
import { onWindowRootSizes, windowRootWidth } from "./rootSize";

export { drawnWindowCornerRadius, frameCornerRadius, windowCornerRadius, windowFrame } from "../../platform/windows";
export { onInterfaceScaleChange } from "../settings/interfaceScale";

export const windowRootShape = (windowId: string): Promise<{ width: number; height: number; radius: number } | null> =>
  Promise.all([windowFrame(windowId), frameCornerRadius(windowId)]).then(([frame, radius]) => (frame ? { ...rootSizeOfFrame(frame), radius } : null));

export function onFullScreenLeft(windowId: string, run: () => void): () => void {
  const subscription = onWindowEvent((e) => {
    if (e.type === "fullScreen" && e.id === windowId && !e.on) run();
  });
  return () => subscription.remove();
}

export function useTabLayout(): "sidebar" | "top" {
  const windowId = useWindowId();
  return useBrowser((s) => tabLayoutOf(s, windowId));
}

export const minimalismIn = (s: BrowserState, windowId: string): boolean => s.settings.minimalismMode && s.windows[windowId]?.kind !== "small";

export const useMinimalism = (): boolean => {
  const windowId = useWindowId();
  return useBrowser((s) => minimalismIn(s, windowId));
};

export const sidebarAddressChosen = (settings: Pick<BrowserState["settings"], "addressBar" | "minimalismMode">): boolean =>
  settings.addressBar === "sidebar" || settings.minimalismMode;

export function addressBarInSidebar(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  return (
    !!w &&
    (s.settings.addressBar === "sidebar" || minimalismIn(s, windowId)) &&
    (tabsShownIn(s, windowId) || switchOn("sidebarSlide")) &&
    tabLayoutOf(s, w.id) === "sidebar"
  );
}

export function useAddressBarInSidebar(): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => addressBarInSidebar(s, windowId));
}

export function openingLightsCenter(s: BrowserState, windowId: string): LightsPlace | null {
  const w = s.windows[windowId];
  if (!w) return null;
  const open = tabsShownIn(s, windowId);
  if (tabLayoutOf(s, w.id) === "top") return open ? [...TOP_STRIP_LIGHTS_CENTER] : lightsCenter(DEFAULT_SIDEBAR_WIDTH);
  const width = sidebarWidthIn(s, windowId);
  const frame = pageFrameInsetOf(s.settings.pageFrame, {
    borderlessMode: s.settings.borderlessMode || minimalismIn(s, windowId),
    zeroInFullScreen: s.settings.pageFrameZeroInFullScreen,
    fullScreen: !!w.fullScreen,
    zeroWhenTabsHidden: s.settings.pageFrameZeroWhenTabsHidden,
    tabsHidden: autoHidesTabsIn(s, windowId),
  });
  const base = sidebarAddressChosen(s.settings) ? ARC_LIGHTS_CENTER : toolbarLightsCenter(s.settings.compactToolbar, frame);
  return sidebarLightsCenter(sidebarSideOf(s, w.id) === "right", width, open ? 0 : width, 0, base);
}

export function usePageFrameInset(): number {
  const windowId = useWindowId();
  return useBrowser((s) =>
    pageFrameInsetOf(s.settings.pageFrame, {
      borderlessMode: s.settings.borderlessMode || minimalismIn(s, windowId),
      zeroInFullScreen: s.settings.pageFrameZeroInFullScreen,
      fullScreen: !!s.windows[windowId]?.fullScreen,
      zeroWhenTabsHidden: s.settings.pageFrameZeroWhenTabsHidden,
      tabsHidden: autoHidesTabsIn(s, windowId),
    }),
  );
}

export const pageFrameIn = (s: BrowserState, windowId: string): number =>
  pageFrameInsetOf(s.settings.pageFrame, {
    borderlessMode: s.settings.borderlessMode || minimalismIn(s, windowId),
    zeroInFullScreen: s.settings.pageFrameZeroInFullScreen,
    fullScreen: !!s.windows[windowId]?.fullScreen,
    zeroWhenTabsHidden: s.settings.pageFrameZeroWhenTabsHidden,
    tabsHidden: autoHidesTabsIn(s, windowId),
  });

const toolbarless = (s: BrowserState, windowId: string): boolean => addressBarInSidebar(s, windowId) || minimalismIn(s, windowId);

const sidebarShownOnLeft = (s: BrowserState, windowId: string): boolean =>
  tabLayoutOf(s, windowId) === "sidebar" && sidebarSideOf(s, windowId) !== "right" && tabsShownIn(s, windowId);

const controlsLeadSidebar = (s: BrowserState, windowId: string): boolean =>
  !!addressBarInSidebar(s, windowId) && !minimalismIn(s, windowId) && sidebarShownOnLeft(s, windowId);

function cardReachesCaption(s: BrowserState, windowId: string, chrome: WindowChrome): boolean {
  const w = s.windows[windowId];
  if (!chrome.trailingWidth || !w || w.fullScreen || w.kind === "small" || controlsLeadSidebar(s, windowId)) return false;
  return tabLayoutOf(s, windowId) === "top" || sidebarSideOf(s, windowId) !== "right" || !tabsShownIn(s, windowId);
}

export function cardCaptionRoom(s: BrowserState, windowId: string, frame: number, chrome: WindowChrome = WINDOW_CHROME): number {
  if (!cardReachesCaption(s, windowId, chrome)) return 0;
  const strip = tabLayoutOf(s, windowId) === "top" && tabsShownIn(s, windowId);
  return strip ? 0 : captionRoom(frame, 0, chrome);
}

export function cardTopInset(s: BrowserState, windowId: string, frame: number, chrome: WindowChrome = WINDOW_CHROME): number {
  if (!cardReachesCaption(s, windowId, chrome) || (tabLayoutOf(s, windowId) === "top" && !minimalismIn(s, windowId))) return frame;
  const toolbar = toolbarless(s, windowId) ? 0 : toolbarRowOf(s.settings.compactToolbar).height;
  return captionClearTop(frame, toolbar, frame, chrome);
}

export function sidebarCaptionRoom(s: BrowserState, windowId: string, chrome: WindowChrome = WINDOW_CHROME): number {
  const w = s.windows[windowId];
  if (!chrome.trailingWidth || !w || w.fullScreen || sidebarSideOf(s, windowId) !== "right") return 0;
  return captionRoom(0, 0, chrome);
}

export type WindowControlsHost = "toolbar" | "sidebar" | "strip" | "band";
export type WindowControlsPlace = { centerY: number; size: number; host: WindowControlsHost };

export function windowControlsPlace(s: BrowserState, windowId: string, frame: number, chrome: WindowChrome = WINDOW_CHROME): WindowControlsPlace | null {
  const w = s.windows[windowId];
  if (!chrome.trailingWidth || !w || w.fullScreen) return null;
  if (w.kind === "small") return { centerY: Math.max(SMALL_BAR_HEIGHT, chrome.titleBarHeight) / 2, size: WINDOW_CONTROLS.small, host: "strip" };
  const top = tabLayoutOf(s, windowId) === "top";
  if (top && tabsShownIn(s, windowId)) return { centerY: TOP_STRIP_LIGHTS_CENTER[1], size: WINDOW_CONTROLS.regular, host: "strip" };
  const inSidebar = !top && sidebarSideOf(s, windowId) === "right" && tabsShownIn(s, windowId);
  if (toolbarless(s, windowId)) {
    if (inSidebar || controlsLeadSidebar(s, windowId)) return { centerY: ARC_LIGHTS_CENTER[1], size: WINDOW_CONTROLS.regular, host: "sidebar" };
    return { centerY: chrome.titleBarHeight / 2, size: WINDOW_CONTROLS.band, host: "band" };
  }
  if (inSidebar) return { centerY: toolbarLightsCenter(s.settings.compactToolbar, frame)[1], size: WINDOW_CONTROLS.regular, host: "sidebar" };
  const row = toolbarRowOf(s.settings.compactToolbar);
  return { centerY: frame + row.center, size: row.button, host: "toolbar" };
}

export const windowControlsBottom = (place: WindowControlsPlace | null): number => (place ? place.centerY + place.size / 2 : 0);

export function windowControlsLeading(s: BrowserState, windowId: string, chrome: WindowChrome = WINDOW_CHROME): boolean {
  const w = s.windows[windowId];
  return !!chrome.trailingWidth && !!w && !w.fullScreen && w.kind !== "small" && controlsLeadSidebar(s, windowId);
}

export const sidebarControlsRow = (s: BrowserState, windowId: string, chrome: WindowChrome = WINDOW_CHROME): number =>
  windowControlsLeading(s, windowId, chrome) ? WINDOW_CONTROLS.regular + WINDOW_CONTROLS.gap : 0;

const CAPTION_GUTTER_MIN = 3;
const SIDEBAR_TOOLS_TOP = 7;

export function captionRegions(s: BrowserState, windowId: string, overlaid = false, chrome: WindowChrome = WINDOW_CHROME): CaptionRegion[] {
  const frame = pageFrameIn(s, windowId);
  const place = windowControlsPlace(s, windowId, frame, chrome);
  if (!place || overlaid) return [];
  const ui = s.windowUi[windowId];
  if (ui?.panel.open || ui?.downloadsOpen) return [];
  const controls = windowControlsWidth(BROWSER_WINDOW_BUTTONS) + WINDOW_CONTROLS.edge;
  const beside = controls + WINDOW_CONTROLS.gap;
  const leadingRoom = s.settings.sidebarWidth - beside;
  const regions: CaptionRegion[] = !windowControlsLeading(s, windowId, chrome)
    ? [[-(chrome.trailingWidth - 2), 0, beside, windowControlsBottom(place)]]
    : leadingRoom > 0
      ? [[beside, 0, -leadingRoom, windowControlsBottom(place)]]
      : [];
  if (place.host === "strip") return regions;
  const gutter = Math.min(frame, place.centerY - place.size / 2 - 1, toolbarless(s, windowId) ? SIDEBAR_TOOLS_TOP : frame);
  if (gutter >= CAPTION_GUTTER_MIN) regions.push([0, 0, 0, gutter]);
  return regions;
}

export function sidebarHeaderCollapsed(s: BrowserState, windowId: string, chrome: WindowChrome = WINDOW_CHROME): boolean {
  const w = s.windows[windowId];
  if (chrome.leadingWidth || !chrome.trailingWidth || !w) return false;
  if (tabLayoutOf(s, windowId) !== "sidebar" || addressBarInSidebar(s, windowId) || sidebarSideOf(s, windowId) === "right") return false;
  return w.kind !== "private" && s.profileOrder.length < 2;
}

export const COLLAPSED_SIDEBAR_HEADER_MIN = 6;

export const collapsedSidebarHeader = (frame: number) => Math.max(frame, COLLAPSED_SIDEBAR_HEADER_MIN);

export const downloadsInSidebarFooter = (s: BrowserState, windowId: string, chrome: WindowChrome = WINDOW_CHROME): boolean =>
  addressBarInSidebar(s, windowId) || sidebarHeaderCollapsed(s, windowId, chrome);

export function useSidebarCaptionRoom(): number {
  const windowId = useWindowId();
  return useBrowser((s) => sidebarCaptionRoom(s, windowId));
}

export function useCardCaptionRoom(frame: number): number {
  const windowId = useWindowId();
  return useBrowser((s) => cardCaptionRoom(s, windowId, frame));
}

export function useCardTopInset(frame: number): number {
  const windowId = useWindowId();
  return useBrowser((s) => cardTopInset(s, windowId, frame));
}

export function useSidebarHeaderCollapsed(): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => sidebarHeaderCollapsed(s, windowId));
}

export function useDownloadsInSidebarFooter(): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => downloadsInSidebarFooter(s, windowId));
}

export function useWindowControlsCenterY(): number | null {
  const windowId = useWindowId();
  return useBrowser((s) => windowControlsPlace(s, windowId, pageFrameIn(s, windowId))?.centerY ?? null);
}

export function useWindowControlsSize(): number {
  const windowId = useWindowId();
  return useBrowser((s) => windowControlsPlace(s, windowId, pageFrameIn(s, windowId))?.size ?? 0);
}

export function useWindowControlsBottom(): number {
  const windowId = useWindowId();
  return useBrowser((s) => windowControlsBottom(windowControlsPlace(s, windowId, pageFrameIn(s, windowId))));
}

export function useWindowControlsLeading(): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => windowControlsLeading(s, windowId));
}

export const useSidebarControlsRowIn = (windowId: string): number => useBrowser((s) => sidebarControlsRow(s, windowId));

export function watchSidebarControlsRow(windowId: string, listener: (row: number) => void, chrome: WindowChrome = WINDOW_CHROME): () => void {
  let last = sidebarControlsRow(useBrowser.getState(), windowId, chrome);
  return useBrowser.subscribe((s) => {
    const row = sidebarControlsRow(s, windowId, chrome);
    if (row === last) return;
    last = row;
    listener(row);
  });
}

export function watchSidebarFieldPlace(windowId: string, listener: () => void, chrome: WindowChrome = WINDOW_CHROME): () => void {
  const place = (s: BrowserState) => {
    const side = sidebarSideOf(s, windowId);
    return [side, sidebarControlsRow(s, windowId, chrome), side === "right" ? windowRootWidth(s, windowId) : undefined] as const;
  };
  let last = place(useBrowser.getState());
  const check = () => {
    const now = place(useBrowser.getState());
    if (now.every((part, i) => part === last[i])) return;
    last = now;
    listener();
  };
  const stops = [useBrowser.subscribe(check), onWindowRootSizes(check)];
  return () => stops.forEach((stop) => stop());
}

export function useWindowControlsHost(): WindowControlsHost | null {
  const windowId = useWindowId();
  return useBrowser((s) => windowControlsPlace(s, windowId, pageFrameIn(s, windowId))?.host ?? null);
}

export const useToolbarLightsCenter = (): readonly [number, number] => toolbarLightsCenter(useBrowser((s) => s.settings.compactToolbar), usePageFrameInset());

type UrlAnchor = { left: number; top: number; width: number; sidebar?: { height: number } };

export const useUrlAnchors = create<Record<string, UrlAnchor>>()(() => ({}));

export function setUrlAnchor(windowId: string, anchor: UrlAnchor) {
  const current = useUrlAnchors.getState()[windowId];
  if (current && current.left === anchor.left && current.top === anchor.top && current.width === anchor.width && current.sidebar?.height === anchor.sidebar?.height) return;
  useUrlAnchors.setState({ [windowId]: anchor });
}

type CardAnchor = { left: number; top: number; width: number; height: number };

export const useCardAnchors = create<Record<string, CardAnchor>>()(() => ({}));

export function setCardAnchor(windowId: string, anchor: CardAnchor) {
  const current = useCardAnchors.getState()[windowId];
  if (current && current.left === anchor.left && current.top === anchor.top && current.width === anchor.width && current.height === anchor.height) return;
  useCardAnchors.setState({ [windowId]: anchor });
}

export const useToolbarExtensionsWidths = create<Record<string, number>>()(() => ({}));

export function watchToolbarExtensionsWidth(windowId: string, listener: (width: number | undefined) => void): () => void {
  listener(useToolbarExtensionsWidths.getState()[windowId]);
  return useToolbarExtensionsWidths.subscribe((w, prev) => {
    if (w[windowId] !== prev[windowId]) listener(w[windowId]);
  });
}

export function setToolbarExtensionsWidth(windowId: string, width: number) {
  if (useToolbarExtensionsWidths.getState()[windowId] === width) return;
  useToolbarExtensionsWidths.setState({ [windowId]: width });
}
