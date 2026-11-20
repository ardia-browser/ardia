import { AppState, type GestureResponderEvent } from "react-native";
import { modifiersOf } from "../../lib/keys";
import { activeTabId } from "../browser/model";
import { claimPress, pressLeftTabBehind, switchingByPress } from "../tabs/tabReveal";
import { useBrowser } from "../browser/store";
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
};

let heldPress: TabPress | null = null;
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
  const switched = switchesOnPress(windowId, tabId, press);
  const held: TabPress = { windowId, tabId, startedAt, switched, nativePress, at: pointOf(press), windowKey: windowIsKey(windowId), answered: false, out: false, drift: "unknown" };
  heldPress = held;
  notePressStarted(switched, held.windowKey);
  if (switched) {
    dismissHover();
    switchingByPress(nativePress, () => clickTab(windowId, tabId));
  }
  if (activeTabId(useBrowser.getState(), windowId) !== tabId) pressLeftTabBehind(nativePress);
  return held;
}

export function clickHeldTabPress(windowId: string, tabId: string, release: GestureResponderEvent, press: TabPress | null = null) {
  const held = heldPress;
  releasePress();
  if (press && !press.answered) {
    press.answered = true;
    if (press.out) notePressOutAnswered(press);
    else notePressAnswered(press);
  }
  notePressEnded("click", tabId);
  dismissHover();
  const start = pressStart(release);
  if (held?.switched && held.tabId === tabId && start !== undefined && held.startedAt === start) return;
  switchingByPress(press?.nativePress ?? 0, () => clickTab(windowId, tabId, modifiersOf(release)));
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
  if (!held) return;
  const dropped = (why: TabPressDrop) => notePressEnded("drag", null, why);
  if (!release) return dropped("no_release");
  if (!tabIds.includes(held.tabId)) return dropped("not_dragged");
  if (held.startedAt === undefined) return dropped("no_start");
  if (held.startedAt !== pressStart(release)) return dropped("start_mismatch");
  notePressEnded("dragClick", held.tabId);
  dismissHover();
  if (!held.switched) switchingByPress(held.nativePress, () => clickTab(held.windowId, held.tabId, modifiersOf(release)));
}
