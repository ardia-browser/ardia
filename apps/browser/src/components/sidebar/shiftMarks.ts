import type { Animated } from "react-native";

const sliding = new WeakSet<Animated.Value>();
const appearing = new WeakMap<Animated.Value, Animated.Value>();
const appearStarts = new WeakMap<Animated.Value, number>();
const isNative = (value: Animated.Value | undefined) => !!(value as { __isNative?: boolean } | undefined)?.__isNative;

export const setSliding = (shift: Animated.Value, on: boolean) => void (on ? sliding.add(shift) : sliding.delete(shift));
export const setAppearing = (shift: Animated.Value, opacity: Animated.Value) => void appearing.set(shift, opacity);
export const appearOf = (shift: Animated.Value) => appearing.get(shift) ?? null;
export const holdsDrawn = (shift: Animated.Value) => sliding.has(shift) && (isNative(shift) || isNative(appearing.get(shift)));
export const startAppear = (shift: Animated.Value, at: number) => void appearStarts.set(shift, at);
export function appearProgress(shift: Animated.Value | undefined, t: number, ms: number): number {
  const start = shift && appearing.has(shift) ? appearStarts.get(shift) : undefined;
  return start === undefined ? 1 : Math.min(1, Math.max(0, (t - start) / ms));
}
