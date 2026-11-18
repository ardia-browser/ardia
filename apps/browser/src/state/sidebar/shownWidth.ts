import { useBrowser, type BrowserState } from "../browser/store";
import { shownSidebarWidth, sidebarWidthLimit } from "../../lib/windowLayout";
import { useWindowRootWidth, useWindowRootWidthAs, windowRootWidth } from "../windows/rootSize";

export const windowWidthOf = (s: Pick<BrowserState, "windows">, windowId: string): number | undefined => windowRootWidth(s, windowId);

export const sidebarWidthIn = (s: BrowserState, windowId: string): number => shownSidebarWidth(s.settings.sidebarWidth, windowWidthOf(s, windowId));

export const keptSidebarWidth = (dragged: number, limit: number, saved = useBrowser.getState().settings.sidebarWidth): number => (dragged >= limit ? Math.max(dragged, saved) : dragged);

export function useShownSidebarWidthAs<T>(windowId: string, select: (width: number) => T): T {
  const saved = useBrowser((s) => s.settings.sidebarWidth);
  return useWindowRootWidthAs(windowId, (width) => select(shownSidebarWidth(saved, width)));
}

export const useShownSidebarWidth = (windowId: string): number => useShownSidebarWidthAs(windowId, (width) => width);

export function useSidebarWidthLimit(windowId: string): number {
  return sidebarWidthLimit(useWindowRootWidth(windowId));
}
