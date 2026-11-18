import type { GestureResponderEvent } from "react-native";
import { modifiersOf } from "../../lib/keys";
import { activeTabId } from "../browser/model";
import { useBrowser } from "../browser/store";
import { clickTab } from "./actions";
import { dismissHover } from "./hover";
import { notePressEnded, notePressStarted, noteRowPress } from "../telemetry/tabPresses";

export const TAB_CLICK_SLOP = 10;

export const devTabPress = { switchOnPress: true };

let heldPress: { windowId: string; tabId: string; startedAt: number | undefined; switched: boolean } | null = null;
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

function switchesOnPress(windowId: string, tabId: string, press: GestureResponderEvent) {
  if (!devTabPress.switchOnPress) return false;
  const mods = modifiersOf(press);
  if (mods.metaKey || mods.altKey || mods.shiftKey || (press.nativeEvent as { ctrlKey?: boolean }).ctrlKey) return false;
  const s = useBrowser.getState();
  if (!s.tabs[tabId] || activeTabId(s, windowId) === tabId) return false;
  return !(s.selection[windowId] ?? []).includes(tabId);
}

export function noteRowPressIn(windowId: string) {
  const s = useBrowser.getState();
  const shown = activeTabId(s, windowId);
  void noteRowPress(!!shown && !s.tabs[shown]?.url);
}

export function holdTabPress(windowId: string, tabId: string, press: GestureResponderEvent) {
  noteRowPressIn(windowId);
  const switched = switchesOnPress(windowId, tabId, press);
  heldPress = { windowId, tabId, startedAt: pressStart(press), switched };
  notePressStarted(switched);
  if (!switched) return;
  dismissHover();
  clickTab(windowId, tabId);
}

export function clickHeldTabPress(windowId: string, tabId: string, release: GestureResponderEvent) {
  const held = heldPress;
  releasePress();
  notePressEnded("click", tabId);
  dismissHover();
  const start = pressStart(release);
  if (held?.switched && held.tabId === tabId && start !== undefined && held.startedAt === start) return;
  clickTab(windowId, tabId, modifiersOf(release));
}

export function endHeldTabPress(tabIds: string[], release: GestureResponderEvent | null) {
  const held = heldPress;
  releasePress();
  if (!held) return;
  if (!release || !tabIds.includes(held.tabId) || held.startedAt === undefined || held.startedAt !== pressStart(release)) return notePressEnded("drag");
  notePressEnded("dragClick", held.tabId);
  dismissHover();
  if (!held.switched) clickTab(held.windowId, held.tabId, modifiersOf(release));
}
