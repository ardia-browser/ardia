import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { GradientFill, type GradientStop } from "../ui";
import { curve } from "../ui/motion";
import { useEdgeHold } from "./DragProvider";
import type { Edge } from "./dragProfiles";
import { EDGE_GLOW, useSidebarTokens } from "./tokens";

const fadeFrom = (side: Edge): readonly GradientStop[] => (side === "left" ? EDGE_GLOW.fade : EDGE_GLOW.fade.map(([at, alpha]) => [1 - at, alpha] as const).reverse());

export function EdgeGlow() {
  const held = useEdgeHold();
  const tokens = useSidebarTokens();
  const [side, setSide] = useState<Edge | null>(held);
  const opacity = useRef(new Animated.Value(0)).current;
  if (held && held !== side) setSide(held);
  useEffect(() => {
    const motion = Animated.timing(opacity, { toValue: held ? 1 : 0, duration: held ? EDGE_GLOW.inMs : EDGE_GLOW.outMs, easing: curve.fade, useNativeDriver: true });
    motion.start(({ finished }) => finished && !held && setSide(null));
    return () => motion.stop();
  }, [held, opacity]);
  if (!side) return null;
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, width: EDGE_GLOW.width, [side]: 0, opacity }}>
      <GradientFill color={tokens.edgeGlow} stops={EDGE_GLOW.fill} fade={fadeFrom(side)} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}
