import type { Animated } from "react-native";

export type Slide = { value: Animated.Value; from: number; at: number; until: number; run: Animated.CompositeAnimation | null; landed: boolean };

export type Settled = { overrun: boolean; stopped: number };

export function settleSlides(slides: Iterable<Slide>, now: number): Settled {
  let overrun = false;
  let stopped = 0;
  for (const slide of slides) {
    if (!slide.until || now < slide.until) continue;
    if (slide.run) {
      overrun = true;
      continue;
    }
    slide.until = 0;
    if (slide.landed) continue;
    slide.value.setValue(0);
    stopped++;
  }
  return { overrun, stopped };
}
