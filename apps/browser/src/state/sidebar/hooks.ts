import { useShallow } from "zustand/react/shallow";
import { useBrowser } from "../browser/store";
import { activeTabId, isPinnedRow, tabTitle } from "../browser/model";
import { liveTabOpen, stackMembers } from "../live/rows";
import { useLive } from "../live/store";
import { liveFolderKeep, liveFolderShowsExtra, liveItemTab, liveKeptTabs, liveStrays } from "./liveRows";
import type { FolderRow } from "../live/rows";
import type { Tab } from "../browser/types";
import { awayFromPin } from "../pins/organize";
import { groupLabel } from "../pins/tabGrouping";
import { offersTidyTabs } from "../pins/tidy";
import { folderIn } from "../pins/tileFolders";
import { ownIcon } from "../pins/rowIcons";
import { useStoreWhile } from "../tabs/tabWatch";
import { splitRowPanes } from "../splits/splits";
import { downloadsIn } from "../downloads/downloadsSlice";
import { groupEntries, keptEntries, showsExtraTabs, sidebarEntries } from "./entries";
import { groupTabIds } from "./groupPanelRows";
import { capture, type Capture } from "./listCapture";
import { pinnedCollapsed, pinnedKept } from "./pinnedFold";
import { useSidebarUi, type Hover } from "./sidebarUi";
import { useShownSidebarWidth } from "./shownWidth";

export function useSidebarWidth(windowId: string): number {
  const shown = useShownSidebarWidth(windowId);
  const dragging = useSidebarUi((u) => u.dragWidth[windowId]);
  return dragging ?? shown;
}

export const useDragGhostLabel = (folderName: string | undefined, groupId: string | undefined, tab: Tab | undefined) =>
  useBrowser((s) => folderName ?? (groupId && s.groups[groupId] ? groupLabel(s, s.groups[groupId]!) : tab ? tabTitle(tab) : ""));

const NO_TABS: string[] = [];

export const useSplitRowPanes = (splitId: string) => useBrowser(useShallow((s) => splitRowPanes(s, s.splits[splitId])));

export const useGroupTabIds = (groupId: string) => useBrowser(useShallow((s) => s.groups[groupId]?.tabIds ?? NO_TABS));

export const useIconPickerCurrent = (kind: "tab" | "group" | "live" | "folder", id: string, liveIcon: string | null | undefined) =>
  useBrowser((s) => (kind === "tab" ? ownIcon(s.tabs[id]) : kind === "live" ? liveIcon : s.groups[id]?.icon) ?? null);


export const useIsPinnedRow = (kind: "tab" | "group" | "live" | "folder", id: string) => useBrowser((s) => kind === "tab" && isPinnedRow(s.tabs[id]));

export const useCapturedGroupEntries = (groupId: string, captured: Capture) =>
  useBrowser(
    useShallow((s) => {
      const list = groupEntries(s, groupId);
      return capture(captured, s, list, list);
    }),
  );

export const useCapturedSidebarEntries = (windowId: string, profileId: string, captured: Capture) =>
  useBrowser((s) => {
    const entries = sidebarEntries(s, windowId, profileId);
    return capture(captured, s, entries.list, entries);
  });

export const useKeptEntries = (windowId: string, profileId: string, groupId: string) => useBrowser(useShallow((s) => keptEntries(s, windowId, profileId, groupId)));

export const useShowsExtraTabs = (windowId: string, profileId: string, groupId: string) => useBrowser((s) => showsExtraTabs(s, windowId, profileId, groupId));

export const usePinnedCollapsed = (profileId: string) => useBrowser((s) => pinnedCollapsed(s, profileId));

export const usePinnedKept = (windowId: string, profileId: string, entries: string[]) => useBrowser((s) => pinnedKept(s, windowId, profileId, entries));

export const useHasDownloads = (windowId: string) => useBrowser((s) => downloadsIn(s, windowId).length > 0);

export const useNoTiles = (windowId: string, profileId: string) => useBrowser((s) => sidebarEntries(s, windowId, profileId).tiles.length === 0);

const NO_CELLS: string[] = [];

export const useSidebarCells = (windowId: string, profileId: string, offScreen: boolean) =>
  useBrowser((s) => (offScreen ? NO_CELLS : sidebarEntries(s, windowId, profileId).cells));

export const useOffersTidyTabs = (windowId: string, profileId: string, skip: boolean) => useBrowser((s) => !skip && offersTidyTabs(s, windowId, profileId));

export const useShownTabId = (windowId: string) => useBrowser((s) => activeTabId(s, windowId));

export const useIsShownTab = (windowId: string, tabId: string) => useBrowser((s) => activeTabId(s, windowId) === tabId);

export const useHoverOrphaned = (windowId: string, hover: Hover | null) =>
  useStoreWhile(
    useBrowser,
    !!hover,
    (s) => (hover?.kind === "tab" && !s.tabs[hover.id]) || (hover?.kind === "group" && !s.groups[hover.id]) || (hover?.kind === "folder" && !folderIn(s, windowId, hover.id)),
  );

export const useGroupPanelTabIds = (groupId: string) => useBrowser(useShallow((s) => groupTabIds(s.groups, groupId)));

export const useTabsById = (ids: string[]) => useBrowser(useShallow((s) => ids.map((id) => s.tabs[id])));

export const useClosedTabs = () => useBrowser((s) => s.closedTabs);

export const useClosedGroups = () => useBrowser((s) => s.closedGroups);

export const useLiveStrays = (windowId: string, profileId: string, folderId: string, itemIds: Set<string>, hiddenIds: Set<string>) =>
  useBrowser(useShallow((s) => liveStrays(s, windowId, profileId, folderId, itemIds, hiddenIds)));

export function useLiveFolderKeep(windowId: string, profileId: string, folderId: string, collapsed: boolean, rows: FolderRow[], strays: string[], itemIds: Set<string>, hiddenIds: Set<string>) {
  const shown = useLive((l) => l.shownTabs[folderId] ?? NO_TABS);
  const kept = useBrowser(useShallow((s) => (collapsed ? liveKeptTabs(s, windowId, profileId, folderId, shown, itemIds, hiddenIds) : NO_TABS)));
  const keep = useBrowser(useShallow((s) => (kept.length ? liveFolderKeep(rows, strays, kept, s.tabs) : NO_TABS)));
  const showsExtra = useBrowser((s) => liveFolderShowsExtra(rows, strays, kept, activeTabId(s, windowId, profileId), s.tabs));
  return { keep, showsExtra };
}

export const useLiveItemTab = (windowId: string, profileId: string, folderId: string, itemId: string) => useBrowser((s) => liveItemTab(s, windowId, profileId, folderId, itemId));

export const useLiveTabOpen = (folderId: string, itemIds: string[]) => useBrowser((s) => liveTabOpen(s.tabs, folderId, itemIds));

export function useStackTabOpen(folderId: string, stackId: string) {
  const ids = useLive(useShallow((s) => stackMembers(s.items[folderId] ?? [], stackId).map((it) => it.id)));
  return useLiveTabOpen(folderId, ids);
}

export const useIsActiveIn = (windowId: string, profileId: string, tabId: string | null) => useBrowser((s) => !!tabId && activeTabId(s, windowId, profileId) === tabId);

export const useTabAwayFromPin = (tabId: string | null) => useBrowser((s) => { const tab = tabId ? s.tabs[tabId] : undefined; return !!tab && awayFromPin(tab); });


export const sidebarListLengthNow = (windowId: string, profileId: string) => sidebarEntries(useBrowser.getState(), windowId, profileId).list.length;
