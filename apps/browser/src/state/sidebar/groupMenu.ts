import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { closeGroup, moveGroupToProfile, moveGroupToWindow } from "../browser/actions";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, isIncognitoProfile } from "../browser/model";
import { groupOf } from "../pins/tabGrouping";
import { hasOwnGroupIcon } from "../groups/groupIcons";
import type { GroupColor } from "../browser/types";
import { GROUP_COLOR_ORDER, GROUP_COLORS, NEUTRAL_GROUP_SWATCH, NO_GROUP_COLOR_SWATCH, nearestGroupColor } from "../groups/tokens";
import { copyUrls, openIconPicker, startRename } from "./actions";
import { bookmarksShown } from "../bookmarks/visibility";
import { toggleNewTabBar } from "../omnibox/newTabBar";
import { hintWhen, profileItems, sections, windowItems, withAlternate, type Destination } from "./menuParts";
import { confirmRemovingShared } from "../sharedFolders/removal";
import { runSharedFolderChoice, sharedFolderMenuItems } from "../sharedFolders/menu";
import { canSleep, sleepTabsFromMenu } from "../tabs/manualSleep";
import { groupTabIds } from "./groupPanelRows";
import { shownLiveOf } from "../tabs/tabLive";
import { urlParts } from "../../lib/urlParts";
import { isPluginMenuChoice, pluginMenuItems, runPluginMenuChoice, type PluginMenuContext } from "../plugins/menus";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { userClose } from "../tabs/closeActivation";
import type { CloseOptions } from "../tabs/tabs";

type GroupChoice = Destination | { kind: "color"; color: GroupColor | null };

type GroupMenuItem = ChoiceItem<GroupChoice>;

const store = () => useBrowser.getState();

export function groupColorItems(current: GroupColor | null, siteColor: string | null | undefined, matchSite = true): GroupMenuItem[] {
  const matched = siteColor ? nearestGroupColor(siteColor) : null;
  const color = (c: GroupColor | null) => ({ kind: "color" as const, color: c });
  return [
    { value: color("none"), title: "None", swatch: NO_GROUP_COLOR_SWATCH, checked: current === "none" },
    { value: color(null), title: "Neutral", swatch: NEUTRAL_GROUP_SWATCH.light, swatchDark: NEUTRAL_GROUP_SWATCH.dark, checked: !current },
    ...(matchSite ? [{ value: color(matched), title: "Match Site Color", enabled: !!matched, swatch: matched ? GROUP_COLORS[matched].hex : undefined }] : []),
    { separator: true },
    ...GROUP_COLOR_ORDER.map((c) => ({ value: color(c), title: GROUP_COLORS[c].name, swatch: GROUP_COLORS[c].hex, checked: current === c })),
  ];
}

function pluginGroupContext(s: BrowserState, windowId: string, groupId: string): PluginMenuContext {
  const g = s.groups[groupId]!;
  const ids = groupTabIds(s.groups, groupId);
  const active = activeTabId(s, windowId);
  const front = s.tabs[ids.find((id) => id === active) ?? ids[0] ?? ""];
  const parts = front ? urlParts(front.url) : null;
  return {
    when: { urlHost: parts?.host ?? "", urlScheme: parts?.scheme ?? "", isPinned: !!g.pinned, isInGroup: true, isSplit: false, isActive: groupOf(s, active)?.id === groupId, tabCount: ids.length },
    data: { groupId, title: g.name, windowId, tabCount: ids.length },
  };
}

export function groupMenuItems(s: BrowserState, windowId: string, groupId: string): GroupMenuItem[] {
  const g = s.groups[groupId];
  if (!g) return [];
  const siteColor = g.tabIds.map((id) => shownLiveOf(s, id).themeColor).find(Boolean);
  const shown = groupOf(s, activeTabId(s, windowId))?.id === groupId;
  const incognito = isIncognitoProfile(g.profileId);
  return sections<GroupMenuItem>(
    [
      { id: "newTab", title: "New Tab in Group", symbol: "plus.app", ...hintWhen(shown, "newTabInGroup", s) },
      ...withAlternate({ id: "copy", title: "Copy All Links", symbol: "link" }, { id: "copyMd", title: "Copy All Links as Markdown", symbol: "link" }, null),
      { id: "duplicate", title: "Duplicate Group", symbol: "plus.square.on.square" },
    ],
    [
      ...(g.parentId ? [] : [{ id: "pin", title: g.pinned ? "Unpin Group" : "Pin Group", symbol: g.pinned ? "pin.slash" : "pin" }]),
      {
        id: "moveTo",
        title: "Move to",
        symbol: "arrow.up.forward.square",
        children: [
          { id: "moveToProfile", title: "Profile", symbol: "person", enabled: !incognito, children: profileItems(s, (id) => id === g.profileId) },
          ...(g.pinned ? [] : [{ id: "moveToWindow", title: "Window", symbol: "macwindow", enabled: !incognito, children: windowItems(s, windowId) }]),
          ...(bookmarksShown(s.settings) ? [{ id: "bookmarkBar", title: "Bookmarks Bar", symbol: "bookmark" }] : []),
        ],
      },
      {
        id: "customize",
        title: "Customize",
        symbol: "slider.horizontal.3",
        children: [
          { id: "rename", title: "Rename…", symbol: "pencil" },
          { id: "icon", title: hasOwnGroupIcon(g.icon) ? "Change Icon…" : "Add Icon…", symbol: "photo" },
          { id: "color", title: "Color", symbol: "paintpalette", children: groupColorItems(g.color, siteColor) },
          { separator: true },
          { id: "nest", title: "New Nested Group", symbol: "folder.badge.plus" },
        ],
      },
      ...sharedFolderMenuItems(s, groupId),
      ...(incognito ? [] : pluginMenuItems("group", pluginGroupContext(s, windowId, groupId))),
    ],
    [
      { id: "sleep", title: "Sleep Tabs", symbol: "moon.zzz", enabled: groupTabIds(s.groups, groupId).some((id) => canSleep(s, id)) },
      { id: "ungroup", title: "Ungroup", symbol: "folder.badge.minus" },
      ...(PLATFORM_FEATURES.menuAlternates
        ? withAlternate({ id: "close", title: "Close Group", symbol: "xmark" }, { id: "delete", title: "Delete Group", symbol: "trash" }, null)
        : [
            { id: "close", title: "Close Group", symbol: "xmark" },
            { id: "delete", title: "Delete Group", symbol: "trash" },
          ]),
    ],
  );
}

export async function openGroupMenu(windowId: string, groupId: string) {
  const consent = consentToken();
  const choice = await chooseFromMenu(groupMenuItems(store(), windowId, groupId));
  if (!choice) return;
  const removes = typeof choice === "string" ? REMOVES_FOLDER.has(choice) : choice.kind === "profile";
  const closes = choice === "delete" || choice === "bookmarkBar" ? userClose(store().groups[groupId]?.tabIds ?? [], { consent }) : undefined;
  if (removes && !(await confirmRemovingShared(windowId, groupId))) return;
  runGroupChoice(windowId, groupId, choice, consent, closes);
}

const REMOVES_FOLDER = new Set(["pin", "ungroup", "delete", "bookmarkBar"]);

function sendGroup(groupId: string, to: GroupChoice) {
  if (to.kind === "color") store().updateGroup(groupId, { color: to.color });
  else if (to.kind === "profile") void moveGroupToProfile(groupId, to.profileId);
  else if (to.kind === "window") moveGroupToWindow(groupId, to.windowId);
}

function runGroupChoice(windowId: string, groupId: string, choice: string | GroupChoice, consent: ConsentToken | null, closes: CloseOptions | undefined) {
  const s = store();
  const g = s.groups[groupId];
  if (!g || g.windowId !== windowId) return;
  if (typeof choice !== "string") return sendGroup(groupId, choice);
  if (isPluginMenuChoice(choice)) {
    if (!isIncognitoProfile(g.profileId)) void runPluginMenuChoice(choice, windowId, pluginGroupContext(s, windowId, groupId), consent);
    return;
  }
  if (runSharedFolderChoice(windowId, groupId, choice)) return;
  const target = { kind: "group" as const, id: groupId };
  if (choice === "rename") void startRename(windowId, target);
  else if (choice === "icon") void openIconPicker(windowId, target);
  else if (choice === "newTab") {
    if (toggleNewTabBar(windowId, { kind: "group", groupId })) return;
    const id = s.newTabInGroup(groupId);
    if (id) store().activate(id);
  } else if (choice === "nest") {
    const child = s.newNestedGroup(groupId);
    const tabId = store().groups[child]?.tabIds[0];
    if (tabId) store().activate(tabId);
    if (child) void startRename(windowId, { kind: "group", id: child });
  } else if (choice === "pin") s.moveGroup(groupId, { pinned: !g.pinned });
  else if (choice === "duplicate") s.duplicateGroup(groupId);
  else if (choice === "copy") copyUrls(g.tabIds, false);
  else if (choice === "copyMd") copyUrls(g.tabIds, true);
  else if (choice === "ungroup") s.ungroup(groupId);
  else if (choice === "bookmarkBar") s.moveGroupToBookmarksBar(groupId, closes);
  else if (choice === "sleep") void sleepTabsFromMenu(groupTabIds(s.groups, groupId).filter((id) => canSleep(s, id)), "group");
  else if (choice === "close") void closeGroup(groupId, { user: { consent } });
  else if (choice === "delete") s.deleteGroup(groupId, closes);
}
