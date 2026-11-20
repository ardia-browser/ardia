export const TRACKING_SCALE = 0.5;
export const RUBBER_DIMENSION = 255;
export const FLICK_VELOCITY = 5;
export const HISTORY_WINDOW = 0.1;
const RUBBER_COEFFICIENT = 0.15;

export const rubberBand = (value: number, dimension: number) => (1 - 1 / ((value * RUBBER_COEFFICIENT) / dimension + 1)) * dimension;

export const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

export function releaseVelocity(history: readonly { time: number; position: number }[], timestamp: number) {
  const recent = history.filter((h) => timestamp - h.time <= HISTORY_WINDOW);
  const first = recent[0];
  const last = recent.at(-1);
  if (recent.length < 2 || !first || !last || last.time <= first.time) return 0;
  return (last.position - first.position) / (last.time - first.time);
}

export type DragFrame = { start: number; raw: number; lo: number; hi: number; home: number; detent: number };

export const shiftDrag = <D extends DragFrame>(d: D, shift: number, count: number): D => ({
  ...d,
  start: d.start + shift,
  raw: d.raw + shift,
  lo: d.lo + shift,
  hi: Math.min(count - 1, d.hi + shift),
  home: d.home + shift,
  detent: d.detent + shift,
});
