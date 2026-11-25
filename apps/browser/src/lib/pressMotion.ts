export const PRESS_MOTIONS = ["still", "bounce"] as const;

export type PressMotion = (typeof PRESS_MOTIONS)[number];

let current: PressMotion = "still";
const listeners = new Set<() => void>();

export const pressMotionNow = (): PressMotion => current;

export function setPressMotion(next: PressMotion) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribePressMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
