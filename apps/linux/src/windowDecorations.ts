import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";
import { noteLinuxWindowDecorations } from "../../browser/src/state/telemetry/windowPlacementCounts.ts";
import type { CornerRadii } from "./hostExtensionView.ts";

export const WINDOW_DECORATIONS_METHOD = "ArdiaShell.windowDecorations";
export const ANSWER_SETTLE_MS = 5000;
const WINDOW_DECORATIONS_EVENT = "windowDecorations";
const SQUARE: CornerRadii = { upperLeft: 0, upperRight: 0, lowerRight: 0, lowerLeft: 0 };

type Decorations = { decoratedBy: unknown; answer: unknown; corners?: unknown };
type Note = (decoratedBy: unknown, answer: unknown) => void;
type Timers = { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void };

const isDecorations = (value: unknown): value is Decorations => !!value && typeof value === "object" && "decoratedBy" in value && "answer" in value;
const radius = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

function cornersOf(value: unknown): CornerRadii | null {
  if (!value || typeof value !== "object") return null;
  const corners = value as Record<string, unknown>;
  return { upperLeft: radius(corners.upperLeft), upperRight: radius(corners.upperRight), lowerRight: radius(corners.lowerRight), lowerLeft: radius(corners.lowerLeft) };
}

let windowCorners: CornerRadii = SQUARE;
const cornerListeners = new Set<() => void>();

export const currentWindowCorners = (): CornerRadii => windowCorners;

export function onWindowCornersChanged(listener: () => void): () => void {
  cornerListeners.add(listener);
  return () => cornerListeners.delete(listener);
}

function setWindowCorners(next: CornerRadii) {
  if (next.upperLeft === windowCorners.upperLeft && next.upperRight === windowCorners.upperRight && next.lowerRight === windowCorners.lowerRight && next.lowerLeft === windowCorners.lowerLeft) return;
  windowCorners = next;
  for (const listener of cornerListeners) listener();
}

const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };

export function watchWindowDecorations(host: ArdiaHost, windowId: string, note: Note = noteLinuxWindowDecorations, timers: Timers = realTimers): () => void {
  if (!hostSupports(WINDOW_DECORATIONS_METHOD, host)) return () => {};
  let countedBy: unknown = undefined;
  let answerCounted = false;
  let heardEvent = false;
  let settle: unknown = null;
  const countAnswer = (answer: unknown) => {
    if (answerCounted) return;
    answerCounted = true;
    if (settle !== null) timers.clear(settle);
    settle = null;
    note(undefined, answer);
  };
  const record = (value: Decorations) => {
    const corners = cornersOf(value.corners);
    if (corners) setWindowCorners(corners);
    if (value.decoratedBy !== countedBy) {
      countedBy = value.decoratedBy;
      note(value.decoratedBy, undefined);
    }
    if (answerCounted) return;
    if (value.answer === "client" || value.answer === "server") countAnswer(value.answer);
    else if (value.answer === "none" && settle === null) settle = timers.set(() => countAnswer("none"), ANSWER_SETTLE_MS);
  };
  const stop = host.onEvent((module, event, payload) => {
    if (module !== "ArdiaShell" || event !== WINDOW_DECORATIONS_EVENT || !isDecorations(payload) || (payload as { windowId?: unknown }).windowId !== windowId) return;
    heardEvent = true;
    record(payload);
  });
  void invokeHost<unknown>(WINDOW_DECORATIONS_METHOD, { args: [windowId] }, host).then((reply) => {
    if (!heardEvent && isDecorations(reply)) record(reply);
  }, () => {});
  return () => {
    stop();
    if (settle !== null) timers.clear(settle);
  };
}
