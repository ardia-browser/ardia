import { useRef } from "react";
import { Animated } from "react-native";

type Fade = { value: Animated.Value; from: number; to: number; at: number; ms: number };

export type SectionFades = { valueOf(key: string, lit: boolean): Animated.Value; light(keys: readonly string[], activeKey: string | null, ms: number): void };

export function useSectionFades(peek: number, ease: (t: number) => number): SectionFades {
  const fades = useRef(new Map<string, Fade>()).current;
  const level = (f: Fade, now: number) => (f.ms <= 0 ? f.to : f.from + (f.to - f.from) * ease(Math.min(1, Math.max(0, (now - f.at) / f.ms))));
  return {
    valueOf(key, lit) {
      let fade = fades.get(key);
      if (!fade) {
        const start = lit ? 1 : peek;
        fade = { value: new Animated.Value(start), from: start, to: start, at: 0, ms: 0 };
        fades.set(key, fade);
      }
      return fade.value;
    },
    light(keys, activeKey, ms) {
      const now = Date.now();
      for (const key of keys) {
        const fade = fades.get(key);
        const to = key === activeKey ? 1 : peek;
        if (!fade || fade.to === to) continue;
        const from = level(fade, now);
        Object.assign(fade, { from, to, at: now, ms });
        fade.value.setValue(ms > 0 ? from : to);
        if (ms > 0) Animated.timing(fade.value, { toValue: to, duration: ms, easing: ease, useNativeDriver: true, isInteraction: false }).start();
      }
    },
  };
}
