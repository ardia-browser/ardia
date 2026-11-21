import type { PopUpChrome, WindowButtonStyle, WindowChrome } from "./platformChrome";
import { WINDOW_CHROME as WINDOWS_CHROME } from "./platformChrome.windows";

export { ADVANCED_PANE_SYMBOL, PANEL_FIELD_LIFT } from "./platformChrome.windows";

export const NATIVE_BUTTONS_CHROME: WindowChrome = { ...WINDOWS_CHROME };

export const TRAFFIC_LIGHTS_CHROME: WindowChrome = { leadingWidth: 78, trailingWidth: 0, titleBarHeight: 0 };

export const HIDDEN_BUTTONS_CHROME: WindowChrome = { leadingWidth: 0, trailingWidth: 0, titleBarHeight: 0 };

const CHROME_OF: Record<WindowButtonStyle, WindowChrome> = { native: NATIVE_BUTTONS_CHROME, trafficLights: TRAFFIC_LIGHTS_CHROME, hidden: HIDDEN_BUTTONS_CHROME };

export const WINDOW_CHROME: WindowChrome = { ...NATIVE_BUTTONS_CHROME };

export const WINDOW_BUTTON_STYLES: readonly WindowButtonStyle[] = ["native", "trafficLights", "hidden"];

export function applyWindowButtonStyle(style: WindowButtonStyle): boolean {
  const next = CHROME_OF[style];
  if (WINDOW_CHROME.leadingWidth === next.leadingWidth && WINDOW_CHROME.trailingWidth === next.trailingWidth && WINDOW_CHROME.titleBarHeight === next.titleBarHeight) return false;
  Object.assign(WINDOW_CHROME, next);
  return true;
}

export const POP_UP_CHROME: PopUpChrome = { indicator: "accentUpDown", growsToItsTitle: false };
