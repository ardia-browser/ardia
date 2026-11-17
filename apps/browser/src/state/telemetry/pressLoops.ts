import { onPressLoopLong, type PressLoopLongReport } from "../../platform/performance";
import { capture } from "./client";

const LOOPS = new Set(["windowDragRegion", "windowMove"]);
const MAX_EVENTS = 10;

let sent = 0;
let watching = false;

const loopName = (value: unknown) => (typeof value === "string" && LOOPS.has(value) ? value : "other");

export function pressLoopLongProperties(r: PressLoopLongReport) {
  return { loop: loopName(r.loop), inner: loopName(r.inner), still_open: r.open === true, buttons_held: r.buttonsHeld === true };
}

export function trackPressLoopLong(r: PressLoopLongReport) {
  if (sent >= MAX_EVENTS) return;
  sent++;
  capture("press_loop_long", pressLoopLongProperties(r));
}

export function watchPressLoops() {
  if (watching) return;
  watching = true;
  onPressLoopLong(trackPressLoopLong);
}
