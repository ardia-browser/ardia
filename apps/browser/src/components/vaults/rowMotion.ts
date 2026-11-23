import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import { curve } from "../ui";

function useChanged(value: unknown) {
  const first = useRef(value);
  const changed = useRef(false);
  if (first.current !== value) changed.current = true;
  return changed.current;
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
