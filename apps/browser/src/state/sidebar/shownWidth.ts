import { useBrowser, type BrowserState } from "../browser/store";
import { ALL, useKeyed, watchSettings } from "../browser/keyedWatch";
import { shownSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, sidebarWidthLimit } from "../../lib/windowLayout";
import { useWindowRootWidth } from "../windows/rootSize";

export const sidebarWidthIn = (s: Pick<BrowserState, "settings">, _windowId?: string): number => shownSidebarWidth(s.settings.sidebarWidth);

export function useShownSidebarWidth(_windowId: string): number {
  const saved = useKeyed(watchSettings, ALL, () => useBrowser.getState().settings.sidebarWidth);
  return shownSidebarWidth(saved);
}

export const sidebarResizeBounds = (docked: boolean, windowWidth: number | null | undefined) => ({ min: SIDEBAR_MIN_WIDTH, max: docked ? sidebarWidthLimit(windowWidth) : SIDEBAR_MAX_WIDTH });

export const widthToSave = (width: number, dragged: boolean): number | null => (dragged ? width : null);

export function useSidebarWidthLimit(windowId: string): number {
  return sidebarWidthLimit(useWindowRootWidth(windowId));
}
