import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import { curve, nativeLoop } from "../../ui/motion";

export type Stop = readonly [number, number];

const SAMPLES = 8;
export const easeOut = (x: number) => 1 - (1 - x) ** 3;
export const linear = (x: number) => x;

export function track(p: Animated.Value, duration: number, stops: readonly Stop[], ease: (x: number) => number = easeOut) {
  const input: number[] = [];
  const output: number[] = [];
  const push = (ms: number, value: number) => {
    const last = input.length ? input[input.length - 1]! * duration : -Infinity;
    input.push(Math.max(ms, last + 0.5) / duration);
    output.push(value);
  };
  stops.forEach(([ms, value], i) => {
    if (i === 0) return push(ms, value);
    const [from, start] = stops[i - 1]!;
    if (value === start) return push(ms, value);
    for (let k = 1; k <= SAMPLES; k++) push(from + ((ms - from) * k) / SAMPLES, start + (value - start) * ease(k / SAMPLES));
  });
  if (input.length === 1) push(input[0]! * duration + 1, output[0]!);
  return p.interpolate({ inputRange: input, outputRange: output, extrapolate: "clamp" });
}

export type Tracker = ReturnType<typeof tracker>;

export function tracker(p: Animated.Value, duration: number, offset = 0) {
  const t = (stops: readonly Stop[], ease?: (x: number) => number) => track(p, duration, stops.map(([ms, v]) => [ms + offset, v] as const), ease);
  t.in = (ms: number, dur = 240) => t([[ms, 0], [ms + dur, 1]]);
  t.out = (ms: number, dur = 240) => t([[ms, 1], [ms + dur, 0]]);
  t.step = (ms: number, from = 0, to = 1) => t([[ms, from], [ms + 1, to]], linear);
  t.trip = (from: number, to: number, at: number, back: number, dur = 240, backDur = dur) => t([[at, from], [at + dur, to], [back, to], [back + backDur, from]]);
  t.pulse = (at: number, back: number, dur = 240, backDur = dur) => t.trip(0, 1, at, back, dur, backDur);
  t.deg = (stops: readonly Stop[]) => t(stops).interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"], extrapolate: "extend" });
  return t;
}

export const phasePin: { value: Animated.Value | null } = { value: null };

export function useLoop(duration: number) {
  const own = useRef(new Animated.Value(0)).current;
  const pinned = phasePin.value;
  useEffect(() => {
    if (pinned) return;
    const loop = nativeLoop(own, [{ to: 1, ms: duration }]);
    loop.start();
    return () => loop.stop();
  }, [duration, pinned]);
  return pinned ?? own;
}

const CRUMB_SWAP = { leave: 120, arrive: 200, slide: 8 } as const;

export function crumbSwap(ms: number, back: number) {
  const { leave, arrive, slide } = CRUMB_SWAP;
  return {
    first: {
      opacity: [[ms, 1], [ms + leave, 0], [back + leave, 0], [back + leave + arrive, 1]] as const,
      x: [[ms, 0], [ms + leave, -slide], [back + leave, slide], [back + leave + arrive, 0]] as const,
    },
    second: {
      opacity: [[ms + leave, 0], [ms + leave + arrive, 1], [back, 1], [back + leave, 0]] as const,
      x: [[ms + leave, slide], [ms + leave + arrive, 0], [back, 0], [back + leave, -slide], [back + leave + arrive, slide]] as const,
    },
  };
}
