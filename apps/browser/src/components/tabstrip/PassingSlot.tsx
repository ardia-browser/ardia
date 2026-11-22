import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Animated, View } from "react-native";
import { TOGGLE_MS, toggleEase } from "./stripToggle";
import { GAP, TOP_STRIP_HEIGHT } from "./tokens";

export type Passing = { from: number; to: number } | null;

export function PassingSlot({ passing, children }: { passing: Passing; children: ReactNode }) {
  const width = useRef(new Animated.Value(passing?.from ?? 0)).current;
  const span = useRef(1);
  useLayoutEffect(() => {
    if (!passing) return;
    span.current = Math.max(passing.from, passing.to, 1);
    width.setValue(passing.from);
    Animated.timing(width, { toValue: passing.to, duration: TOGGLE_MS, easing: toggleEase, useNativeDriver: false }).start();
  }, [passing?.from, passing?.to]);
  const gapTaken = useMemo(() => width.interpolate({ inputRange: [0, Math.max(passing?.from ?? 0, passing?.to ?? 0, 1)], outputRange: [-GAP, 0], extrapolate: "clamp" }), [passing?.from, passing?.to]);
  return (
    <Animated.View pointerEvents={passing?.to === 0 ? "none" : "box-none"} style={passing ? { width, marginRight: gapTaken, height: TOP_STRIP_HEIGHT, overflow: "hidden" } : PLAIN}>
      <View pointerEvents="box-none" style={passing ? { width: Math.max(passing.from, passing.to), height: TOP_STRIP_HEIGHT, flexDirection: "row" } : PLAIN_ROW}>
        {children}
      </View>
    </Animated.View>
  );
}

const PLAIN = { height: TOP_STRIP_HEIGHT } as const;
const PLAIN_ROW = { height: TOP_STRIP_HEIGHT, flexDirection: "row" } as const;
