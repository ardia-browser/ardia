import { applyWindowButtonStyle, WINDOW_BUTTON_STYLES, WINDOW_CHROME, type WindowButtonStyle, type WindowChrome } from "./platformChrome";

export { applyWindowButtonStyle, WINDOW_BUTTON_STYLES, WINDOW_CHROME, type WindowButtonStyle, type WindowChrome };
export { TRAFFIC_LIGHTS_WIDTH, WINDOW_CONTROLS, windowButtonsFor, windowControlsWidth, type WindowButton } from "./windowButtonLayout";

export function captionRoom(fromRight: number, fromTop = 0, chrome: WindowChrome = WINDOW_CHROME): number {
  if (fromTop >= chrome.titleBarHeight) return 0;
  return Math.max(0, chrome.trailingWidth - fromRight);
}

export function captionClearTop(top: number, rowHeight: number, fromRight: number, chrome: WindowChrome = WINDOW_CHROME): number {
  if (!captionRoom(fromRight, top, chrome)) return top;
  return Math.max(top, chrome.titleBarHeight - rowHeight);
}

export function trailingClearance(top: number, margin: number, controlsBottom: number, chrome: WindowChrome = WINDOW_CHROME): number {
  return top < controlsBottom ? Math.max(margin, chrome.trailingWidth) : margin;
}

export const windowButtonsChoosable = WINDOW_BUTTON_STYLES.length > 1;

export const trafficLightsDrawn = (chrome: WindowChrome = WINDOW_CHROME): boolean => chrome.leadingWidth > 0 && !chrome.leadingButtons.length;

export const windowControlsDrawn = (chrome: WindowChrome = WINDOW_CHROME): boolean => chrome.leadingButtons.length + chrome.trailingButtons.length > 0;

let chromeVersion = 0;
const chromeWatchers = new Set<() => void>();

export const windowChromeVersion = (): number => chromeVersion;

export function onWindowChromeChange(listener: () => void): () => void {
  chromeWatchers.add(listener);
  return () => void chromeWatchers.delete(listener);
}

export function noteWindowChromeChanged() {
  chromeVersion += 1;
  for (const watcher of [...chromeWatchers]) watcher();
}
