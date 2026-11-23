import { showMenu, type MenuItem } from "../../platform/menus";
import { showToast } from "../app/toasts";
import { closeTab } from "../browser/actions";
import { menuShortcut } from "../commands/commandShortcuts";
import { withOptionAlternate } from "../app/menuSections";
import { storeAction, useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { isStacked, MAX_SPLIT_PANES, type OpenPaneOptions, splitOf, type SplitSide, splitTabIds, splitTabIdsOf } from "./splits";
import { paneNeighbor, type SplitDirection } from "./reorder";
import { splitLane, type SplitLane, splitsOnRow } from "./lanes";
import type { AdoptId } from "../browser/types";
import { noteSplit } from "../telemetry/usage";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteHorizontalSplitOpen, noteSplitDrop, noteSplitPaneDragCancel, noteSplitPaneMove } from "../telemetry/splitReorderCounts";
import { reorderTick } from "../drag/reorderTick";
import { returnFocusToPage } from "../sidebar/actions";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { userClose, type ByUser } from "../tabs/closeActivation";

const store = () => useBrowser.getState();

const maxedOut = (windowId: string) =>
  showToast(windowId, "Cannot Add New Pane", `Split View can show up to ${MAX_SPLIT_PANES} tabs at once.`);

export function openSplitPane(windowId: string, options: OpenPaneOptions = {}): string | null {
  const result = store().openSplitPane(windowId, options);
  if (!result.ok && result.reason === "unavailable") return options.url ? openAsTab(windowId, options) : null;
  if (!result.ok) {
    if (result.reason === "max") maxedOut(windowId);
    return null;
  }
  return result.tabId;
}

export function focusSplitPane(windowId: string, delta: 1 | -1) {
  const before = activeTabId(store(), windowId);
  store().focusPane(windowId, delta);
  if (activeTabId(store(), windowId) !== before) returnFocusToPage(windowId);
}

export function openHorizontalSplitPane(windowId: string, options: Omit<OpenPaneOptions, "side"> = {}, consent?: ConsentToken | null): string | null {
  const opened = openSplitPane(windowId, { ...options, side: "bottom" });
  if (opened) noteHorizontalSplitOpen(consent);
  return opened;
}

export function moveSplitPane(windowId: string, direction: SplitDirection, consent?: ConsentToken | null): boolean {
  const active = activeTabId(store(), windowId);
  if (!active || !store().movePaneDirection(active, direction)) return false;
  reorderTick();
  noteSplit("splitPaneKeyMoves", consent);
  noteSplitPaneMove("keyboard", consent);
  returnFocusToPage(windowId);
  return true;
}

export function moveActiveSplitPane(windowId: string, delta: 1 | -1, consent?: ConsentToken | null): boolean {
  return moveSplitPane(windowId, delta < 0 ? "left" : "right", consent);
}

export function swapSplitPanes(a: string, b: string, viaOrConsent?: "drag" | "menu" | ConsentToken | null): boolean {
  if (!store().swapPanes(a, b)) return false;
  const via: "drag" | "menu" = viaOrConsent === "menu" ? "menu" : "drag";
  const consent: ConsentToken | null | undefined = viaOrConsent === "drag" || viaOrConsent === "menu" ? undefined : viaOrConsent;
  if (via === "drag") {
    reorderTick();
    noteSplit("splitPaneDragMoves", consent);
  }
  noteSplitPaneMove(via, consent);
  return true;
}

export function cancelSplitPaneDrag(splitId: string, tabIds: string[]) {
  store().setSplitPaneOrder(splitId, tabIds);
  noteSplitPaneDragCancel();
}

function openAsTab(windowId: string, { url, adoptId, anchorTabId, background }: OpenPaneOptions): string | null {
  const anchor = anchorTabId ? store().tabs[anchorTabId] : undefined;
  if (!store().windows[windowId]) return null;
  return store().newTab(windowId, { url, adoptId, background, openerId: anchor?.id, profileId: anchor?.profileId, gated: true });
}

export const openNewTabInSplit = (windowId: string) => openSplitPane(windowId);

export function openInSplit(tabId: string, side: SplitSide = "right") {
  const tab = store().tabs[tabId];
  if (!tab) return;
  const active = activeTabId(store(), tab.windowId);
  if (!active || active === tabId) return;
  openSplitPane(tab.windowId, { tabId, anchorTabId: active, side });
}

export function openLinkInSplit(sourceTabId: string, url: string, adoptId?: AdoptId) {
  const s = store();
  const source = s.tabs[sourceTabId];
  if (!source) return;
  const split = splitOf(s, sourceTabId);
  const panes = splitTabIdsOf(split);
  const next = panes?.[panes.indexOf(sourceTabId) + 1];
  const target = panes && (next || panes.length >= MAX_SPLIT_PANES) ? (next ?? panes.at(-1)) : undefined;
  const inPlaceOf = target !== sourceTabId ? target : undefined;
  openSplitPane(source.windowId, { anchorTabId: sourceTabId, url, side: "right", background: true, adoptId, inPlaceOf });
}

export function dropTabIntoSplit(tabId: string, targetTabId: string, side: SplitSide): string | null {
  const target = store().tabs[targetTabId];
  if (!target || tabId === targetTabId) return null;
  const opened = openSplitPane(target.windowId, { tabId, anchorTabId: targetTabId, side });
  if (opened) noteSplitDrop(side);
  return opened;
}

type RowSplitDrop = { adopted: SplitLane | null };

export function dropTabOnRow(tabId: string, rowTabId: string, side: "left" | "right"): RowSplitDrop | null {
  const s = store();
  const tab = s.tabs[tabId];
  const row = s.tabs[rowTabId];
  if (!tab || !row || !splitsOnRow(s, tabId, rowTabId)) return null;
  const split = splitOf(s, rowTabId);
  const panes = splitTabIdsOf(split);
  if (panes?.includes(tabId)) return null;
  const rowPanes = panes?.filter((id) => s.tabs[id] && splitLane(s.tabs[id]!) === splitLane(row));
  const anchor = rowPanes?.length ? (side === "left" ? rowPanes[0]! : rowPanes.at(-1)!) : rowTabId;
  const stacked = split?.orientation === "vertical";
  if (!dropTabIntoSplit(tabId, anchor, stacked ? (side === "left" ? "top" : "bottom") : side)) return null;
  const now = store().tabs[tabId];
  return { adopted: now && splitLane(now) !== splitLane(tab) ? splitLane(now) : null };
}

function closePane(tabId: string, user: ByUser) {
  void closeTab(tabId, { user });
}

export const pressClosePane = (tabId: string) => closePane(tabId, { consent: consentToken() });

export function closeSplitView(splitId: string, user: ByUser) {
  const split = store().splits[splitId];
  if (!split) return;
  noteSplit("splitViewCloses");
  store().closeTabs(splitTabIds(split), userClose(splitTabIds(split), user));
}

function splitMenuItems(tabId: string): MenuItem[] {
  const s = store();
  const split = splitOf(s, tabId);
  if (!split || !s.tabs[tabId]) return [];
  const horizontal = split.orientation === "horizontal";
  const full = splitTabIds(split).length >= MAX_SPLIT_PANES;
  const stacked = isStacked(split, tabId);
  const hasStack = split.slots.some((slot) => "stack" in slot);
  const canMove = {
    left: !!paneNeighbor(split, tabId, "left"),
    right: !!paneNeighbor(split, tabId, "right"),
    up: !!paneNeighbor(split, tabId, "up"),
    down: !!paneNeighbor(split, tabId, "down"),
  };
  const moveHorizontal: MenuItem[] = [
    { id: "moveLeft", title: "Move Pane Left", symbol: "rectangle.lefthalf.inset.filled.arrow.left", enabled: canMove.left, ...menuShortcut("movePaneLeft") },
    { id: "moveRight", title: "Move Pane Right", symbol: "rectangle.righthalf.inset.filled.arrow.right", enabled: canMove.right, ...menuShortcut("movePaneRight") },
  ];
  const moveVertical: MenuItem[] = [
    { id: "moveUp", title: "Move Pane Up", symbol: "arrow.up", enabled: canMove.up, ...menuShortcut("movePaneUp") },
    { id: "moveDown", title: "Move Pane Down", symbol: "arrow.down", enabled: canMove.down, ...menuShortcut("movePaneDown") },
  ];
  const moveItems = hasStack ? [...moveHorizontal, ...moveVertical] : horizontal ? moveHorizontal : moveVertical;
  return [
    { id: "add", title: horizontal ? "Add Vertical Split View" : "Add Horizontal Split View", symbol: horizontal ? "rectangle.split.2x1" : "rectangle.split.1x2", enabled: !full, ...menuShortcut(horizontal ? "openSplitPane" : "openHorizontalSplitPane") },
    { id: "bottom", title: horizontal ? "Add Bottom Split" : "Add Right Split", symbol: horizontal ? "rectangle.bottomhalf.inset.filled" : "rectangle.righthalf.inset.filled", enabled: !full && !stacked, ...menuShortcut(horizontal ? "openHorizontalSplitPane" : "openSplitPane") },
    { separator: true },
    {
      id: "arrange",
      title: "Arrange",
      symbol: "arrow.left.arrow.right",
      children: [
        ...moveItems,
        { id: "flip", title: "Flip Split View", symbol: horizontal ? "arrow.left.arrow.right" : "arrow.up.arrow.down" },
        { id: "convert", title: horizontal ? "Convert to Horizontal Split View" : "Convert to Vertical Split View", symbol: horizontal ? "rectangle.split.1x2" : "rectangle.split.2x1" },
      ],
    },
    ...(PLATFORM_FEATURES.menuAlternates
      ? withOptionAlternate({ id: "remove", title: "Remove from Split View", symbol: "rectangle.portrait.and.arrow.right" }, { id: "separate", title: "Separate All Tabs", symbol: "rectangle.split.3x1" })
      : [
          { id: "remove", title: "Remove from Split View", symbol: "rectangle.portrait.and.arrow.right" },
          { id: "separate", title: "Separate All Tabs", symbol: "rectangle.split.3x1" },
        ]),
    { separator: true },
    { id: "close", title: "Close Pane", symbol: "xmark" },
    { id: "closeSplit", title: "Close Split View", symbol: "xmark.square" },
  ];
}

export async function showSplitMenu(tabId: string) {
  const consent = consentToken();
  const s = store();
  const split = splitOf(s, tabId);
  const tab = s.tabs[tabId];
  if (!split || !tab) return;
  const horizontal = split.orientation === "horizontal";
  const choice = await showMenu(splitMenuItems(tabId));
  const st = store();
  switch (choice) {
    case "add":
      return void (horizontal ? openSplitPane(tab.windowId, { anchorTabId: tabId, side: "right" }) : openHorizontalSplitPane(tab.windowId, { anchorTabId: tabId }, consent));
    case "bottom":
      return void (horizontal ? openHorizontalSplitPane(tab.windowId, { anchorTabId: tabId }, consent) : openSplitPane(tab.windowId, { anchorTabId: tabId, side: "right" }));
    case "moveLeft":
      return void (st.movePaneDirection(tabId, "left") && noteSplitPaneMove("menu", consent));
    case "moveRight":
      return void (st.movePaneDirection(tabId, "right") && noteSplitPaneMove("menu", consent));
    case "moveUp":
      return void (st.movePaneDirection(tabId, "up") && noteSplitPaneMove("menu", consent));
    case "moveDown":
      return void (st.movePaneDirection(tabId, "down") && noteSplitPaneMove("menu", consent));
    case "flip":
      return st.flipSplit(split.id);
    case "convert":
      return st.toggleSplitOrientation(split.id);
    case "remove":
      return st.removeTabFromSplit(tabId);
    case "separate":
      return st.separateSplit(split.id);
    case "close":
      return closePane(tabId, { consent });
    case "closeSplit":
      return closeSplitView(split.id, { consent });
  }
}

export const updateSplit = storeAction("updateSplit");
export const replaceSplitPane = storeAction("replaceSplitPane");
export const removeTabFromSplit = storeAction("removeTabFromSplit");
