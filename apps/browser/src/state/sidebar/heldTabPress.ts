import { AppState, type GestureResponderEvent } from "react-native";
import { modifiersOf } from "../../lib/keys";
import { activeTabId, familyKeyOf } from "../browser/model";
import { claimPress, pressLeftTabBehind, switchingByPress } from "../tabs/tabReveal";
import { useBrowser } from "../browser/store";
import { holderOfPage, isAsleep } from "../tabs/pageSession";
import { isSleeping } from "../tabs/sleepingTabs";
import { webviewMount } from "../../platform/webviews";
import type { TabPage } from "../browser/types";
import { focusedWindowOf } from "../windows/ui";
import { clickTab } from "./actions";
import { dismissHover } from "./hover";
import {
  notePressAnswered,
  notePressEnded,
  notePressOutAnswered,
  notePressOutUnanswered,
  notePressStarted,
  noteRowPress,
  settleUnansweredPressOut,
  type TabPressDrift,
  type TabPressDrop,
} from "../telemetry/tabPresses";

export const TAB_CLICK_SLOP = 10;

export const devTabPress = { switchOnPress: true };

export type TabPress = {
  windowId: string;
  tabId: string;
  startedAt: number | undefined;
  switched: boolean;
  nativePress: number;
  at: { x: number; y: number } | null;
  windowKey: boolean;
  answered: boolean;
  out: boolean;
  drift: TabPressDrift;
  plain: boolean;
  wasShown: boolean;
  heldAt: number;
  dragged: boolean;
  page: PageInstance;
  pin: string;
};

type PageInstance = { state: TabPage | undefined; mount: object | undefined };

export type TileDoubleClick = (wasShown: boolean) => void;

export const DOUBLE_CLICK_MS = 500;

let lastPlainClick: { press: TabPress; endedAt: number; shown: boolean } | null = null;

const near = (a: TabPress["at"], b: TabPress["at"]) => !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) < TAB_CLICK_SLOP;

const pairable = (press: TabPress | null, release: GestureResponderEvent): press is TabPress =>
  !!press && press.plain && !press.dragged && !!press.at && !!pointOf(release) && plainPress(release);

function secondOfPair(press: TabPress | null, release: GestureResponderEvent): { wasShown: boolean } | null {
  const last = lastPlainClick;
  if (!pairable(press, release)) {
    lastPlainClick = null;
    return null;
  }
  lastPlainClick = { press, endedAt: performance.now(), shown: press.wasShown && shownAndAwake(press.windowId, press.tabId) };
  if (!last || last.press === press) return null;
  const paired = last.press.windowId === press.windowId && last.press.pin === press.pin && press.heldAt - last.endedAt < DOUBLE_CLICK_MS && near(last.press.at, press.at);
  if (!paired) return null;
  lastPlainClick = null;
  const now = pageInstance(press.tabId);
  const samePageThroughout = samePageInstance(last.press.page, press.page) && samePageInstance(press.page, now);
  return { wasShown: last.shown && press.wasShown && samePageThroughout && shownAndAwake(press.windowId, press.tabId) };
}

const pinOf = (tabId: string) => {
  const tab = useBrowser.getState().tabs[tabId];
  return tab ? familyKeyOf(tab) : tabId;
};

const pageInstance = (tabId: string): PageInstance => ({ state: useBrowser.getState().tabs[tabId]?.page, mount: webviewMount(tabId) });

const samePageInstance = (a: PageInstance, b: PageInstance) => a.state === b.state && a.mount === b.mount;

const shownAndAwake = (windowId: string, tabId: string) => {
  const s = useBrowser.getState();
  return activeTabId(s, windowId) === tabId && !isAsleep(s.tabs[tabId]) && !holderOfPage(s.tabs[tabId]) && !isSleeping(tabId);
};

let heldPress: TabPress | null = null;

type SwitchPress = { windowId: string; tabId: string; at: number; point: TabPress["at"]; landed: boolean };
const SWITCH_PRESS_KEPT_MS = 2000;
let switchPress: SwitchPress | null = null;
let stopWatchingSwitch = () => {};

function forgetSwitchPress() {
  switchPress = null;
  stopWatchingSwitch();
  stopWatchingSwitch = () => {};
}

function rememberSwitchPress(press: SwitchPress) {
  forgetSwitchPress();
  switchPress = press;
  stopWatchingSwitch = useBrowser.subscribe((s) => {
    const p = switchPress;
    if (!p) return;
    const inWindow = s.tabs[p.tabId]?.windowId === p.windowId;
    const shown = inWindow && activeTabId(s, p.windowId) === p.tabId;
    if (shown) p.landed = true;
    if (!inWindow || (p.landed && !shown) || performance.now() - p.at > SWITCH_PRESS_KEPT_MS) forgetSwitchPress();
  });
}

export function switchedByPressWithin(windowId: string, tabId: string, ms: number, point: TabPress["at"] = null) {
  const p = switchPress;
  if (!p || p.windowId !== windowId || p.tabId !== tabId || performance.now() - p.at >= ms) return false;
  return !!p.point && !!point && Math.hypot(point.x - p.point.x, point.y - p.point.y) < TAB_CLICK_SLOP;
}

const pressEnds = new Set<{ windowId: string; listener: () => void }>();

export const tabPressHeld = (windowId: string) => heldPress?.windowId === windowId;

export function onTabPressEnd(windowId: string, listener: () => void) {
  const entry = { windowId, listener };
  pressEnds.add(entry);
  return () => void pressEnds.delete(entry);
}

function releasePress() {
  const windowId = heldPress?.windowId;
  heldPress = null;
  for (const entry of [...pressEnds]) {
    if (entry.windowId !== windowId) continue;
    pressEnds.delete(entry);
    entry.listener();
  }
}

type WithHistory = GestureResponderEvent & { touchHistory?: { touchBank: ({ startTimeStamp: number } | null | undefined)[] } };

const pressStart = (e: GestureResponderEvent) => (e as WithHistory).touchHistory?.touchBank[Number(e.nativeEvent.identifier)]?.startTimeStamp;

const pointOf = (e: GestureResponderEvent) => {
  const { pageX, pageY } = e.nativeEvent;
  return Number.isFinite(pageX) && Number.isFinite(pageY) ? { x: pageX, y: pageY } : null;
};

export const pressPoint = pointOf;

const windowIsKey = (windowId: string) => AppState.currentState === "active" && focusedWindowOf(useBrowser.getState()) === windowId;

function driftBetween(from: TabPress["at"], to: TabPress["at"]): TabPressDrift {
  if (!from || !to) return "unknown";
  const far = Math.hypot(to.x - from.x, to.y - from.y);
  return far < 5 ? "lt5" : far < TAB_CLICK_SLOP ? "5_9" : "10_plus";
}

function plainPress(press: GestureResponderEvent) {
  const mods = modifiersOf(press);
  return !(mods.metaKey || mods.altKey || mods.shiftKey || (press.nativeEvent as { ctrlKey?: boolean }).ctrlKey);
}

function switchesOnPress(windowId: string, tabId: string, press: GestureResponderEvent) {
  if (!devTabPress.switchOnPress || !plainPress(press)) return false;
  const s = useBrowser.getState();
  if (!s.tabs[tabId] || activeTabId(s, windowId) === tabId) return false;
  return !(s.selection[windowId] ?? []).includes(tabId);
}

export function noteRowPressIn(windowId: string) {
  const s = useBrowser.getState();
  const shown = activeTabId(s, windowId);
  void noteRowPress(!!shown && !s.tabs[shown]?.url);
}

const sameGesture = (previous: TabPress | null, startedAt: number | undefined, tabId: string): previous is TabPress =>
  !!previous && previous.tabId === tabId && startedAt !== undefined && previous.startedAt === startedAt;

export function holdTabPress(windowId: string, tabId: string, press: GestureResponderEvent, previous: TabPress | null = null) {
  const startedAt = pressStart(press);
  if (sameGesture(previous, startedAt, tabId)) {
    previous.out = false;
    if (!previous.answered) heldPress = previous;
    return previous;
  }
  settleUnansweredPressOut();
  noteRowPressIn(windowId);
  const nativePress = claimPress(tabId, startedAt);
  const wasShown = shownAndAwake(windowId, tabId);
  const switched = switchesOnPress(windowId, tabId, press);
  const held: TabPress = { windowId, tabId, startedAt, switched, nativePress, at: pointOf(press), windowKey: windowIsKey(windowId), answered: false, out: false, drift: "unknown", plain: plainPress(press), wasShown, heldAt: performance.now(), dragged: false, page: pageInstance(tabId), pin: pinOf(tabId) };
  heldPress = held;
  notePressStarted(switched, held.windowKey, held);
  if (switched) {
    rememberSwitchPress({ windowId, tabId, at: performance.now(), point: held.at, landed: false });
    dismissHover();
    switchingByPress(nativePress, () => clickTab(windowId, tabId));
  }
  if (activeTabId(useBrowser.getState(), windowId) !== tabId) pressLeftTabBehind(nativePress);
  return held;
}

export function clickHeldTabPress(windowId: string, tabId: string, release: GestureResponderEvent, press: TabPress | null = null, onDoubleClick?: TileDoubleClick) {
  const held = heldPress;
  const first = secondOfPair(press, release);
  releasePress();
  if (press && !press.answered) {
    press.answered = true;
    if (press.out) notePressOutAnswered(press);
    else notePressAnswered(press);
  }
  notePressEnded("click", tabId);
  dismissHover();
  const start = pressStart(release);
  if (!(held?.switched && held.tabId === tabId && start !== undefined && held.startedAt === start)) switchingByPress(press?.nativePress ?? 0, () => clickTab(windowId, tabId, modifiersOf(release)));
  if (first && onDoubleClick) onDoubleClick(first.wasShown);
}

export function endPressGesture(press: TabPress | null) {
  if (!press) return;
  setTimeout(() => {
    if (heldPress === press && !press.answered) releasePress();
  }, 0);
}

export function pressOutTabPress(press: TabPress | null, e: GestureResponderEvent) {
  if (!press || press.out) return;
  press.out = true;
  press.drift = driftBetween(press.at, pointOf(e));
  if (press.answered) notePressOutAnswered(press);
  else notePressOutUnanswered(press);
}

export function endHeldTabPress(tabIds: string[], release: GestureResponderEvent | null) {
  const held = heldPress;
  releasePress();
  lastPlainClick = null;
  if (!held) return;
  held.dragged = true;
  const dropped = (why: TabPressDrop) => notePressEnded("drag", null, why);
  if (!release) return dropped("no_release");
  if (!tabIds.includes(held.tabId)) return dropped("not_dragged");
  if (held.startedAt === undefined) return dropped("no_start");
  if (held.startedAt !== pressStart(release)) return dropped("start_mismatch");
  notePressEnded("dragClick", held.tabId);
  dismissHover();
  if (!held.switched) switchingByPress(held.nativePress, () => clickTab(held.windowId, held.tabId, modifiersOf(release)));
}
