import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/client";
import { notePeekOutsideClosePress } from "../telemetry/usage";
import { dismissPeek } from "./actions";
import { pressPeekScrim } from "./gesturePresses";
import { shownPeek } from "./peek";
import { pressSwitchedShownPage } from "./pressSwitches";

export const OUTSIDE_CLICK_SLOP = 10;
const PRIMARY_BUTTON = 0;

type Point = { x: number; y: number };
type HeldPress = { peekTabId: string; at: Point; strayed: boolean };

const held = new Map<string, HeldPress>();

const shownPeekTab = (windowId: string) => shownPeek(useBrowser.getState(), windowId)?.tabId;
const strays = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y) > OUTSIDE_CLICK_SLOP;

function closeShownPeek(windowId: string) {
  pressPeekScrim(windowId, () => {
    notePeekOutsideClosePress(consentToken());
    dismissPeek(windowId);
  });
}

export function startPeekOutsidePress(windowId: string, at: Point, button: number | undefined) {
  pressSwitchedShownPage(windowId);
  const peekTabId = shownPeekTab(windowId);
  if (peekTabId && (button ?? PRIMARY_BUTTON) === PRIMARY_BUTTON) held.set(windowId, { peekTabId, at, strayed: false });
  else held.delete(windowId);
}

export function movePeekOutsidePress(windowId: string, at: Point) {
  const press = held.get(windowId);
  if (press && strays(press.at, at)) press.strayed = true;
}

export function endPeekOutsidePress(windowId: string, at: Point) {
  const press = held.get(windowId);
  held.delete(windowId);
  const switched = pressSwitchedShownPage(windowId);
  if (!press || switched || press.strayed || strays(press.at, at)) return;
  if (shownPeekTab(windowId) === press.peekTabId) closeShownPeek(windowId);
}

export function cancelPeekOutsidePress(windowId: string) {
  held.delete(windowId);
  pressSwitchedShownPage(windowId);
}

export function pressPeekOutsideOnDragRegion(windowId: string) {
  if (shownPeekTab(windowId)) closeShownPeek(windowId);
}
