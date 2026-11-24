import { useEffect } from "react";
import { labLog } from "../../platform/lab";
import { interactionPerfEnabled } from "../app/interactionPerf";

const PRESS_COUNTS_FOR_MS = 1000;

let pressedAt: number | null = null;
let closedAt: number | null = null;

export function markSearchPressed(at: number = Date.now()) {
  if (!interactionPerfEnabled()) return;
  if (pressedAt !== null && at - pressedAt < PRESS_COUNTS_FOR_MS) return;
  pressedAt = at;
  closedAt = null;
  labLog("PAGELAB search press 0");
}

export function markSearchPhase(phase: string) {
  if (pressedAt === null || !interactionPerfEnabled()) return;
  labLog(`PAGELAB search ${phase} ${Date.now() - pressedAt}`);
}

export function markSearchClosing() {
  if (!interactionPerfEnabled()) return;
  pressedAt = null;
  closedAt = Date.now();
  labLog("PAGELAB search close 0");
}

export function markSearchClosePhase(phase: string) {
  if (closedAt === null || !interactionPerfEnabled()) return;
  labLog(`PAGELAB search ${phase} ${Date.now() - closedAt}`);
}

export const endSearchTiming = () => {
  pressedAt = null;
  closedAt = null;
};

export function useGlassTrace(name: string, glass: { shown: boolean; shownMs: number }) {
  useEffect(() => {
    if (!interactionPerfEnabled()) return;
    const since = closedAt !== null ? ` close+${Date.now() - closedAt}` : pressedAt !== null ? ` press+${Date.now() - pressedAt}` : "";
    labLog(`PAGELAB glass ${name} ${glass.shown ? "shown" : "hidden"} ${glass.shownMs}${since}`);
  }, [glass.shown, glass.shownMs]);
}
