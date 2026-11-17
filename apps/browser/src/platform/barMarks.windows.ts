import type { BarFieldMarks } from "./barMarks";
export type { BarFieldMarks } from "./barMarks";

const SLOW_SUGGESTIONS_MS = 8;

const mark = (line: string) => console.info(`[ardia windows] bar ${line}`);

export const barFieldMarks: BarFieldMarks = {
  change: (variant, eventCount, length) => mark(`change ${variant} #${eventCount} len ${length}`),
  write: (variant, length, nativeLength) => mark(`write ${variant} len ${length} over native len ${nativeLength}`),
  repair: (variant, letters, at) => mark(`repair ${variant} restored ${letters} at ${at}`),
  field: (event, variant, tag) => mark(`field ${event} ${variant} tag ${tag ?? "none"}`),
  rows: (pointerOver, held, shown) => mark(`rows pointer ${pointerOver ? "over" : "away"}, ${held ? "holding" : "live"}, ${shown} shown`),
  suggestions: (ms, textLength) => void (ms >= SLOW_SUGGESTIONS_MS && mark(`suggestions ${Math.round(ms)} ms for len ${textLength}`)),
};
