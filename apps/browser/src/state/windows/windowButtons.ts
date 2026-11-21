import { applyWindowButtonStyle, WINDOW_BUTTON_STYLES, windowControlsDrawn, type WindowButtonStyle } from "../../lib/windowChrome";
import { useBrowser, type BrowserState } from "../browser/store";

type StyleStore = { getState(): Pick<BrowserState, "settings">; subscribe(listener: (s: Pick<BrowserState, "settings">) => void): () => void };
type StyleTarget = { styles: readonly WindowButtonStyle[]; apply(style: WindowButtonStyle): boolean };

const PLATFORM: StyleTarget = { styles: WINDOW_BUTTON_STYLES, apply: applyWindowButtonStyle };

export const windowButtonStyleIn = (s: Pick<BrowserState, "settings">, styles: readonly WindowButtonStyle[] = WINDOW_BUTTON_STYLES): WindowButtonStyle =>
  styles.includes(s.settings.windowButtons) ? s.settings.windowButtons : windowControlsDrawn() ? "native" : "trafficLights";

const windowButtonStyleOf = (s: Pick<BrowserState, "settings">) => windowButtonStyleIn(s);

export function startWindowButtonStyle(store: StyleStore = useBrowser, target: StyleTarget = PLATFORM): () => void {
  if (target.styles.length < 2) return () => {};
  target.apply(windowButtonStyleIn(store.getState(), target.styles));
  return store.subscribe((s) => void target.apply(windowButtonStyleIn(s, target.styles)));
}

export const useWindowButtonStyle = (): WindowButtonStyle => useBrowser(windowButtonStyleOf);
