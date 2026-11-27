import { showMenu, type MenuItem } from "../../platform/menus";
import { showToast } from "../app/toasts";
import { closeTab } from "../browser/actions";
import { menuShortcut } from "../commands/commandShortcuts";
import { withOptionAlternate } from "../app/menuSections";
import { storeAction, useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { MAX_SPLIT_PANES, type OpenPaneOptions, splitOf, type SplitSide, splitTabIds, splitTabIdsOf } from "./splits";
import { canInsertPane, paneNeighbor, type PaneDirection } from "./layout";
import { splitLane, type SplitLane, splitsOnRow } from "./lanes";
import type { AdoptId, SplitView } from "../browser/types";
import { noteSplit } from "../telemetry/usage";
import { returnFocusToPage } from "../sidebar/actions";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { userClose, type ByUser } from "../tabs/closeActivation";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { reorderTick } from "../drag/reorderTick";
import type { BrowserCommand } from "../../platform/commands";

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

export function openSplitPaneBelow(windowId: string, options: Omit<OpenPaneOptions, "side"> = {}, consent?: ConsentToken | null): string | null {
  const tabId = openSplitPane(windowId, { ...options, side: "bottom" });
  if (tabId) noteSplit("splitBelowOpens", consent);
  return tabId;
}

type PaneMoveVia = "drag" | "menu" | "key";

const PANE_MOVE_COUNTS = { drag: "splitPaneDragSwaps", menu: "splitPaneMenuMoves", key: "splitPaneKeyMoves" } as const;

function notePaneMove(via: PaneMoveVia, consent: ConsentToken | null | undefined) {
  noteSplit(PANE_MOVE_COUNTS[via], consent);
  if (via === "drag") reorderTick();
}

function movePaneBy(tabId: string, direction: PaneDirection, via: Exclude<PaneMoveVia, "drag">, consent: ConsentToken | null | undefined): boolean {
  if (!store().movePane(tabId, direction)) return false;
  notePaneMove(via, consent);
  return true;
}

export function moveSplitPane(windowId: string, direction: PaneDirection, consent?: ConsentToken | null): boolean {
  const active = activeTabId(store(), windowId);
  if (!active || !movePaneBy(active, direction, "key", consent)) return false;
  returnFocusToPage(windowId);
  return true;
}

export function swapSplitPanes(a: string, b: string, via: PaneMoveVia, consent?: ConsentToken | null): boolean {
  if (!store().swapPanes(a, b)) return false;
  notePaneMove(via, consent);
  return true;
}

export function focusSplitPane(windowId: string, delta: 1 | -1) {
  const before = activeTabId(store(), windowId);
  store().focusPane(windowId, delta);
  if (activeTabId(store(), windowId) !== before) returnFocusToPage(windowId);
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
  return openSplitPane(target.windowId, { tabId, anchorTabId: targetTabId, side });
}

export function dropTabOnPane(tabId: string, targetTabId: string, side: SplitSide, consent?: ConsentToken | null): string | null {
  const before = splitOf(store(), targetTabId);
  const redock = !!splitTabIdsOf(before)?.includes(tabId);
  const dropped = dropTabIntoSplit(tabId, targetTabId, side);
  if (dropped && redock) {
    if (splitOf(store(), targetTabId) !== before) noteSplit("splitPaneDragRedocks", consent);
  } else if (dropped && (side === "top" || side === "bottom")) noteSplit("splitStackedDrops", consent);
  return dropped;
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

export function movesIntoSplitPane(paneTabId: string, tabId: string): boolean {
  const s = store();
  const split = splitOf(s, paneTabId);
  const pane = s.tabs[paneTabId];
  const tab = s.tabs[tabId];
  return !!split && !!pane && !!tab && !splitTabIds(split).includes(tabId) && tab.windowId === pane.windowId && tab.profileId === pane.profileId;
}

export function closeEmptySplitPaneOnEscape(tabId: string): boolean {
  const consent = consentToken();
  const windowId = store().tabs[tabId]?.windowId;
  if (!windowId || !store().removeEmptySplitPane(tabId)) return false;
  noteSplit("splitEmptyPaneEscapeCloses", consent);
  returnFocusToPage(windowId);
  return true;
}

export function closeSplitView(splitId: string, user: ByUser) {
  const split = store().splits[splitId];
  if (!split) return;
  noteSplit("splitViewCloses");
  store().closeTabs(splitTabIds(split), userClose(splitTabIds(split), user));
}

export const SPLIT_PANE_MOVES = { moveSplitPaneLeft: "left", moveSplitPaneRight: "right", moveSplitPaneUp: "up", moveSplitPaneDown: "down" } as const satisfies Partial<Record<BrowserCommand, PaneDirection>>;

const PANE_MOVES = [
  { command: "moveSplitPaneLeft", id: "moveLeft", title: "Move Pane Left", symbol: "rectangle.lefthalf.inset.filled.arrow.left" },
  { command: "moveSplitPaneRight", id: "moveRight", title: "Move Pane Right", symbol: "rectangle.righthalf.inset.filled.arrow.right" },
  { command: "moveSplitPaneUp", id: "moveUp", title: "Move Pane Up", symbol: "arrow.up" },
  { command: "moveSplitPaneDown", id: "moveDown", title: "Move Pane Down", symbol: "arrow.down" },
] as const;

function paneMoveItems(split: SplitView, tabId: string): MenuItem[] {
  const sideBySide = split.orientation === "horizontal" || split.slots.some((slot) => "stack" in slot);
  const stacked = split.orientation === "vertical" || split.slots.some((slot) => "stack" in slot);
  return PANE_MOVES.filter(({ command }) => (SPLIT_PANE_MOVES[command] === "left" || SPLIT_PANE_MOVES[command] === "right" ? sideBySide : stacked)).map(({ command, id, title, symbol }) => ({
    id,
    title,
    symbol,
    enabled: !!paneNeighbor(split, tabId, SPLIT_PANE_MOVES[command]),
    ...menuShortcut(command),
  }));
}

function splitMenuItems(tabId: string): MenuItem[] {
  const s = store();
  const split = splitOf(s, tabId);
  if (!split || !s.tabs[tabId]) return [];
  const horizontal = split.orientation === "horizontal";
  return [
    { id: "addRight", title: "Add Right Split", symbol: "rectangle.righthalf.inset.filled", enabled: canInsertPane(split, tabId, "right"), ...menuShortcut("openSplitPane") },
    { id: "addBottom", title: "Add Bottom Split", symbol: "rectangle.bottomhalf.inset.filled", enabled: canInsertPane(split, tabId, "bottom"), ...menuShortcut("openSplitPaneBelow") },
    { separator: true },
    {
      id: "arrange",
      title: "Arrange",
      symbol: "arrow.left.arrow.right",
      children: [
        ...paneMoveItems(split, tabId),
        { id: "flip", title: "Flip Split View", symbol: horizontal ? "arrow.left.arrow.right" : "arrow.up.arrow.down" },
        { id: "convert", title: horizontal ? "Convert to Vertical Split View" : "Convert to Horizontal Split View", symbol: horizontal ? "rectangle.split.1x2" : "rectangle.split.2x1" },
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
  const choice = await showMenu(splitMenuItems(tabId));
  const move = PANE_MOVES.find((m) => m.id === choice);
  if (move) return void movePaneBy(tabId, SPLIT_PANE_MOVES[move.command], "menu", consent);
  const st = store();
  switch (choice) {
    case "addRight":
      return void openSplitPane(tab.windowId, { anchorTabId: tabId, side: "right" });
    case "addBottom":
      return void openSplitPaneBelow(tab.windowId, { anchorTabId: tabId }, consent);
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
