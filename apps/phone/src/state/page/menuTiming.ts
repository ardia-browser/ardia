import { labLog } from "../../platform/lab";
import { interactionPerfEnabled } from "../app/interactionPerf";

const PRESS_COUNTS_FOR_MS = 1000;

let pressedAt: number | null = null;

export function markMenuPressed(at: number = Date.now()) {
  if (!interactionPerfEnabled()) return;
  if (pressedAt !== null && at - pressedAt < PRESS_COUNTS_FOR_MS) return;
  pressedAt = at;
  labLog("PAGELAB menu press 0");
}

export function markMenuPhase(phase: string) {
  if (pressedAt === null || !interactionPerfEnabled()) return;
  labLog(`PAGELAB menu ${phase} ${Date.now() - pressedAt}`);
}

export const endMenuTiming = () => {
  pressedAt = null;
};
