import type { BrowserCommand } from "../../platform/commands";
import type { MenuEntry } from "../../platform/menus";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, pinSection, plural } from "../browser/model";
import { recentlyClosedIn } from "../windows/recentlyClosedList";
import { awayFromPin, selectedTabIds } from "../pins/organize";
import { groupOf } from "../pins/tabGrouping";
import { newGroupWithSelection, openIconPicker, startRename } from "./actions";
import { cleanUpWithUndo, closeAllTabs } from "./clearTabs";
import { toggleNewTabBar } from "../omnibox/newTabBar";
import { movePinnedTitle, togglePinnedRows } from "./movePinned";
import { showToast } from "../app/toasts";
import { notePinToast } from "../telemetry/usage";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { setSidebarUi } from "./sidebarUi";
import { tidy } from "./tidyUi";
import { switcherStep } from "./switcher";

export function runSidebarCommand(command: BrowserCommand, arg: string | null, windowId: string): boolean {
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
      closeAllTabs(windowId);
      return true;
    case "tidyPins":
      tidy(windowId, "pins");
      return true;
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
      showPinToast(windowId, s, consentToken());
      return true;
    case "returnToPinnedUrl":
      if (tabId) s.returnToPinnedUrl(tabId);
      return true;
    case "tabSwitcher":
      switcherStep(windowId, arg === "backward");
      return true;
  }
  return false;
}

export function showPinToast(windowId: string, before: BrowserState, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  const changed = Object.values(before.tabs).filter((t) => t.windowId === windowId && s.tabs[t.id] && !t.pin !== !s.tabs[t.id]!.pin);
  const first = changed[0];
  if (!first) return;
  const pinned = !!s.tabs[first.id]!.pin;
  const tabs = changed.length === 1 ? "Tab" : plural(changed.length, "Tab");
  const space = s.profiles[first.profileId]?.name ?? "Profile";
  showToast(windowId, pinned ? `Pinned ${tabs} to "${space}"` : `Un-Pinned ${tabs} from "${space}"`, undefined, { icon: pinned ? "pin" : "pin.slash" });
  notePinToast(consent);
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
  const recentlyClosedGroups: MenuEntry[] = recentlyClosedIn(s, w)
    .groups.reverse()
    .slice(0, 10)
    .map((c) => ({ id: c.id, title: `${c.group.name} (${plural(c.tabs.length, "Tab")})` }));
  return { disabled, titles, recentlyClosedGroups };
}
