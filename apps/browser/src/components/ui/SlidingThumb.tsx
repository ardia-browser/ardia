import { useEffect, useRef, type ReactNode } from "react";
import { Animated, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { springs } from "./motion";
import { reduceMotion } from "./reduceMotion";

type Slot = { x: number; width: number };

export function useSlidingThumb(selected: string | null) {
  const slots = useRef(new Map<string, Slot>()).current;
  const x = useRef(new Animated.Value(0)).current;
  const width = useRef(new Animated.Value(0)).current;
  const shown = useRef<string | null>(null);

  const place = (key: string, animate: boolean) => {
    const slot = slots.get(key);
    if (!slot) return;
    shown.current = key;
    if (!animate || reduceMotion()) {
      x.stopAnimation();
      width.stopAnimation();
      x.setValue(slot.x);
      width.setValue(slot.width);
      return;
    }
    Animated.spring(x, { toValue: slot.x, ...springs.snappy, useNativeDriver: true }).start();
    Animated.spring(width, { toValue: slot.width, ...springs.snappy, useNativeDriver: false }).start();
  };

  useEffect(() => {
    if (selected !== null && selected !== shown.current) place(selected, shown.current !== null);
  }, [selected]);

  const measure = (key: string, e: LayoutChangeEvent) => {
    const { x: left, width: size } = e.nativeEvent.layout;
    slots.set(key, { x: left, width: size });
    if (key === selected) place(key, false);
  };

  return { x, width, slots, measure };
}

export function SlidingThumb({
  x,
  width,
  shift,
  style,
  children,
}: {
  x: Animated.Value;
  width: Animated.Value;
  shift?: Animated.Value;
  style: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, transform: [{ translateX: shift ? Animated.add(x, shift) : x }] }}>
      <Animated.View style={[{ flex: 1, width }, style]}>{children}</Animated.View>
    </Animated.View>
  );
}
