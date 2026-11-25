import { setSwitcherCapture, switcherPointerMoved } from "../../platform/focus";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { sessionTabIds, switcherTabIds, type TabSwitcherScope } from "../pins/recentTabs";
import { tabEngine } from "../engines/engines";
import { isAsleep } from "../tabs/pageSession";
import { useLifecycle } from "../tabs/sleepingTabs";
import { inOrderTabIds, isSwitchableTab, stepFrom, steppedTabId } from "../tabs/switchOrder";
import { rememberPicture } from "../tabs/tabPictures";
import { noteTabSwitcherOpened } from "../telemetry/usage";
import { closeTab } from "../browser/actions";
import { noteCrossProfileSwitcher, noteTabSwitcherMode, noteTabSwitcherOpenedInWebKit, noteTabSwitcherQuickSwitch, noteTabSwitcherRowClosed, noteTabSwitcherShown } from "../telemetry/tabSwitcherOpens";
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

type Switcher = NonNullable<ReturnType<typeof sidebarUi>["switcher"]>;

const scopeFor = (s: BrowserState, windowId: string): TabSwitcherScope =>
  s.windows[windowId]?.kind === "main" && s.settings.tabSwitcherOrder === "recent" ? s.settings.tabSwitcherScope : "currentProfile";

const scopes = ["currentProfile", "sharedData", "allProfiles"] as const;

function sessionScope(state: BrowserState, session: Switcher): TabSwitcherScope {
  const current = scopeFor(state, session.windowId);
  return scopes.indexOf(current) < scopes.indexOf(session.scope) ? current : session.scope;
}

export function switcherStep(windowId: string, backward: boolean, consent: ConsentToken | null = null) {
  const current = sidebarUi().switcher;
  if (current && current.windowId === windowId) return moveSwitcher(backward ? -1 : 1);
  const s = useBrowser.getState();
  const window = s.windows[windowId];
  if (!window) return;
  const { tabSwitcherOrder: order, tabSwitcherView: view } = s.settings;
  const delta = backward ? -1 : 1;
  if (order === "inOrder" && view === "none") {
    const next = steppedTabId(s, windowId, delta);
    if (!next) return;
    if (current) endSwitcher();
    noteTabSwitcherMode(order, view, consent);
    return s.activate(next);
  }
  const scope = scopeFor(s, windowId);
  const ids = order === "recent" ? sessionTabIds(s, windowId, SESSION_START, scope) : inOrderTabIds(s, windowId);
  const from = activeTabId(s, windowId);
  if (ids.length === 1 && ids[0] !== from) {
    if (current) endSwitcher();
    noteTabSwitcherMode(order, view, consent);
    return s.activate(ids[0]!);
  }
  if (ids.length < 2) return;
  if (current) endSwitcher();
  const scopeIds = switcherTabIds(s, windowId, scope);
  noteTabSwitcherOpened(scopeIds.filter((id) => isAsleep(s.tabs[id])).length, ids.slice(0, 2).filter((id) => s.tabs[id]!.unseen).length);
  noteTabSwitcherMode(order, view, consent);
  if (scope === "allProfiles") noteCrossProfileSwitcher("open", consent);
  if (from && view === "thumbnails") void rememberPicture(from);
  if (from && tabEngine(s, from) === "webkit") noteTabSwitcherOpenedInWebKit();
  const index = order === "recent" ? (backward ? ids.length - 1 : 1) : stepFrom(ids, from, delta);
  setSidebarUi({ switcher: { windowId, profileId: window.profileId, scope, consent, ids, index, view, mounted: false, visible: false } });
  void setSwitcherCapture(true);
  clearTimeout(mountTimer);
  clearTimeout(showTimer);
  if (view === "none") return;
  mountTimer = setTimeout(mountSwitcher, MOUNT_AFTER_MS);
  showTimer = setTimeout(() => {
    const s = sidebarUi().switcher;
    if (!s) return;
    setSidebarUi({ switcher: { ...s, mounted: true, visible: true } });
    noteTabSwitcherShown(s.view, s.consent);
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
  const profileId = state.windows[windowId]?.profileId;
  const scope = sessionScope(state, s);
  if (!profileId || (scope !== "allProfiles" && profileId !== s.profileId)) return endSwitcher();
  const inScope = new Set(switcherTabIds(state, windowId, scope));
  const ids = s.ids.filter((id) => inScope.has(id) && isSwitchableTab(state, id));
  if (ids.length === s.ids.length && scope === s.scope) return;
  if (!ids.length) return endSwitcher();
  const retained = new Set(ids);
  const selected = s.ids.slice(s.index).find((id) => retained.has(id)) ?? ids[0]!;
  stopPointerWatch();
  hoveredRow = null;
  pointerStale = false;
  keyboardMoves++;
  setSidebarUi({ switcher: { ...s, scope, ids, index: ids.indexOf(selected) } });
}

export function subscribeSwitcherTabChanges(windowId: string) {
  syncSwitcherTabs(windowId);
  const unsubscribeBrowser = useBrowser.subscribe((state, previous) => {
    if (state.tabs !== previous.tabs || state.windows !== previous.windows || state.profiles !== previous.profiles ||
      state.groups !== previous.groups || state.splits !== previous.splits ||
      state.settings.shareTabsAcrossWindows !== previous.settings.shareTabsAcrossWindows ||
      state.settings.tabSwitcherOrder !== previous.settings.tabSwitcherOrder ||
      state.settings.tabSwitcherScope !== previous.settings.tabSwitcherScope) syncSwitcherTabs(windowId, state);
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

function pointedRow(s: Switcher) {
  return s.visible && !pointerStale && hoveredRow !== null && hoveredRow < s.ids.length && switcherPointerMoved() ? hoveredRow : null;
}

function validChoice(state: BrowserState, s: Switcher, id: string): boolean {
  const scope = sessionScope(state, s);
  return (scope === "allProfiles" || state.windows[s.windowId]?.profileId === s.profileId)
    && s.ids.includes(id) && switcherTabIds(state, s.windowId, scope).includes(id) && isSwitchableTab(state, id);
}

export async function closeSwitcherRow() {
  const s = sidebarUi().switcher;
  if (!s || !s.visible) return;
  const id = s.ids[pointedRow(s) ?? s.index];
  if (!id || !validChoice(useBrowser.getState(), s, id)) return;
  const consent = consentToken();
  await closeTab(id, { user: { consent } });
  const after = useBrowser.getState();
  syncSwitcherTabs(s.windowId, after);
  const tab = after.tabs[id];
  if (!tab || isWindowClosing(s.windowId) || (tab.windowId === s.windowId && !isSwitchableTab(after, id))) noteTabSwitcherRowClosed(consent);
}

export function commitSwitcher(tabId?: string) {
  const s = sidebarUi().switcher;
  if (!s) return;
  const pointed = pointedRow(s);
  endSwitcher();
  const id = tabId ?? s.ids[pointed ?? s.index];
  const state = useBrowser.getState();
  if (!id || !validChoice(state, s, id)) return;
  if (!s.visible && s.view !== "none") noteTabSwitcherQuickSwitch(s.consent);
  if (id === activeTabId(state, s.windowId)) return;
  const crossProfile = state.tabs[id]!.profileId !== state.windows[s.windowId]!.profileId;
  state.activate(id);
  if (crossProfile && activeTabId(useBrowser.getState(), s.windowId) === id) noteCrossProfileSwitcher("commit", s.consent);
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
