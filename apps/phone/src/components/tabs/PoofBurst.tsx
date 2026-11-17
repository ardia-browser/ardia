import { useEffect } from "react";
import { Platform, StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { POOF, poofPuff } from "../../lib/poof";
import { poofMs, tabsCurve, tabsInk } from "../ui";

const BLURS = Platform.OS === "android";

export type PoofSpec = { id: number; x: number; y: number; size: number };

export function PoofBurst({ spec }: { spec: PoofSpec }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: poofMs, easing: tabsCurve.easeOut });
  }, []);
  const layer = useAnimatedStyle(() => ({
    opacity: (1 - progress.value) * POOF.opacity,
    ...(BLURS ? { filter: [{ blur: POOF.blurFrom + POOF.blurGrow * progress.value }] } : {}),
  }));
  return (
    <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, layer]}>
      {Array.from({ length: POOF.count + 1 }, (_, index) => (
        <Puff key={index} index={index} spec={spec} progress={progress} />
      ))}
    </Animated.View>
  );
}

function Puff({ index, spec, progress }: { index: number; spec: PoofSpec; progress: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const puff = poofPuff(index, progress.value, spec.size);
    return { left: spec.x + puff.dx - puff.radius, top: spec.y + puff.dy - puff.radius, width: puff.radius * 2, height: puff.radius * 2, borderRadius: puff.radius };
  });
  return <Animated.View style={[styles.puff, { backgroundColor: tabsInk.poof }, style]} />;
}

const styles = StyleSheet.create({ puff: { position: "absolute" } });
