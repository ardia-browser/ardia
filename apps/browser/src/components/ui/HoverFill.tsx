import { memo, useMemo } from "react";
import { Animated, StyleSheet } from "react-native";
import { useHoverFill } from "./motion";

export const HoverFill = memo(function HoverFill({ shown, color, radius, instant = false }: { shown: boolean; color: string; radius: number; instant?: boolean }) {
  const opacity = useHoverFill(shown, instant);
  if (!opacity) return null;
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: color, opacity }]} />;
});

export function HoverSwap({ shown, rest, color, radius, instant = false, underBorder = 0 }: { shown: boolean; rest: string | undefined; color: string; radius: number; instant?: boolean; underBorder?: number }) {
  const opacity = useHoverFill(shown, instant, true);
  const resting = useMemo(() => opacity?.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), [opacity]);
  const frame = { position: "absolute", left: -underBorder, right: -underBorder, top: -underBorder, bottom: -underBorder, borderRadius: radius } as const;
  if (!opacity) return null;
  return (
    <>
      {rest ? <Animated.View pointerEvents="none" style={[frame, { backgroundColor: rest, opacity: resting }]} /> : null}
      <Animated.View pointerEvents="none" style={[frame, { backgroundColor: color, opacity }]} />
    </>
  );
}
