import { Keyboard } from "react-native";
import { labLog } from "../../platform/lab";
import { interactionPerfEnabled } from "../app/interactionPerf";

const FIND_TIMING_WINDOW_MS = 3000;

let pressedAt: number | null = null;
let stopListening: (() => void) | null = null;

export function markFindPressed() {
  if (!interactionPerfEnabled()) return;
  stopListening?.();
  pressedAt = Date.now();
  labLog("PAGELAB find press 0");
  const rises = Keyboard.addListener("keyboardWillShow", () => markFindPhase("keyboard"));
  const risen = Keyboard.addListener("keyboardDidShow", () => {
    markFindPhase("keyboardShown");
    stop();
  });
  const expiry = setTimeout(() => stop(), FIND_TIMING_WINDOW_MS);
  const stop = () => {
    clearTimeout(expiry);
    rises.remove();
    risen.remove();
    if (stopListening === stop) stopListening = null;
    pressedAt = null;
  };
  stopListening = stop;
}

export function markFindPhase(phase: string) {
  if (pressedAt === null || !interactionPerfEnabled()) return;
  labLog(`PAGELAB find ${phase} ${Date.now() - pressedAt}`);
}
