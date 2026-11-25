import { showMenu, type MenuItem } from "../../platform/menus";
import { activeTabId, tabLayoutOf, tabsShownIn } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { menuShortcut } from "../commands/commandShortcuts";
import { bookmarksBarShownIn, bookmarksShown } from "../bookmarks/visibility";
import { toggleNewTabBar } from "../omnibox/newTabBar";
import { openNewTabInSplit } from "../splits/actions";
import { splitViewAvailable } from "../splits/splits";
import { newGroupWithSelection } from "./actions";
import { closeAllTabs } from "./clearTabs";
import { lastClosedEntry } from "../windows/reopenClosed";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { newLiveFolderMenuItem, runNewLiveFolder } from "./liveMenus";
import { sections } from "./menuParts";
import { pinnedFoldMenuItem, runPinnedFold } from "./pinnedFold";
import { addSharedFolder } from "../sharedFolders/actions";
import { canAddSharedFolder } from "../sharedFolders/removal";
import { chooseSidebarSide, switchTabLayout } from "../settings/actions";
import { minimalismIn } from "../windows/layout";
import { t } from "../../lib/i18n";

const store = () => useBrowser.getState();

const BROWSER_LAYOUT_MENU_ID = "browserLayout";

export function browserLayoutItems(s: BrowserState, windowId: string): MenuItem[] {
  const w = s.windows[windowId];
  const inSidebar = tabLayoutOf(s, windowId) === "sidebar";
  const right = s.settings.sidebarSide === "right";
  const minimal = minimalismIn(s, windowId);
  const addressInToolbar = !minimal && (!inSidebar || s.settings.addressBar === "toolbar");
  return sections(
    [
      { id: "layout:sidebarLeft", title: t("Sidebar on Left"), symbol: "sidebar.left", checked: inSidebar && !right, ...(!inSidebar && !right ? menuShortcut("toggleTabLayout", s) : {}) },
      { id: "layout:sidebarRight", title: t("Sidebar on Right"), symbol: "sidebar.right", checked: inSidebar && right, ...(!inSidebar && right ? menuShortcut("toggleTabLayout", s) : {}) },
      { id: "layout:top", title: t("Top Tab Bar"), symbol: "menubar.rectangle", checked: !inSidebar, ...(inSidebar ? menuShortcut("toggleTabLayout", s) : {}) },
    ],
    [
      inSidebar && !minimal && { id: "layout:addressToolbar", title: t("Address Bar in Toolbar"), symbol: "menubar.rectangle", checked: s.settings.addressBar === "toolbar" },
      inSidebar && !minimal && { id: "layout:addressSidebar", title: t("Address Bar in Sidebar"), symbol: "sidebar.left", checked: s.settings.addressBar === "sidebar" },
      addressInToolbar && { id: "layout:compactToolbar", title: t("Compact Toolbar"), symbol: "rectangle.compress.vertical", checked: s.settings.compactToolbar },
    ],
    [
      { id: "layout:autoHide", title: t("Auto-Hide Tabs"), symbol: "eye.slash", checked: !!w && !tabsShownIn(s, windowId), ...menuShortcut("toggleSidebar", s) },
      { id: "layout:minimalism", title: t("Minimalism Mode"), symbol: "rectangle.leftthird.inset.filled", checked: s.settings.minimalismMode, ...menuShortcut("toggleMinimalism", s) },
      bookmarksShown(s.settings) && w?.kind !== "private" && { id: "layout:bookmarksBar", title: t("Bookmarks Bar"), symbol: "bookmark", checked: bookmarksBarShownIn(s, windowId), ...menuShortcut("toggleBookmarksBar", s) },
      ...pinnedFoldMenuItem(s, windowId),
    ],
  );
}

export function browserLayoutMenuItem(s: BrowserState, windowId: string): MenuItem {
  return { id: BROWSER_LAYOUT_MENU_ID, title: t("Browser Layout"), symbol: "sidebar.left", children: browserLayoutItems(s, windowId) };
}

function placeTabs(windowId: string, layout: "sidebar" | "top", side: "left" | "right" | null, consent: ConsentToken | null) {
  if (side) chooseSidebarSide(side);
  if (tabLayoutOf(store(), windowId) !== layout) switchTabLayout(windowId, consent);
}

export function runBrowserLayoutChoice(windowId: string, choice: string, consent: ConsentToken | null = null): boolean {
  if (!choice.startsWith("layout:") && choice !== "pinnedFold") return false;
  const s = store();
  const w = s.windows[windowId];
  if (!w || w.kind === "small") return true;
  if (runPinnedFold(windowId, choice)) return true;
  if (choice === "layout:sidebarLeft") placeTabs(windowId, "sidebar", "left", consent);
  else if (choice === "layout:sidebarRight") placeTabs(windowId, "sidebar", "right", consent);
  else if (choice === "layout:top") placeTabs(windowId, "top", null, consent);
  else if (choice === "layout:addressToolbar" && !minimalismIn(s, windowId)) s.updateSettings({ addressBar: "toolbar" });
  else if (choice === "layout:addressSidebar" && !minimalismIn(s, windowId)) s.updateSettings({ addressBar: "sidebar" });
  else if (choice === "layout:compactToolbar" && !minimalismIn(s, windowId)) s.updateSettings({ compactToolbar: !s.settings.compactToolbar });
  else if (choice === "layout:autoHide") s.toggleSidebar(windowId);
  else if (choice === "layout:minimalism") s.updateSettings({ minimalismMode: !s.settings.minimalismMode });
  else if (choice === "layout:bookmarksBar" && w.kind !== "private") s.updateSettings({ bookmarksBar: bookmarksBarShownIn(s, windowId) ? "never" : "always" });
  return true;
}

export function sidebarMenuItems(s: BrowserState, windowId: string): MenuItem[] {
  const w = s.windows[windowId];
  return sections(
    [
      { id: "newTab", title: t("New Tab"), symbol: "plus.app", ...menuShortcut("newTab", s) },
      ...(splitViewAvailable
        ? [{ id: "newTabInSplit", title: t("New Tab in Split View"), symbol: "rectangle.split.2x1", enabled: !!activeTabId(s, windowId), ...menuShortcut("openSplitPane", s) }]
        : []),
      { id: "reopen", title: t("Reopen Closed Tab"), symbol: "clock.arrow.circlepath", enabled: !!lastClosedEntry(s, windowId), ...menuShortcut("reopenClosedTab", s) },
    ],
    [
      { id: "newGroup", title: t("New Group"), symbol: "folder.badge.plus" },
      newLiveFolderMenuItem(),
      ...(canAddSharedFolder(w?.profileId) ? [{ id: "addShared", title: t("Add Shared Folder…"), symbol: "person.2" }] : []),
    ],
    [browserLayoutMenuItem(s, windowId)],
    [{ id: "closeAll", title: t("Close All Tabs"), symbol: "xmark", ...menuShortcut("closeAllTabs", s) }],
  );
}

export async function openSidebarMenu(windowId: string) {
  const consent = consentToken();
  const choice = await showMenu(sidebarMenuItems(store(), windowId));
  if (!choice || runNewLiveFolder(windowId, choice) || runBrowserLayoutChoice(windowId, choice, consent)) return;
  const s = store();
  if (choice === "newTab") {
    if (!toggleNewTabBar(windowId)) s.newTab(windowId, { newTabCommand: true });
  } else if (choice === "newTabInSplit") openNewTabInSplit(windowId);
  else if (choice === "reopen") s.reopenClosed(windowId);
  else if (choice === "newGroup") {
    const id = s.newTab(windowId);
    if (id) newGroupWithSelection(windowId, [id]);
  } else if (choice === "addShared") void addSharedFolder(windowId);
  else if (choice === "closeAll") closeAllTabs(windowId, { consent });
}
