import type { BrowserCommand } from "../../platform/commands";
import type { Settings } from "../settings/settings";
import type { BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";

export const BOOKMARK_COMMANDS: readonly BrowserCommand[] = [
  "bookmarkPage",
  "addBookmarkToFolder",
  "openBookmark",
  "manageBookmarks",
  "exportBookmarks",
  "bookmarkAllTabs",
  "setBookmarksBar",
  "toggleBookmarksBar",
  "addFolderToSidebar",
  "restoreArcFolders",
];

const BOOKMARK_COMMAND_SET: ReadonlySet<string> = new Set(BOOKMARK_COMMANDS);

export const bookmarksShown = (settings: Pick<Settings, "showBookmarks">) => settings.showBookmarks;

export const hidesBookmarkCommand = (settings: Pick<Settings, "showBookmarks">, command: string) =>
  !settings.showBookmarks && BOOKMARK_COMMAND_SET.has(command);

export function bookmarksBarShownIn(s: BrowserState, windowId: string | null | undefined): boolean {
  const mode = s.settings.bookmarksBar;
  const active = windowId ? activeTabId(s, windowId) : undefined;
  return mode === "always" || (mode === "newTab" && !(active && s.tabs[active]?.url));
}
