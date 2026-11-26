import { setSwitcherCapture, switcherPointerMoved } from "../../platform/focus";
import { useBrowser } from "../browser/store";
import { activeTabId, viewTabIds } from "../browser/model";
import { sessionTabIds } from "../pins/tabCleanup";
import { tabEngine } from "../engines/engines";
import { isAsleep } from "../tabs/pageSession";
import { useLifecycle } from "../tabs/sleepingTabs";
import { inOrderTabIds, isSwitchableTab, stepFrom, steppedTabId } from "../tabs/switchOrder";
import { rememberPicture } from "../tabs/tabPictures";
import { noteTabSwitcherOpened } from "../telemetry/usage";
import { closeTab } from "../browser/actions";
import { noteTabSwitcherMode, noteTabSwitcherOpenedInWebKit, noteTabSwitcherQuickSwitch, noteTabSwitcherRowClosed, noteTabSwitcherShown } from "../telemetry/tabSwitcherOpens";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { isWindowClosing } from "../windows/closingWindows";
import { setSidebarUi, sidebarUi } from "./sidebarUi";

const MOUNT_AFTER_MS = 70;
export const SHOW_AFTER_MS = 140;
const SESSION_START = Date.now();
const POINTER_POLL_MS = 50;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let mountTimer: ReturnType<typeof setTimeout> | undefined;
let pointerTimer: ReturnType<typeof setInterval> | undefined;
let hoveredRow: number | null = null;
let keyboardMoves = 0;
let pointerStale = false;
let openedWith: ConsentToken | null = null;

export function switcherStep(windowId: string, backward: boolean) {
  const current = sidebarUi().switcher;
  if (current && current.windowId === windowId) return moveSwitcher(backward ? -1 : 1);
  const s = useBrowser.getState();
  const { tabSwitcherOrder: order, tabSwitcherView: view } = s.settings;
  const delta = backward ? -1 : 1;
  const consent = consentToken();
  if (order === "inOrder" && view === "none") {
    const next = steppedTabId(s, windowId, delta);
    if (!next) return;
    noteTabSwitcherMode(order, view, consent);
    return s.activate(next);
  }
  const ids = order === "recent" ? sessionTabIds(s, windowId, SESSION_START) : inOrderTabIds(s, windowId);
  const from = activeTabId(s, windowId);
  if (ids.length === 1 && ids[0] !== from) {
    noteTabSwitcherMode(order, view, consent);
    return s.activate(ids[0]!);
  }
  if (ids.length < 2) return;
  noteTabSwitcherOpened(viewTabIds(s, windowId).filter((id) => isAsleep(s.tabs[id])).length, ids.slice(0, 2).filter((id) => s.tabs[id]!.unseen).length);
  noteTabSwitcherMode(order, view, consent);
  if (from && view === "thumbnails") void rememberPicture(from);
  if (from && tabEngine(s, from) === "webkit") noteTabSwitcherOpenedInWebKit();
  openedWith = consent;
  const index = order === "recent" ? (backward ? ids.length - 1 : 1) : stepFrom(ids, from, delta);
  setSidebarUi({ switcher: { windowId, ids, index, view, mounted: false, visible: false } });
  void setSwitcherCapture(true);
  clearTimeout(mountTimer);
  clearTimeout(showTimer);
  if (view === "none") return;
  mountTimer = setTimeout(mountSwitcher, MOUNT_AFTER_MS);
  showTimer = setTimeout(() => {
    const s = sidebarUi().switcher;
    if (!s) return;
    setSidebarUi({ switcher: { ...s, mounted: true, visible: true } });
    noteTabSwitcherShown(s.view, openedWith);
    if (hoveredRow !== null && !pointerStale) watchPointer();
  }, SHOW_AFTER_MS);
}

function mountSwitcher() {
  clearTimeout(mountTimer);
  const s = sidebarUi().switcher;
  if (s && !s.mounted && s.view !== "none") setSidebarUi({ switcher: { ...s, mounted: true } });
}

function syncSwitcherTabs(windowId: string, state = useBrowser.getState()) {
  const s = sidebarUi().switcher;
  if (!s || s.windowId !== windowId) return;
  const inWindow = new Set(viewTabIds(state, windowId));
  const ids = s.ids.filter((id) => inWindow.has(id) && isSwitchableTab(state, id));
  if (ids.length === s.ids.length) return;
  if (!ids.length) return endSwitcher();
  const selected = s.ids[s.index];
  const selectedIndex = selected ? ids.indexOf(selected) : -1;
  stopPointerWatch();
  hoveredRow = null;
  pointerStale = false;
  keyboardMoves++;
  setSidebarUi({ switcher: { ...s, ids, index: selectedIndex >= 0 ? selectedIndex : Math.min(s.index, ids.length - 1) } });
}

export function subscribeSwitcherTabChanges(windowId: string) {
  syncSwitcherTabs(windowId);
  const unsubscribeBrowser = useBrowser.subscribe((state, previous) => {
    if (state.tabs !== previous.tabs || state.windows !== previous.windows || state.groups !== previous.groups || state.splits !== previous.splits) syncSwitcherTabs(windowId, state);
  });
  const unsubscribeLifecycle = useLifecycle.subscribe((state, previous) => {
    if (state.discarded !== previous.discarded) syncSwitcherTabs(windowId);
  });
  return () => {
    unsubscribeBrowser();
    unsubscribeLifecycle();
  };
}

export function moveSwitcher(step: 1 | -1) {
  const s = sidebarUi().switcher;
  if (!s) return;
  mountSwitcher();
  focusSwitcherRow(s.index + step);
  stopPointerWatch();
  pointerStale = true;
  const move = ++keyboardMoves;
  void setSwitcherCapture(true).then(() => {
    if (move !== keyboardMoves || !sidebarUi().switcher) return;
    pointerStale = false;
    if (hoveredRow !== null) watchPointer();
  });
}

function focusSwitcherRow(index: number) {
  const s = sidebarUi().switcher;
  if (!s) return;
  const n = s.ids.length;
  setSidebarUi({ switcher: { ...s, index: (index + n) % n } });
}

export function hoverSwitcherRow(index: number) {
  hoveredRow = index;
  if (pointerStale || !sidebarUi().switcher?.visible) return;
  if (switcherPointerMoved()) {
    stopPointerWatch();
    return focusSwitcherRow(index);
  }
  watchPointer();
}

function watchPointer() {
  pointerTimer ??= setInterval(() => {
    if (!sidebarUi().switcher || hoveredRow === null) return stopPointerWatch();
    if (!switcherPointerMoved()) return;
    const row = hoveredRow;
    stopPointerWatch();
    focusSwitcherRow(row);
  }, POINTER_POLL_MS);
}

export function leaveSwitcherRow(index: number) {
  if (hoveredRow === index) hoveredRow = null;
}

function stopPointerWatch() {
  clearInterval(pointerTimer);
  pointerTimer = undefined;
}

function pointedRow(s: NonNullable<ReturnType<typeof sidebarUi>["switcher"]>) {
  return s.visible && !pointerStale && hoveredRow !== null && hoveredRow < s.ids.length && switcherPointerMoved() ? hoveredRow : null;
}

export async function closeSwitcherRow() {
  const s = sidebarUi().switcher;
  if (!s || !s.visible) return;
  const id = s.ids[pointedRow(s) ?? s.index];
  if (!id) return;
  const consent = consentToken();
  await closeTab(id, { user: { consent } });
  syncSwitcherTabs(s.windowId);
  if (!sidebarUi().switcher?.ids.includes(id) || isWindowClosing(s.windowId)) noteTabSwitcherRowClosed(consent);
}

export function commitSwitcher(index?: number) {
  const s = sidebarUi().switcher;
  if (!s) return;
  const pointed = pointedRow(s);
  endSwitcher();
  const id = s.ids[index ?? pointed ?? s.index];
  const state = useBrowser.getState();
  if (!id || !viewTabIds(state, s.windowId).includes(id) || !isSwitchableTab(state, id)) return;
  if (!s.visible && s.view !== "none") noteTabSwitcherQuickSwitch(openedWith);
  if (id !== activeTabId(state, s.windowId)) state.activate(id);
}

export function cancelSwitcher() {
  if (sidebarUi().switcher) endSwitcher();
}

function endSwitcher() {
  clearTimeout(mountTimer);
  clearTimeout(showTimer);
  stopPointerWatch();
  hoveredRow = null;
  pointerStale = false;
  keyboardMoves++;
  void setSwitcherCapture(false);
  setSidebarUi({ switcher: null });
}
