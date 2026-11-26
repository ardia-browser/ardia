import { memo, useMemo } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useHoverFill } from "./motion";
import { continuousCorners, ink } from "./tokens";

export const HoverFill = memo(function HoverFill({ shown, color, radius, topLeftRadius, instant = false }: { shown: boolean; color: string; radius: number; topLeftRadius?: number; instant?: boolean }) {
  const opacity = useHoverFill(shown, instant);
  if (!opacity) return null;
  if (topLeftRadius !== undefined && topLeftRadius !== radius) {
    return (
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: "hidden", borderColor: ink.clear, borderTopLeftRadius: topLeftRadius, borderTopRightRadius: radius, borderBottomLeftRadius: radius, borderBottomRightRadius: radius }]}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity }]} />
      </View>
    );
  }
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, continuousCorners(radius), { backgroundColor: color, opacity }]} />;
});

export function HoverSwap({ shown, rest, color, radius, instant = false, underBorder = 0 }: { shown: boolean; rest: string | undefined; color: string; radius: number; instant?: boolean; underBorder?: number }) {
  const opacity = useHoverFill(shown, instant, true);
  const resting = useMemo(() => opacity?.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), [opacity]);
  const frame = { position: "absolute", left: -underBorder, right: -underBorder, top: -underBorder, bottom: -underBorder, ...continuousCorners(radius) } as const;
  if (!opacity) return null;
  return (
    <>
      {rest ? <Animated.View pointerEvents="none" style={[frame, { backgroundColor: rest, opacity: resting }]} /> : null}
      <Animated.View pointerEvents="none" style={[frame, { backgroundColor: color, opacity }]} />
    </>
  );
}
