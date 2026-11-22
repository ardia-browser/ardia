import { useEffect, useState } from "react";
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

export type EdgeSeen = { seen: () => boolean; onSeen: (listener: () => void) => () => void };

function fadingEdge() {
  const opacity = new Animated.Value(0);
  let shown = false;
  let seen = false;
  const listeners = new Set<() => void>();
  return {
    opacity,
    seen: () => seen,
    onSeen(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    show(next: boolean) {
      if (next === shown) return;
      shown = next;
      if (next && !seen) {
        seen = true;
        for (const listener of listeners) listener();
      }
      Animated.timing(opacity, { toValue: next ? 1 : 0, ...FADE, useNativeDriver: true }).start();
    },
  };
}

export function useScrollEdge() {
  const [edge] = useState(() => {
    const fade = fadingEdge();
    return { opacity: fade.opacity, seen: fade.seen, onSeen: fade.onSeen, follow: (offset: number) => fade.show(scrolledPastTop(offset)) };
  });
  return edge;
}

export function useScrollEdgeBelow() {
  const [edge] = useState(() => {
    const fade = fadingEdge();
    const span: ScrollSpan = { offset: 0, viewport: 0, content: 0 };
    return {
      opacity: fade.opacity,
      seen: fade.seen,
      onSeen: fade.onSeen,
      measure(next: Partial<ScrollSpan>) {
        Object.assign(span, next);
        fade.show(hiddenBelow(span));
      },
    };
  });
  return edge;
}

export function ScrollEdgeLine({ opacity, style, edge }: { opacity: Animated.Value; style?: StyleProp<ViewStyle>; edge?: EdgeSeen }) {
  const theme = useTheme();
  const [seen, setSeen] = useState(() => !edge || edge.seen());
  useEffect(() => {
    if (seen || !edge) return;
    if (edge.seen()) return void setSeen(true);
    return edge.onSeen(() => setSeen(true));
  }, [edge, seen]);
  if (!seen) return null;
  return <Animated.View pointerEvents="none" style={[{ height: SCROLL_EDGE.line, backgroundColor: theme.divider, opacity }, style]} />;
}
