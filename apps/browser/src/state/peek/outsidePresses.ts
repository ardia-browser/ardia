import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/client";
import { notePeekOutsidePressClose } from "../telemetry/usage";
import { dismissPeek } from "./actions";
import { pressPeekScrim } from "./gesturePresses";
import { shownPeek } from "./peek";

export const OUTSIDE_CLICK_SLOP = 10;
const PRIMARY_BUTTON = 0;

type Point = { x: number; y: number };
type HeldPress = { peekTabId: string; at: Point };

const held = new Map<string, HeldPress>();

const shownPeekTab = (windowId: string) => shownPeek(useBrowser.getState(), windowId)?.tabId;

function closeShownPeek(windowId: string) {
  pressPeekScrim(windowId, () => {
    notePeekOutsidePressClose(consentToken());
    dismissPeek(windowId);
  });
}

export function startPeekOutsidePress(windowId: string, at: Point, button: number | undefined) {
  const peekTabId = shownPeekTab(windowId);
  if (peekTabId && (button ?? PRIMARY_BUTTON) === PRIMARY_BUTTON) held.set(windowId, { peekTabId, at });
  else held.delete(windowId);
}

export function endPeekOutsidePress(windowId: string, at: Point) {
  const press = held.get(windowId);
  held.delete(windowId);
  if (!press || Math.hypot(at.x - press.at.x, at.y - press.at.y) > OUTSIDE_CLICK_SLOP) return;
  if (shownPeekTab(windowId) === press.peekTabId) closeShownPeek(windowId);
}

export const cancelPeekOutsidePress = (windowId: string) => void held.delete(windowId);

export function pressPeekOutsideOnDragRegion(windowId: string) {
  if (shownPeekTab(windowId)) closeShownPeek(windowId);
}
