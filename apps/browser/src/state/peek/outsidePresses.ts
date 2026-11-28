import { useBrowser } from "../browser/store";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { notePeekOutsideClosePress } from "../telemetry/usage";
import { dismissPeek } from "./actions";
import { pressPeekScrim } from "./gesturePresses";
import { shownPeek } from "./peek";
import { notePressKeepsPeek, pressKeptPeek } from "./keptPresses";

export const OUTSIDE_CLICK_SLOP = 10;
const PRIMARY_BUTTON = 0;

type Point = { x: number; y: number };
type OutsidePress = { peekTabId: string; at: Point; strayed: boolean; consent: ConsentToken | null };

const presses = new Map<string, OutsidePress>();

const shownPeekTab = (windowId: string) => shownPeek(useBrowser.getState(), windowId)?.tabId;
const strays = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y) > OUTSIDE_CLICK_SLOP;

function closeShownPeek(windowId: string, consent: ConsentToken | null) {
  pressPeekScrim(windowId, () => {
    notePeekOutsideClosePress(consent);
    dismissPeek(windowId);
  });
}

export function startPeekOutsidePress(windowId: string, at: Point, button: number | undefined) {
  pressKeptPeek(windowId);
  const peekTabId = shownPeekTab(windowId);
  if (peekTabId && (button ?? PRIMARY_BUTTON) === PRIMARY_BUTTON) presses.set(windowId, { peekTabId, at, strayed: false, consent: consentToken() });
  else presses.delete(windowId);
}

export function movePeekOutsidePress(windowId: string, at: Point) {
  const press = presses.get(windowId);
  if (press && strays(press.at, at)) press.strayed = true;
}

export function endPeekOutsidePress(windowId: string, at: Point, button: number | undefined) {
  if ((button ?? PRIMARY_BUTTON) !== PRIMARY_BUTTON) return;
  const press = presses.get(windowId);
  presses.delete(windowId);
  const kept = pressKeptPeek(windowId);
  if (!press || kept || press.strayed || strays(press.at, at)) return;
  if (shownPeekTab(windowId) === press.peekTabId) closeShownPeek(windowId, press.consent);
}

export function cancelPeekOutsidePress(windowId: string) {
  presses.delete(windowId);
  pressKeptPeek(windowId);
}

export function pressPeekOutsideOnDragRegion(windowId: string) {
  if (shownPeekTab(windowId)) closeShownPeek(windowId, consentToken());
}

export function notePressSwitchesProfile(windowId: string, profileId: string) {
  const current = useBrowser.getState().windows[windowId]?.profileId;
  if (current && current !== profileId) notePressKeepsPeek(windowId);
}

export function peekKeeperForTab(tabId: string) {
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  return () => void (windowId && notePressKeepsPeek(windowId));
}
