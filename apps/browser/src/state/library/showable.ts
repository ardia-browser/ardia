import { useBrowser, type BrowserState } from "../browser/store";
import { usePages } from "../tabs/pageState";
import { libraryAvailable } from "./library";

export function pageFullscreenIn(s: Pick<BrowserState, "tabs">, windowId: string): boolean {
  const pages = usePages.getState().pages;
  for (const tabId in pages) if (pages[tabId]!.fullscreen && s.tabs[tabId]?.windowId === windowId) return true;
  return false;
}

export const libraryShowableIn = (windowId: string): boolean => {
  const s = useBrowser.getState();
  return libraryAvailable(s, windowId) && !pageFullscreenIn(s, windowId);
};
