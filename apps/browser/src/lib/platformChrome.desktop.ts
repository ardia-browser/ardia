import type { PopUpChrome, WindowButtonStyle, WindowChrome } from "./platformChrome";
import { CAPTION_WINDOW_CHROME as WINDOWS_CHROME } from "./captionChrome";
import { BROWSER_BUTTON_LAYOUT, TRAFFIC_LIGHTS_WIDTH, WINDOW_CONTROLS, windowControlsWidth, type WindowButtonLayout } from "./windowButtonLayout";
import { sameList } from "./lists";

export { ADVANCED_PANE_SYMBOL, PANEL_FIELD_LIFT } from "./captionChrome";

const WINDOWS_CAPTION_SPARE = WINDOWS_CHROME.trailingWidth - windowControlsWidth(WINDOWS_CHROME.trailingButtons.length);

export const nativeButtonsChrome = ({ leading, trailing }: WindowButtonLayout): WindowChrome => ({
  leadingWidth: leading.length ? WINDOW_CONTROLS.edge + windowControlsWidth(leading.length) : 0,
  trailingWidth: WINDOWS_CAPTION_SPARE + windowControlsWidth(trailing.length),
  titleBarHeight: WINDOWS_CHROME.titleBarHeight,
  leadingButtons: leading,
  trailingButtons: trailing,
});

export const NATIVE_BUTTONS_CHROME: WindowChrome = nativeButtonsChrome(BROWSER_BUTTON_LAYOUT);

export const TRAFFIC_LIGHTS_CHROME: WindowChrome = { leadingWidth: TRAFFIC_LIGHTS_WIDTH, trailingWidth: 0, titleBarHeight: 0, leadingButtons: [], trailingButtons: [] };

export const HIDDEN_BUTTONS_CHROME: WindowChrome = { leadingWidth: 0, trailingWidth: 0, titleBarHeight: 0, leadingButtons: [], trailingButtons: [] };

export const WINDOW_CHROME: WindowChrome = { ...NATIVE_BUTTONS_CHROME };

export const WINDOW_BUTTON_STYLES: readonly WindowButtonStyle[] = ["native", "trafficLights", "hidden"];

const sameChrome = (a: WindowChrome, b: WindowChrome) =>
  a.leadingWidth === b.leadingWidth && a.trailingWidth === b.trailingWidth && a.titleBarHeight === b.titleBarHeight && sameList(a.leadingButtons, b.leadingButtons) && sameList(a.trailingButtons, b.trailingButtons);

export function applyWindowButtonStyle(style: WindowButtonStyle, layout: WindowButtonLayout = BROWSER_BUTTON_LAYOUT): boolean {
  const next = style === "native" ? nativeButtonsChrome(layout) : style === "trafficLights" ? TRAFFIC_LIGHTS_CHROME : HIDDEN_BUTTONS_CHROME;
  if (sameChrome(WINDOW_CHROME, next)) return false;
  Object.assign(WINDOW_CHROME, next);
  return true;
}

export const POP_UP_CHROME: PopUpChrome = { indicator: "accentUpDown", growsToItsTitle: false };

export const REFRESH_ARROW_RING_OFFSET = { x: 0.35, y: 0.6 } as const;
export const NAVIGATION_GLYPH_WEIGHT = "medium" as const;
