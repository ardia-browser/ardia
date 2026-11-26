import type { BrowserCommand } from "../../platform/commands";
import type { MenuEntry } from "../../platform/menus";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, isPinnedRow, pinSection, plural, tabLayoutOf } from "../browser/model";
import { groupIndex } from "../browser/structure";
import { live } from "../live/store";
import { recentlyClosedIn } from "../windows/recentlyClosedList";
import { awayFromPin, selectedTabIds } from "../pins/organize";
import { groupOf } from "../pins/tabGrouping";
import { newGroupWithSelection, openIconPicker, startRename } from "./actions";
import { cleanUpWithUndo, closeAllTabs, closeDuplicateTabs } from "./clearTabs";
import { toggleNewTabBar } from "../omnibox/newTabBar";
import { hiddenEmptyCard, newTabOpensBar } from "../omnibox/newTabBarPolicy";
import { movePinnedTitle, togglePinnedRows } from "./movePinned";
import { PINNED_FOLD_TITLES, pinnedCollapsed, togglePinnedFold } from "./pinnedFold";
import { setSidebarUi } from "./sidebarUi";
import { tidy } from "./tidyUi";
import { sortTabs } from "./sortTabsUi";
import { variantArg } from "../commands/commandCatalog";
import { switcherStep } from "./switcher";
import type { ByUser } from "../tabs/closeActivation";

function hasCollapsiblePinned(s: BrowserState, w: BrowserState["windows"][string] | undefined): boolean {
  if (!w || !s.profiles[w.profileId] || tabLayoutOf(s, w.id) !== "sidebar") return false;
  if (w.kind !== "private" && live().folderOrder.some((id) => live().folders[id]?.profileId === w.profileId)) return true;
  const rootGroups = groupIndex(s.groups);
  const hideEmpty = newTabOpensBar(s);
  for (const id of w.tabIds) {
    const t = s.tabs[id];
    if (!t || t.profileId !== w.profileId) continue;
    if (isPinnedRow(t)) return true;
    if (!t.pin && rootGroups.get(id)?.pinned && !t.liveItem && (!hideEmpty || !hiddenEmptyCard(s, t))) return true;
  }
  return false;
}

export function runSidebarCommand(command: BrowserCommand, arg: string | null, windowId: string, user?: ByUser): boolean {
  const s = useBrowser.getState();
  const tabId = activeTabId(s, windowId);
  switch (command) {
    case "newTabInGroup": {
      const group = groupOf(s, tabId);
      if (toggleNewTabBar(windowId, group ? { kind: "group", groupId: group.id } : undefined)) return true;
      const id = group ? s.newTabInGroup(group.id) : s.newTab(windowId, { newTabCommand: true });
      if (id) useBrowser.getState().activate(id);
      return true;
    }
    case "newGroupWithTabs":
      newGroupWithSelection(windowId);
      return true;
    case "cleanUpTabs":
      cleanUpWithUndo(windowId);
      return true;
    case "closeAllTabs":
      closeAllTabs(windowId, user);
      return true;
    case "closeDuplicateTabs":
      closeDuplicateTabs(windowId, user);
      return true;
    case "tidyPins":
      tidy(windowId, "pins");
      return true;
    case "sortTabs": {
      const key = variantArg("sortTabs", arg);
      if (key) sortTabs({ windowId }, key);
      return true;
    }
    case "searchTabs":
      setSidebarUi({ searchTabs: windowId, hover: null });
      return true;
    case "renameTab":
      if (tabId) void startRename(windowId, { kind: "tab", id: tabId });
      return true;
    case "changeTabIcon":
      if (tabId) void openIconPicker(windowId, { kind: "tab", id: tabId });
      return true;
    case "togglePinnedRow":
      togglePinnedRows(windowId);
      return true;
    case "returnToPinnedUrl":
      if (tabId) s.returnToPinnedUrl(tabId);
      return true;
    case "tabSwitcher":
      switcherStep(windowId, arg === "backward");
      return true;
    case "togglePinnedFold": {
      const w = s.windows[windowId];
      if (hasCollapsiblePinned(s, w)) togglePinnedFold(w!.profileId);
      return true;
    }
  }
  return false;
}

export function sidebarMenuState(s: BrowserState, windowId: string | undefined) {
  const disabled: string[] = [];
  const titles: Record<string, string> = {};
  const tab = windowId ? s.tabs[activeTabId(s, windowId) ?? ""] : undefined;
  if (windowId) {
    if (!tab || !awayFromPin(tab)) disabled.push("returnToPinnedUrl");
    titles.togglePinnedRow = movePinnedTitle(s, tab);
    const selected = selectedTabIds(s, windowId);
    const forGroup = selected.filter((id) => pinSection(s.tabs[id]) !== "tile");
    if (!forGroup.length) disabled.push("newGroupWithTabs");
    if (forGroup.length > 1) titles.newGroupWithTabs = `New Group with ${plural(forGroup.length, "Tab")}`;
    const bar = s.windowUi[windowId]?.panel;
    if (selected.length > 1 && !bar?.open && !bar?.newTab) titles.closeTab = `Close ${plural(selected.length, "Tab")}`;
  }
  const w = windowId ? s.windows[windowId] : undefined;
  if (!hasCollapsiblePinned(s, w)) disabled.push("togglePinnedFold");
  else if (w && pinnedCollapsed(s, w.profileId)) titles.togglePinnedFold = PINNED_FOLD_TITLES.expand;
  const recentlyClosedGroups: MenuEntry[] = recentlyClosedIn(s, w)
    .groups.reverse()
    .slice(0, 10)
    .map((c) => ({ id: c.id, title: `${c.group.name} (${plural(c.tabs.length, "Tab")})` }));
  return { disabled, titles, recentlyClosedGroups };
}
