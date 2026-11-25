import type { FieldTiming } from "../../browser/src/platform/fieldTiming";

const MAX_MARKS = 512;
const INPUT_EVENTS = ["keydown", "pointerdown", "pointerup"] as const;

type InputTarget = Pick<Window, "addEventListener" | "removeEventListener">;
type FrameClock = { now(): number; eventTime(event: Event): number; afterPaint(run: () => void): void };

const browserClock: FrameClock = {
  now: () => performance.timeOrigin + performance.now(),
  eventTime: (event) => performance.timeOrigin + event.timeStamp,
  afterPaint: (run) => requestAnimationFrame(() => setTimeout(run, 0)),
};

export function createFieldTiming(target: InputTarget | null, clock: FrameClock): FieldTiming {
  let enabled = false;
  let generation = 0;
  let marks: [string, string, number][] = [];
  let lastInputAt = 0;
  let lastInputKind = 0;
  const noteInput = (event: Event) => {
    lastInputAt = Math.round(clock.eventTime(event) * 10) / 10;
    lastInputKind = event.type === "keydown" ? 1 : 2;
  };
  const push = (key: string, kind: string, at: number) => {
    if (!enabled || !key || !Number.isFinite(at)) return;
    if (marks.length >= MAX_MARKS) marks.shift();
    marks.push([key, kind, Math.round(at * 10) / 10]);
  };
  return {
    pageMarks: false,
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      generation++;
      for (const type of INPUT_EVENTS) {
        if (on) target?.addEventListener(type, noteInput, { capture: true, passive: true });
        else target?.removeEventListener(type, noteInput, { capture: true });
      }
      if (on) return;
      marks = [];
      lastInputAt = 0;
      lastInputKind = 0;
    },
    markFrame(key, kind) {
      if (!enabled) return;
      const asked = generation;
      clock.afterPaint(() => {
        if (asked === generation) push(key, kind, clock.now());
      });
    },
    lastInput: () => [lastInputAt, lastInputKind],
    drain() {
      const taken = marks;
      marks = [];
      return taken;
    },
  };
}

export const fieldTiming: FieldTiming = createFieldTiming(typeof window === "undefined" ? null : window, browserClock);
