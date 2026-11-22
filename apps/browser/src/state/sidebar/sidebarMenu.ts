import { showMenu, type MenuItem } from "../../platform/menus";
import { tabLayoutOf, tabsShownIn } from "../browser/model";
import { switchProfile } from "../browser/actions";
import { requestCreateProfile } from "../profiles/createProfileRequest";
import { useBrowser, type BrowserState } from "../browser/store";
import { menuShortcut } from "../commands/commandShortcuts";
import { bookmarkAllTabs } from "../bookmarks/actions";
import { bookmarksShown } from "../bookmarks/visibility";
import { toggleNewTabBar } from "../omnibox/newTabBar";
import { newGroupWithSelection } from "./actions";
import { closeAllTabs } from "./clearTabs";
import { lastClosedEntry } from "../windows/reopenClosed";
import { consentToken } from "../telemetry/client";
import { newLiveFolderMenuItem, runNewLiveFolder } from "./liveMenus";
import { sections } from "./menuParts";
import { pinnedFoldMenuItem, runPinnedFold } from "./pinnedFold";
import { addSharedFolder } from "../sharedFolders/actions";
import { canAddSharedFolder } from "../sharedFolders/removal";
import { switchTabLayout, toggleSidebarSide } from "../settings/actions";
import { t } from "../../lib/uiLanguage";


const store = () => useBrowser.getState();

export function sidebarMenuItems(s: BrowserState, windowId: string): MenuItem[] {
  const w = s.windows[windowId];
  const inSidebar = tabLayoutOf(s, windowId) === "sidebar";
  return sections(
    [
      { id: "newTab", title: t(`New Tab`), symbol: "plus.app", ...menuShortcut("newTab", s) },
      { id: "reopen", title: t(`Reopen Closed Tab`), enabled: !!lastClosedEntry(s, windowId), ...menuShortcut("reopenClosedTab", s) },
    ],
    [
      { id: "newGroup", title: t(`New Group`), symbol: "folder.badge.plus" },
      newLiveFolderMenuItem(),
      ...(canAddSharedFolder(w?.profileId) ? [{ id: "addShared", title: t(`Add Shared Folder…`), symbol: "person.2" }] : []),
    ],
    [{ id: "newProfile", title: t(`New Profile…`), symbol: "plus" }],
    [bookmarksShown(s.settings) && { id: "bookmarkAll", title: t(`Bookmark All Tabs…`), symbol: "bookmark", ...menuShortcut("bookmarkAllTabs", s) }],
    [
      ...pinnedFoldMenuItem(s, windowId),
      { id: "tabLayout", title: t(`Show Tabs in Sidebar`), symbol: "sidebar.left", checked: inSidebar, ...menuShortcut("toggleTabLayout", s) },
      ...(inSidebar ? [{ id: "sidebarSide", title: t(`Sidebar on Right`), symbol: "sidebar.right", checked: s.settings.sidebarSide === "right", ...menuShortcut("toggleSidebarSide", s) }] : []),
      { id: "autoHide", title: t(`Auto-Hide Tabs`), checked: !!w && !tabsShownIn(s, windowId), ...menuShortcut("toggleSidebar", s) },
    ],
    [{ id: "closeAll", title: t(`Close All Tabs`), symbol: "xmark", ...menuShortcut("closeAllTabs", s) }],
  );
}

export async function openSidebarMenu(windowId: string) {
  const consent = consentToken();
  const choice = await showMenu(sidebarMenuItems(store(), windowId));
  if (!choice || runNewLiveFolder(windowId, choice) || runPinnedFold(windowId, choice)) return;
  const s = store();
  if (choice === "newTab") {
    if (!toggleNewTabBar(windowId)) s.newTab(windowId, { newTabCommand: true });
  } else if (choice === "reopen") s.reopenClosed(windowId);
  else if (choice === "newGroup") {
    const id = s.newTab(windowId);
    if (id) newGroupWithSelection(windowId, [id]);
  } else if (choice === "newProfile") void requestCreateProfile(windowId).then((id) => id && switchProfile(windowId, id));
  else if (choice === "addShared") void addSharedFolder(windowId);
  else if (choice === "bookmarkAll") bookmarkAllTabs(windowId);
  else if (choice === "tabLayout") switchTabLayout(windowId, consent);
  else if (choice === "sidebarSide") toggleSidebarSide();
  else if (choice === "autoHide") s.toggleSidebar(windowId);
  else if (choice === "closeAll") closeAllTabs(windowId);
}
