import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { switchToTab } from "../browser/actions";
import { menuShortcut } from "../commands/commandShortcuts";
import { useBrowser } from "../browser/store";
import { plural, tabTitle, viewTabIds } from "../browser/model";
import { cleanedTabsFor, keptDeletedGroups } from "../pins/closedTabs";
import { openSyncedTab, syncedDevicesMenuItem } from "../sync/menu";
import { setSidebarUi } from "./sidebarUi";
import { cleanUpWithUndo, closeAllTabs, closeDuplicateTabs } from "./clearTabs";
import { hasDuplicateTabs } from "../pins/duplicateTabs";
import { sections, sep } from "./menuParts";
import { clearableRecentlyClosed, closedWindowTitle } from "../windows/recentlyClosedList";
import { consentToken } from "../telemetry/client";

export { openTabMenu } from "./tabMenu";
export { openGroupMenu } from "./groupMenu";
export { openSidebarMenu } from "./sidebarMenu";

const store = () => useBrowser.getState();

type OverflowChoice = { open: string } | { restore: string } | { cleaned: string };

export async function openOverflowMenu(windowId: string, onOpenTabPicked?: () => void) {
  const consent = consentToken();
  const s = store();
  const w = s.windows[windowId];
  if (!w) return;
  const open = viewTabIds(s, windowId).map((id) => s.tabs[id]!);
  const clearable = clearableRecentlyClosed(s, windowId);
  const listed = clearable ?? { tabs: s.closedTabs.filter((c) => c.tab.profileId === w.profileId), windows: [], groups: w.kind === "private" ? s.closedGroups : [] };
  const closed = [
    ...listed.tabs.map((c) => ({ value: { restore: c.id }, title: tabTitle(c.tab), symbol: "clock.arrow.circlepath", at: c.closedAt })),
    ...listed.windows.map((c) => ({ value: { restore: c.id }, title: closedWindowTitle(c), symbol: "macwindow", at: c.closedAt })),
    ...listed.groups.map((c) => ({ value: { restore: c.id }, title: `${c.group.name} (${plural(c.tabs.length, "Tab")})`, symbol: "rectangle.stack", at: c.closedAt })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 15)
    .map(({ at: _, ...item }) => item);
  const allCleaned = cleanedTabsFor(s, windowId);
  const cleaned = [...allCleaned].reverse().slice(0, 20);
  const deleted = keptDeletedGroups(s.deletedGroups)
    .reverse()
    .map((c) => ({ value: { restore: c.id }, title: `${c.group.name} (${plural(c.tabs.length, "Tab")})`, symbol: "trash" }));
  const synced = syncedDevicesMenuItem(w.profileId);
  const history = sections<ChoiceItem<OverflowChoice>>(
    closed,
    [
      cleaned.length > 0 && {
        id: "cleaned",
        title: "Recently Cleaned",
        symbol: "wand.and.stars",
        children: [...cleaned.map((c) => ({ value: { cleaned: c.id }, title: tabTitle(c.tab) })), sep, { id: "restoreAll", title: `Restore ${plural(allCleaned.length, "Tab")}` }],
      },
      deleted.length > 0 && { id: "deleted", title: "Recently Deleted Groups", symbol: "trash", children: deleted },
    ],
    [clearable && closed.length > 0 && { id: "clearClosed", title: "Clear Recently Closed" }],
  );
  const choice = await chooseFromMenu<OverflowChoice, string>([
    { id: "search", title: "Search Tabs…", symbol: "magnifyingglass", ...menuShortcut("searchTabs") },
    sep,
    {
      id: "open",
      title: "Open Tabs",
      symbol: "square.stack",
      enabled: open.length > 0,
      children: open.map((t) => ({ value: { open: t.id }, title: tabTitle(t), checked: w.activeTabIds[w.profileId] === t.id })),
    },
    ...(synced ? [synced] : []),
    { id: "closed", title: "Recently Closed", symbol: "clock.arrow.circlepath", enabled: history.length > 0, children: history.length ? history : [{ id: "none", title: "Empty", enabled: false }] },
    sep,
    { id: "clean", title: "Clean Up Tabs", symbol: "wand.and.stars", ...menuShortcut("cleanUpTabs") },
    { id: "closeDuplicates", title: "Close Duplicate Tabs", symbol: "square.on.square", enabled: hasDuplicateTabs(s, windowId), ...menuShortcut("closeDuplicateTabs") },
    { id: "closeAll", title: "Close All Tabs", symbol: "xmark", ...menuShortcut("closeAllTabs") },
  ]);
  if (!choice) return;
  if (typeof choice !== "string") {
    if ("open" in choice) {
      onOpenTabPicked?.();
      switchToTab(choice.open);
    }
    else if ("restore" in choice) s.restoreClosed(choice.restore, windowId);
    else s.restoreCleaned(choice.cleaned, windowId);
  } else if (choice === "search") setSidebarUi({ searchTabs: windowId });
  else if (openSyncedTab(choice, windowId, w.profileId)) return;
  else if (choice === "restoreAll") s.restoreCleaned(undefined, windowId);
  else if (choice === "clearClosed") s.clearRecentlyClosed(windowId);
  else if (choice === "clean") cleanUpWithUndo(windowId);
  else if (choice === "closeDuplicates") closeDuplicateTabs(windowId, { consent });
  else if (choice === "closeAll") closeAllTabs(windowId, { consent });
}
