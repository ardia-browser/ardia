import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { applyWindowButtonStyle, noteWindowChromeChanged, onWindowChromeChange, WINDOW_BUTTON_STYLES, WINDOW_CHROME, windowChromeVersion, windowControlsDrawn, type WindowButtonStyle, type WindowChrome } from "../../lib/windowChrome";
import { parseButtonLayout, type WindowButtonLayout } from "../../lib/windowButtonLayout";
import { useBrowser, type BrowserState } from "../browser/store";

type StyleStore = { getState(): Pick<BrowserState, "settings">; subscribe(listener: (s: Pick<BrowserState, "settings">) => void): () => void };
type StyleTarget = { styles: readonly WindowButtonStyle[]; apply(style: WindowButtonStyle, layout: WindowButtonLayout): boolean };
export type DesktopButtons = { raw: string | null; reported: boolean; tiling?: boolean };
type DesktopStore = { getState(): DesktopButtons; subscribe(listener: (d: DesktopButtons) => void): () => void };

const PLATFORM: StyleTarget = { styles: WINDOW_BUTTON_STYLES, apply: applyWindowButtonStyle };

const NO_WINDOW_BUTTONS = "";

export const useDesktopButtons = create<DesktopButtons>()(() => ({ raw: null, reported: false, tiling: false }));

export const setDesktopButtonLayout = (raw: string | null, tiling = false) => {
  const current = useDesktopButtons.getState();
  if (current.reported && current.raw === raw && !!current.tiling === tiling) return;
  useDesktopButtons.setState({ raw, reported: true, tiling });
};

export const desktopButtonLayout = (desktop: DesktopButtons = useDesktopButtons.getState()): WindowButtonLayout => parseButtonLayout(desktop.tiling ? NO_WINDOW_BUTTONS : desktop.raw);

export const windowButtonStyleIn = (s: Pick<BrowserState, "settings">, styles: readonly WindowButtonStyle[] = WINDOW_BUTTON_STYLES): WindowButtonStyle =>
  styles.includes(s.settings.windowButtons) ? s.settings.windowButtons : windowControlsDrawn() ? "native" : "trafficLights";

const windowButtonStyleOf = (s: Pick<BrowserState, "settings">) => windowButtonStyleIn(s);

export function startWindowButtonStyle(store: StyleStore = useBrowser, target: StyleTarget = PLATFORM, desktop: DesktopStore = useDesktopButtons): () => void {
  if (target.styles.length < 2) return () => {};
  const apply = () => {
    if (target.apply(windowButtonStyleIn(store.getState(), target.styles), desktopButtonLayout(desktop.getState()))) noteWindowChromeChanged();
  };
  apply();
  const stops = [store.subscribe(apply), desktop.subscribe(apply)];
  return () => stops.forEach((stop) => stop());
}

export const useWindowButtonStyle = (): WindowButtonStyle => useBrowser(windowButtonStyleOf);

export const useWindowChromeVersion = (): number => useSyncExternalStore(onWindowChromeChange, windowChromeVersion, windowChromeVersion);

export const useWindowChrome = (): WindowChrome => {
  useWindowChromeVersion();
  return WINDOW_CHROME;
};
