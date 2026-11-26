import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/client";
import { notePeekChromePressMidGesture } from "../telemetry/usage";
import { shownPeek } from "./peek";

type StageLook = { midGesture: boolean; chromeShown: boolean; scrimShown: boolean };
export type PeekButtonSurface = "bar" | "side";

const MID_GESTURE_PHASES: ReadonlySet<string> = new Set(["gesture", "settling"]);
const stages = new Map<string, StageLook>();

export function notePeekStageState(peekTabId: string, phase: string, { chromeShown = true, scrimShown = true }: { chromeShown?: boolean; scrimShown?: boolean } = {}) {
  stages.set(peekTabId, { midGesture: MID_GESTURE_PHASES.has(phase), chromeShown, scrimShown });
}

export const forgetPeekStage = (peekTabId: string) => void stages.delete(peekTabId);

function stageLook(windowId: string) {
  const peek = shownPeek(useBrowser.getState(), windowId);
  return peek ? stages.get(peek.tabId) : undefined;
}

export function pressPeekChrome(windowId: string, surface: PeekButtonSurface, press: () => void) {
  const look = stageLook(windowId);
  if (look && !(surface === "bar" ? look.chromeShown : look.scrimShown)) return;
  if (look?.midGesture) notePeekChromePressMidGesture(consentToken());
  press();
}

export function pressPeekScrim(windowId: string, press: () => void) {
  const look = stageLook(windowId);
  if (look && !look.scrimShown) return;
  press();
}
