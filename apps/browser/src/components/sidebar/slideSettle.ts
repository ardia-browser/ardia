import type { Animated } from "react-native";

export type Slide = { value: Animated.Value; from: number; at: number; until: number; run: Animated.CompositeAnimation | null; landed: boolean };

export function settleSlides(slides: Iterable<Slide>, now: number): boolean {
  let overrun = false;
  for (const slide of slides) {
    if (!slide.until || now < slide.until) continue;
    if (slide.run) {
      overrun = true;
      continue;
    }
    slide.until = 0;
    if (!slide.landed) slide.value.setValue(0);
  }
  return overrun;
}
