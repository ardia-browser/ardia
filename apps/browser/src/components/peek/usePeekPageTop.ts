import { useSettings, useTab } from "../../state/browser/hooks";
import { useBookmarksBarMode } from "../../state/bookmarks/hooks";
import { useShareFor } from "../../state/media/screenShare";
import { useAddressBarInSidebar, useMinimalism } from "../../state/windows/layout";
import { bookmarksBarShown } from "../bookmarks/BookmarksBar";
import { useBookmarksBarHeight } from "../bookmarks/barSize";
import { SHARE_BAR_HEIGHT } from "../media/ShareBar";
import { useToolbarRow } from "../toolbar/useToolbarRow";
import { cardChrome } from "../window/paneChrome";

export function usePeekPageTop(windowId: string, tabId: string): number {
  const addressInSidebar = useAddressBarInSidebar();
  const hideWhileScrolling = useSettings((s) => s.hideToolbarWhileScrolling);
  const barMode = useBookmarksBarMode(windowId);
  const url = useTab(tabId, (t) => t?.url ?? "");
  const toolbar = useToolbarRow().height;
  const bookmarks = useBookmarksBarHeight();
  const sharing = !!useShareFor(tabId);
  const minimal = useMinimalism();
  const chrome = cardChrome({ addressInSidebar, small: false, minimal, split: false, fullscreen: false, hideWhileScrolling });
  return (chrome.kind === "none" ? 0 : toolbar) + (bookmarksBarShown(barMode, { url }) ? bookmarks : 0) + (sharing ? SHARE_BAR_HEIGHT : 0);
}
