import { runOnJS } from "react-native-reanimated";
import { interactionLine, lookTotalsBetween, summarizeFrames, type LookTotals } from "../../lib/framePerf";
import { isLabBuild, labLog, lookActivity, lookTotals } from "../../platform/lab";

export type UiFrameRecorder = { start: () => void; stop: () => number[] };

export const INTERACTION_WINDOW_MS = { deckScroll: 1200, deckOpen: 900, cardOpen: 900, trayOpen: 800, deckPull: 4000, deckPullLanding: 900 } as const;

type Session = { name: string; windowMs: number; startedAt: number; lookAtStart: LookTotals | null; js: number[]; lastFrame: number | null; renders: Map<string, number>; frame: number | null; timer: ReturnType<typeof setTimeout> | null };

let enabled = isLabBuild;
let session: Session | null = null;
let uiRecorder: UiFrameRecorder | null = null;
let report: (line: string) => void = labLog;

export const interactionPerfEnabled = () => enabled;

export function enableInteractionPerf(on: boolean, reporter: (line: string) => void = labLog) {
  enabled = on;
  report = reporter;
  if (!on) finishInteraction();
}

export function markTiming(label: string, at: number = Date.now()) {
  if (enabled) report(`PAGELAB time ${label} ${at}`);
}

export function markNextUiFrame(label: string) {
  "worklet";
  requestAnimationFrame(() => {
    runOnJS(markTiming)(label, Date.now());
  });
}

export function setUiFrameRecorder(recorder: UiFrameRecorder | null) {
  uiRecorder = recorder;
}

export function countRender(component: string) {
  if (!session) return;
  session.renders.set(component, (session.renders.get(component) ?? 0) + 1);
}

function nextFrame(now: number) {
  if (!session) return;
  if (session.lastFrame !== null) session.js.push(now - session.lastFrame);
  session.lastFrame = now;
  session.frame = requestAnimationFrame(nextFrame);
}

export function beginInteraction(name: string, windowMs: number) {
  if (!enabled) return;
  finishInteraction();
  session = { name, windowMs, startedAt: Date.now(), lookAtStart: lookTotals(), js: [], lastFrame: null, renders: new Map(), frame: null, timer: null };
  uiRecorder?.start();
  session.frame = requestAnimationFrame(nextFrame);
  session.timer = setTimeout(finishInteraction, windowMs);
}

export function cutInteraction(name: string) {
  if (session?.name === name) finishInteraction(Date.now() - session.startedAt);
}

export function finishInteraction(elapsedMs?: number) {
  const done = session;
  if (!done) return;
  session = null;
  if (done.frame !== null) cancelAnimationFrame(done.frame);
  if (done.timer) clearTimeout(done.timer);
  const ui = uiRecorder ? uiRecorder.stop() : null;
  const look = lookActivity();
  report(interactionLine(done.name, typeof elapsedMs === "number" ? Math.min(elapsedMs, done.windowMs) : done.windowMs, summarizeFrames(done.js), ui ? summarizeFrames(ui) : null, done.renders, look ? { ...look, during: lookTotalsBetween(done.lookAtStart, lookTotals()) } : null));
}
