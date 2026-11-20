import { useBrowser, type BrowserState } from "../browser/store";
import { ALL, useKeyed, watchSettings } from "../browser/keyedWatch";
import { shownSidebarWidth, sidebarWidthLimit } from "../../lib/windowLayout";
import { useWindowRootWidth, windowRootWidth } from "../windows/rootSize";

export const windowWidthOf = (s: Pick<BrowserState, "windows">, windowId: string): number | undefined => windowRootWidth(s, windowId);

export const sidebarWidthIn = (s: BrowserState, windowId: string): number => shownSidebarWidth(s.settings.sidebarWidth, windowWidthOf(s, windowId));

export const keptSidebarWidth = (dragged: number, limit: number, saved = useBrowser.getState().settings.sidebarWidth): number => (dragged >= limit ? Math.max(dragged, saved) : dragged);

export function useShownSidebarWidth(windowId: string): number {
  const saved = useKeyed(watchSettings, ALL, () => useBrowser.getState().settings.sidebarWidth);
  return shownSidebarWidth(saved, useWindowRootWidth(windowId));
}

export function useSidebarWidthLimit(windowId: string): number {
  return sidebarWidthLimit(useWindowRootWidth(windowId));
}
