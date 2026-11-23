import { useEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { curve, reduceMotion, selectionSlide } from "../ui";

function useChanged(value: unknown) {
  const first = useRef(value);
  const changed = useRef(false);
  if (first.current !== value) changed.current = true;
  return changed.current;
}

export function useGlow(on: boolean, follow: boolean) {
  const glow = useRef(new Animated.Value(on ? 1 : 0)).current;
  const changed = useChanged(on);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (!changed) return;
    if (!follow || reduceMotion() === true) return void (glow.setValue(on ? 1 : 0), setFading(false));
    if (!on) setFading(true);
    const run = Animated.timing(glow, { toValue: on ? 1 : 0, ...selectionSlide, useNativeDriver: true });
    run.start(({ finished }) => finished && !on && setFading(false));
    return () => run.stop();
  }, [on]);
  return { glow, shown: on || fading };
}

export function useCrossfade(on: boolean, ms: number) {
  const value = useRef(new Animated.Value(on ? 1 : 0)).current;
  const changed = useChanged(on);
  useEffect(() => {
    if (!changed) return;
    const run = Animated.timing(value, { toValue: on ? 1 : 0, duration: ms, easing: curve.enter, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [on]);
  return value;
}
