import { useState } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../ui/theme";
import { space } from "../ui/tokens";
import { curve, duration } from "../ui/motion";

export const SCROLL_EDGE = { gap: space.xs, line: 1, inset: 1 } as const;
const FADE = { duration: duration.fast, easing: curve.fade };

const SCROLLED_PAST = 0.5;

export type ScrollSpan = { offset: number; viewport: number; content: number };

export function scrolledPastTop(offset: number): boolean {
  return offset >= SCROLLED_PAST;
}

export function hiddenBelow({ offset, viewport, content }: ScrollSpan): boolean {
  return viewport > 0 && offset + viewport < content - 1;
}

function fadingEdge() {
  const opacity = new Animated.Value(0);
  let shown = false;
  return {
    opacity,
    show(next: boolean) {
      if (next === shown) return;
      shown = next;
      Animated.timing(opacity, { toValue: next ? 1 : 0, ...FADE, useNativeDriver: true }).start();
    },
  };
}

export function useScrollEdge() {
  const [edge] = useState(() => {
    const fade = fadingEdge();
    return { opacity: fade.opacity, follow: (offset: number) => fade.show(scrolledPastTop(offset)) };
  });
  return edge;
}

export function useScrollEdgeBelow() {
  const [edge] = useState(() => {
    const fade = fadingEdge();
    const span: ScrollSpan = { offset: 0, viewport: 0, content: 0 };
    return {
      opacity: fade.opacity,
      measure(next: Partial<ScrollSpan>) {
        Object.assign(span, next);
        fade.show(hiddenBelow(span));
      },
    };
  });
  return edge;
}

export function ScrollEdgeLine({ opacity, style }: { opacity: Animated.Value; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return <Animated.View pointerEvents="none" style={[{ height: SCROLL_EDGE.line, backgroundColor: theme.divider, opacity }, style]} />;
}
