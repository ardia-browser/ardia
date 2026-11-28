import type { MenuItem } from "../../platform/menus";
import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { closeTab, moveTabsToProfile, moveTabToWindow, toggleMute, toggleSiteMute } from "../browser/actions";
import { muteState, muteSymbol, muteTitle, siteMuteTitle } from "../tabs/mute";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, bookmarkProfileId, inPinnedContainer, isIncognitoProfile, pinnedSectionTitle, pinSection, tabTitle, togglePinTitle, viewTabIds, tabLayoutOf } from "../browser/model";
import { awayFromPin, selectedTabIds } from "../pins/organize";
import { reopensAtPinnedUrl } from "../pins/pinHomes";
import { groupOf } from "../pins/tabGrouping";
import { splitOf, splitRowPanes, splitViewAvailable } from "../splits/splits";
import { closeSplitView, openSplitPane } from "../splits/actions";
import type { Tab } from "../browser/types";
import { bookmarkTabs, copyUrls, editPinnedPage, newGroupWithSelection, openIconPicker, startRename, toggleBookmarkInWindow } from "./actions";
import { isCalendarUrl } from "../live/meetings";
import { bookmarkTab } from "../bookmarks/actions";
import { isBookmarked } from "../bookmarks/bookmarks";
import { exitPictureInPicture, useMedia } from "../media/media";
import { noteTabMenuPinnedReset } from "../telemetry/hoverCardCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { bookmarksShown } from "../bookmarks/visibility";
import { calendarMenuItem, dismissNowMenuItems, runCalendarMenu } from "./liveMenus";
import { newFolderWithTab, removeFromFolder } from "./tileFolderUi";
import { togglePageEngine } from "../engines/actions";
import { ENGINE_NAMES, otherEngine, switchableEngine, tabEngine } from "../engines/engines";
import { groupItems, hintWhen, profileItems, sections, windowItems, withAlternate, type Destination } from "./menuParts";
import { openMultiMenu } from "./multiTabMenu";
import { tileFolderOf } from "../pins/tileFolders";
import { sendTabFromMenu, sendTabMenuItem } from "../sync/menu";
import { pageUnread } from "../tabs/unread";
import { closeIntent, openPages } from "../tabs/tabs";
import { notePinnedReopenChoiceChanged, noteTopAppUnloadedFromMenu } from "../telemetry/tabSleepCounts";
import { canSleep, sleepTabsFromMenu } from "../tabs/manualSleep";
import { isPluginMenuChoice, pluginMenuItems, runPluginMenuChoice, type PluginMenuContext } from "../plugins/menus";
import { urlParts } from "../../lib/urlParts";
import { ALL_UNREAD_TITLE, canChooseSiteUnread, isUnreadSiteHidden, showUnreadCounts, toggleSiteUnread, unreadSiteTitle } from "../tabs/unreadSites";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { userClose } from "../tabs/closeActivation";
import { openTileLetters, setTileLetters, showsTileLetters } from "../pins/tileLetters";

const store = () => useBrowser.getState();

function tabMenuFacts(s: BrowserState, windowId: string, tab: Tab) {
  const list = viewTabIds(s, windowId).filter((id) => !inPinnedContainer(s, id));
  const housed = inPinnedContainer(s, tab.id);
  const index = list.indexOf(tab.id);
  const split = splitOf(s, tab.id);
  return {
    housed,
    memberPin: housed && !tab.pin,
    section: pinSection(tab),
    above: housed || index < 0 ? [] : list.slice(0, index),
    below: housed || index < 0 ? [] : list.slice(index + 1),
    others: housed ? [] : list.filter((id) => id !== tab.id),
    group: groupOf(s, tab.id),
    split,
    splitRow: splitRowPanes(s, split).includes(tab.id),
    incognito: isIncognitoProfile(tab.profileId),
    across: tabLayoutOf(s, windowId) === "top",
    active: activeTabId(s, windowId) === tab.id,
  };
}

type Facts = ReturnType<typeof tabMenuFacts>;

function pinItems(s: BrowserState, tab: Tab, f: Facts): MenuItem[] {
  const reset: MenuItem[] = f.housed && awayFromPin(tab) ? [{ id: "backToPin", title: "Reset Pinned Tab", symbol: "arrow.uturn.backward", ...hintWhen(f.active, "returnToPinnedUrl", s) }] : [];
  if (f.memberPin) return [{ id: "unpinMember", title: "Unpin", symbol: "pin.slash" }, ...reset];
  if (f.section === "none") return f.splitRow ? [] : [{ id: "pinRow", title: "Pin Tab", symbol: "pin", ...hintWhen(f.active, "togglePinnedRow", s) }];
  return [{ id: "pin", title: togglePinTitle(tab), symbol: "pin.slash", ...(f.section === "row" ? hintWhen(f.active, "togglePinnedRow", s) : {}) }, ...reset];
}

function splitItems(s: BrowserState, f: Facts): MenuItem[] {
  if (f.split) return [{ id: "unsplit", title: "Remove from Split View", symbol: "rectangle.split.2x1.slash" }];
  if (f.section === "tile" || !splitViewAvailable) return [];
  return [{ id: "split", title: "Open in Split View", symbol: "rectangle.split.2x1", ...hintWhen(f.active, "openSplitPane", s) }];
}

function quickItems(s: BrowserState, tab: Tab, f: Facts): MenuItem[] {
  return [
    ...withAlternate(
      { id: "copy", title: "Copy Link", symbol: "link", enabled: !!tab.url },
      { id: "copyMd", title: "Copy Link as Markdown", symbol: "link", enabled: !!tab.url },
      f.active ? ["copyUrl", "copyUrlAsMarkdown"] : null,
      s,
    ),
    { id: "duplicate", title: "Duplicate", symbol: "plus.square.on.square" },
    ...splitItems(s, f),
    ...muteItems(s, tab),
    ...pictureInPictureItems(tab),
  ];
}

function calendarItems(tab: Tab): MenuItem[] {
  if (!tab.pin || !isCalendarUrl(tab.pinnedUrl ?? tab.url)) return [];
  return [...(pinSection(tab) === "tile" ? dismissNowMenuItems() : []), calendarMenuItem()];
}

type TabMenuItem = ChoiceItem<Destination>;

function groupingItems(s: BrowserState, windowId: string, tab: Tab, f: Facts): TabMenuItem[] {
  if (f.section === "tile") {
    if (tileFolderOf(tab)) return [{ id: "leaveFolder", title: "Remove from Folder", symbol: "folder.badge.minus" }];
    return s.settings.topAppFolders ? [{ id: "newFolder", title: "New Folder…", symbol: "folder.badge.plus" }] : [];
  }
  const groups = groupItems(s, windowId, f.group?.id);
  return [
    ...(f.memberPin
      ? []
      : f.group
        ? [{ id: "ungroupTab", title: "Remove from Group", symbol: "folder.badge.minus" }]
        : [{ id: "newGroup", title: "New Group", symbol: "folder.badge.plus", ...hintWhen(f.active, "newGroupWithTabs", s) }]),
    ...(groups.length ? [{ id: "moveToGroup", title: "Group", symbol: "folder", children: groups }] : []),
  ];
}

function moveToItem(s: BrowserState, windowId: string, tab: Tab, f: Facts): TabMenuItem {
  const place: TabMenuItem[] =
    f.memberPin || f.splitRow
      ? []
      : f.section === "tile"
        ? [{ id: "pinRow", title: pinnedSectionTitle(s, tab), symbol: "pin" }]
        : [{ id: "pinTile", title: "Top Apps", symbol: "square.grid.2x2" }];
  return {
    id: "moveTo",
    title: "Move to",
    symbol: "arrow.up.forward.square",
    children: sections<TabMenuItem>(place, groupingItems(s, windowId, tab, f), [
      { id: "moveToProfile", title: "Profile", symbol: "person", enabled: !f.incognito, children: profileItems(s, (id) => id === tab.profileId) },
      { id: "moveToWindow", title: "Window", symbol: "macwindow", enabled: !f.incognito, children: windowItems(s, windowId) },
    ]),
  };
}

function pictureInPictureItems(tab: Tab): MenuItem[] {
  return useMedia.getState().pipOpen[tab.id] ? [{ id: "exitPip", title: "Exit Picture in Picture", symbol: "pip.exit" }] : [];
}

function bookmarkItems(s: BrowserState, windowId: string, tab: Tab, f: Facts): MenuItem[] {
  if (!bookmarksShown(s.settings)) return [];
  const saved = !!tab.url && isBookmarked(s, bookmarkProfileId(s, s.windows[windowId]), tab.url);
  if (!saved) return [{ id: "bookmark", title: "Bookmark Tab…", symbol: "bookmark", enabled: !!tab.url, ...hintWhen(f.active, "bookmarkPage", s) }];
  const edit: MenuItem = { id: "bookmark", title: "Edit Bookmark…", symbol: "bookmark.fill" };
  const remove: MenuItem = { id: "unbookmark", title: "Remove Bookmark", symbol: "minus.circle" };
  return PLATFORM_FEATURES.menuAlternates ? withAlternate(edit, remove, null) : [edit, remove];
}

function muteItems(s: BrowserState, tab: Tab): MenuItem[] {
  if (!tab.url) return [];
  const state = muteState(s, tab);
  const mute: MenuItem = { id: "mute", title: muteTitle(state), symbol: muteSymbol(state) };
  if (state === "site") return [mute];
  return withAlternate(mute, { id: "muteSite", title: siteMuteTitle(state), symbol: muteSymbol(null) }, null);
}

function unreadItems(s: BrowserState, tab: Tab): MenuItem[] {
  if (!canChooseSiteUnread(tab)) return [];
  if (pinSection(tab) === "tile" && !s.settings.showTopAppBadges) return [];
  if (!s.settings.showUnreadCounts) return pageUnread(tab.id) ? [{ id: "allUnread", title: ALL_UNREAD_TITLE, symbol: "app.badge" }] : [];
  const hidden = isUnreadSiteHidden(s.settings, tab.url);
  if (!hidden && !pageUnread(tab.id)) return [];
  return [{ id: "siteUnread", title: unreadSiteTitle(hidden), symbol: "app.badge" }];
}

function customizeItem(s: BrowserState, tab: Tab, f: Facts): MenuItem {
  const engine = switchableEngine(s, tab.url) ? ENGINE_NAMES[otherEngine(tabEngine(s, tab.id))] : null;
  return {
    id: "customize",
    title: "Customize",
    symbol: "slider.horizontal.3",
    children: sections(
      [
        { id: "rename", title: "Rename…", symbol: "pencil" },
        ...(tab.customTitle ? [{ id: "resetName", title: "Reset Name", symbol: "arrow.counterclockwise" }] : []),
        { id: "icon", title: "Change Icon…", symbol: "photo" },
        ...(tab.customIcon ? [{ id: "resetIcon", title: "Reset Icon", symbol: "arrow.counterclockwise" }] : []),
        ...(showsTileLetters(s, tab) ? [{ id: "letters", title: "Change Letters…", symbol: "textformat" }] : []),
        ...(showsTileLetters(s, tab) && tab.tileLetters ? [{ id: "resetLetters", title: "Reset Letters", symbol: "arrow.counterclockwise" }] : []),
      ],
      f.housed
        ? [
            { id: "replacePin", title: "Replace Pinned URL with Current", symbol: "pin", enabled: awayFromPin(tab) },
            { id: "editPin", title: "Edit Pinned URL…", symbol: "link" },
            { id: "reopenAtPin", title: "Reopen at Pinned URL", symbol: "arrow.uturn.backward", checked: reopensAtPinnedUrl(s.settings, tab) },
          ]
        : [],
      [...(engine ? [{ id: "engine", title: `Open in ${engine}`, symbol: "globe" }] : []), ...unreadItems(s, tab)],
    ),
  };
}

function unloadTopApp(tabId: string, consent: ConsentToken | null) {
  const s = store();
  noteTopAppUnloadedFromMenu();
  const ids = closeIntent(s, tabId).ids;
  s.closeTabs(ids, userClose(ids, { consent }, { keepTopApps: false }));
}

function sleepItems(s: BrowserState, tab: Tab, f: Facts): MenuItem[] {
  if (f.housed && f.section === "tile" && s.settings.keepTopAppsRunning && openPages(s, tab.id).length > 0) return [{ id: "unloadTopApp", title: "Unload", symbol: "moon.zzz" }];
  return canSleep(s, tab.id) ? [{ id: "sleep", title: "Sleep Tab", symbol: "moon.zzz" }] : [];
}

function closeItems(f: Facts): MenuItem[] {
  if (f.housed) return [];
  return [
    { id: "close", title: "Close Tab", symbol: "xmark", ...hintWhen(f.active, "closeTab") },
    {
      id: "closeTabs",
      title: "Close Tabs",
      symbol: "xmark.square",
      children: sections(
        [
          { id: "closeOthers", title: "Close Other Tabs", enabled: f.others.length > 0 },
          { id: "closeBelow", title: f.across ? "Close Tabs to the Right" : "Close Tabs Below", enabled: f.below.length > 0 },
          { id: "closeAbove", title: f.across ? "Close Tabs to the Left" : "Close Tabs Above", enabled: f.above.length > 0 },
        ],
        f.split ? [{ id: "closeSplit", title: "Close Split View" }] : [],
      ),
    },
  ];
}

function sendItems(tab: Tab, f: Facts): MenuItem[] {
  const send = f.incognito ? null : sendTabMenuItem(tab);
  return send ? [send] : [];
}

function pluginMenuContext(s: BrowserState, windowId: string, tab: Tab, f: Facts): PluginMenuContext {
  const parts = urlParts(tab.url);
  return {
    when: { urlHost: parts?.host ?? "", urlScheme: parts?.scheme ?? "", isPinned: !!tab.pin, isInGroup: !!f.group, isSplit: !!f.split, isActive: f.active, tabCount: viewTabIds(s, windowId).length },
    data: { url: tab.url, title: tabTitle(tab), tabId: tab.id, windowId },
  };
}

const pluginItems = (s: BrowserState, windowId: string, tab: Tab, f: Facts): MenuItem[] => (f.incognito ? [] : pluginMenuItems("tab", pluginMenuContext(s, windowId, tab, f)));

export function tabMenuItems(s: BrowserState, windowId: string, tab: Tab, f: Facts = tabMenuFacts(s, windowId, tab)): TabMenuItem[] {
  return sections<TabMenuItem>(
    quickItems(s, tab, f),
    [...pinItems(s, tab, f), moveToItem(s, windowId, tab, f), ...bookmarkItems(s, windowId, tab, f), ...sendItems(tab, f), ...calendarItems(tab)],
    pluginItems(s, windowId, tab, f),
    [customizeItem(s, tab, f), ...sleepItems(s, tab, f)],
    closeItems(f),
  );
}

export async function openTabMenu(windowId: string, tab: Tab) {
  const s = store();
  const selected = selectedTabIds(s, windowId);
  if (selected.length > 1 && selected.includes(tab.id)) return openMultiMenu(windowId, selected);
  if (s.selection[windowId]?.length) s.setSelection(windowId, []);
  const f = tabMenuFacts(store(), windowId, tab);
  const consent = consentToken();
  const choice = await chooseFromMenu(tabMenuItems(store(), windowId, tab, f));
  const now = store().tabs[tab.id];
  if (!choice || now?.windowId !== windowId) return;
  const here = (ids: string[]) => ids.filter((id) => store().tabs[id]?.windowId === windowId);
  runTabChoice(windowId, now, { ...f, others: here(f.others), above: here(f.above), below: here(f.below) }, choice, consent);
}

function openAsSplit(windowId: string, tabId: string, wasActive: boolean) {
  const front = activeTabId(store(), windowId);
  if (wasActive || front === tabId) openSplitPane(windowId, { anchorTabId: tabId });
  else if (front) openSplitPane(windowId, { tabId, anchorTabId: front, side: "right" });
}

function sendTab(windowId: string, tabId: string, to: Destination) {
  if (to.kind === "group") store().placeTabs([tabId], { pinned: false, groupId: to.groupId });
  else if (to.kind === "profile") void moveTabsToProfile([tabId], to.profileId);
  else if (to.kind === "window") moveTabToWindow(tabId, to.windowId);
  else void bookmarkTabs(windowId, [tabId], to);
}

function runTabChoice(windowId: string, tab: Tab, f: Facts, choice: string | Destination, consent: ConsentToken | null) {
  if (typeof choice !== "string") return sendTab(windowId, tab.id, choice);
  const s = store();
  if (isPluginMenuChoice(choice)) {
    if (!f.incognito) void runPluginMenuChoice(choice, windowId, pluginMenuContext(s, windowId, tab, f), consent);
    return;
  }
  const t = { kind: "tab" as const, id: tab.id };
  if (runCalendarMenu(choice) || sendTabFromMenu(choice, tab)) return;
  if (choice === "backToPin") {
    noteTabMenuPinnedReset();
    s.returnToPinnedUrl(tab.id);
  } else if (choice === "unbookmark") toggleBookmarkInWindow(windowId, { url: tab.url, title: tabTitle(tab), favicon: tab.favicon });
  else if (choice === "exitPip") exitPictureInPicture(tab.id);
  else if (choice === "replacePin") s.setPinnedUrl(tab.id);
  else if (choice === "editPin") void editPinnedPage(windowId, tab.id);
  else if (choice === "reopenAtPin") {
    s.updateTab(tab.id, { reopenAtPinnedUrl: !reopensAtPinnedUrl(s.settings, tab) });
    notePinnedReopenChoiceChanged(consent);
  }
  else if (choice === "rename") void startRename(windowId, t);
  else if (choice === "resetName") s.updateTab(tab.id, { customTitle: null });
  else if (choice === "icon") void openIconPicker(windowId, t);
  else if (choice === "resetIcon") s.updateTab(tab.id, { customIcon: null });
  else if (choice === "letters") void openTileLetters(windowId, tab.id);
  else if (choice === "resetLetters") setTileLetters(tab.id, null, consent);
  else if (choice === "pin") s.togglePin(tab.id);
  else if (choice === "unpinMember") s.placeTabs([tab.id], { pinned: false, groupId: null });
  else if (choice === "pinTile") s.pinTabs([tab.id], true, false);
  else if (choice === "pinRow") s.pinTabs([tab.id], true, true);
  else if (choice === "split") openAsSplit(windowId, tab.id, f.active);
  else if (choice === "newFolder") newFolderWithTab(windowId, tab.id);
  else if (choice === "leaveFolder") removeFromFolder(tab.id);
  else if (choice === "duplicate") s.duplicateTab(tab.id);
  else if (choice === "ungroupTab") s.removeTabsFromGroup([tab.id]);
  else if (choice === "newGroup") newGroupWithSelection(windowId, [tab.id]);
  else if (choice === "unsplit") s.removeTabFromSplit(tab.id);
  else if (choice === "mute") toggleMute(tab.id);
  else if (choice === "muteSite") toggleSiteMute(tab.id);
  else if (choice === "siteUnread") toggleSiteUnread(tab.id);
  else if (choice === "allUnread") showUnreadCounts(true);
  else if (choice === "engine") void togglePageEngine(tab.id);
  else if (choice === "copy") copyUrls([tab.id], false);
  else if (choice === "copyMd") copyUrls([tab.id], true);
  else if (choice === "bookmark") bookmarkTab(windowId, tab.id);
  else if (choice === "close") void closeTab(tab.id, { user: { consent } });
  else if (choice === "unloadTopApp") unloadTopApp(tab.id, consent);
  else if (choice === "sleep") void sleepTabsFromMenu([tab.id], "tab");
  else if (choice === "closeSplit" && f.split) closeSplitView(f.split.id, { consent });
  else if (choice === "closeOthers") s.closeTabs(f.others, userClose(f.others, { consent }));
  else if (choice === "closeAbove") s.closeTabs(f.above, userClose(f.above, { consent }));
  else if (choice === "closeBelow") s.closeTabs(f.below, userClose(f.below, { consent }));
}
