import { createContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, type View } from "react-native";
import { usePeekLeaving, usePeekSpan, type PeekSpan } from "../../state/windows/dockMotion";
import { curve, duration } from "../ui/motion";

type Overlaps = { left: number; right: number };

const CLEAR: Overlaps = { left: 0, right: 0 };

const within = (value: number, most: number) => Math.min(Math.max(value, 0), most);

export function peekOverlaps(span: PeekSpan | undefined, x: number, width: number): Overlaps {
  if (!span) return CLEAR;
  return {
    left: span[0] <= x ? within(span[1] - x, width) : 0,
    right: span[1] >= x + width ? within(x + width - span[0], width) : 0,
  };
}

const slide = (value: Animated.Value, to: number) => Animated.timing(value, { toValue: to, duration: duration.base, easing: curve.enter, useNativeDriver: true });

export function usePeekClearance(windowId: string, page: RefObject<View | null>) {
  const span = usePeekSpan(windowId);
  const leaving = usePeekLeaving(windowId);
  const left = useRef(new Animated.Value(0)).current;
  const right = useRef(new Animated.Value(0)).current;
  const [coversLeft, setCoversLeft] = useState(false);
  useEffect(() => {
    let current = true;
    const settle = (overlaps: Overlaps) => {
      if (!current) return;
      setCoversLeft(overlaps.left > 0);
      Animated.parallel([slide(left, overlaps.left), slide(right, -overlaps.right)]).start();
    };
    if (!span || leaving || !page.current) settle(CLEAR);
    else page.current.measureInWindow((x, _y, width) => settle(peekOverlaps(span, x, width)));
    return () => void (current = false);
  }, [span, leaving]);
  const leftShift = useMemo(() => ({ transform: [{ translateX: left }] }), [left]);
  const rightShift = useMemo(() => ({ transform: [{ translateX: right }] }), [right]);
  return { leftShift, rightShift, coversLeft };
}

export const PeekCoversCards = createContext(false);
