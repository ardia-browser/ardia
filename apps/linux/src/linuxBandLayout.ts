import { useWindowId } from "../../browser/src/state/browser/hooks";
import { useWindowSettings } from "../../browser/src/state/browser/keyedWatch";
import type { BrowserState } from "../../browser/src/state/browser/store";
import { WINDOW_CHROME, type WindowChrome } from "../../browser/src/lib/windowChrome";
import { cardTopInset, windowControlsPlace } from "../../browser/src/state/windows/layout";

export * from "../../browser/src/state/windows/layout";

export function linuxCardTopInset(s: BrowserState, windowId: string, frame: number, chrome: WindowChrome = WINDOW_CHROME): number {
  if (windowControlsPlace(s, windowId, frame, chrome)?.host === "band") return frame;
  return cardTopInset(s, windowId, frame, chrome);
}

export function useCardTopInset(frame: number): number {
  const windowId = useWindowId();
  return useWindowSettings(windowId, (s) => linuxCardTopInset(s, windowId, frame));
}
