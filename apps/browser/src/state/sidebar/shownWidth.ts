import { create } from "zustand";
import { useBrowser, type BrowserState } from "../browser/store";
import { shownSidebarWidth, sidebarWidthLimit } from "../../lib/windowLayout";

const useWindowWidths = create<Record<string, number>>()(() => ({}));

export function setWindowLayoutWidth(windowId: string, width: number) {
  if (width > 0 && useWindowWidths.getState()[windowId] !== width) useWindowWidths.setState({ [windowId]: width });
}

export function forgetWindowLayoutWidth(windowId: string) {
  if (!(windowId in useWindowWidths.getState())) return;
  useWindowWidths.setState(({ [windowId]: _, ...rest }) => rest, true);
}

export const windowWidthOf = (s: Pick<BrowserState, "windows">, windowId: string): number | undefined =>
  useWindowWidths.getState()[windowId] ?? s.windows[windowId]?.frame?.[2];

export const sidebarWidthIn = (s: BrowserState, windowId: string): number => shownSidebarWidth(s.settings.sidebarWidth, windowWidthOf(s, windowId));

export const keptSidebarWidth = (dragged: number, limit: number, saved = useBrowser.getState().settings.sidebarWidth): number => (dragged >= limit ? Math.max(dragged, saved) : dragged);

export function useShownSidebarWidth(windowId: string): number {
  const saved = useBrowser((s) => s.settings.sidebarWidth);
  const frameWidth = useBrowser((s) => s.windows[windowId]?.frame?.[2]);
  return useWindowWidths((w) => shownSidebarWidth(saved, w[windowId] ?? frameWidth));
}

export function useSidebarWidthLimit(windowId: string): number {
  const frameWidth = useBrowser((s) => s.windows[windowId]?.frame?.[2]);
  return useWindowWidths((w) => sidebarWidthLimit(w[windowId] ?? frameWidth));
}
