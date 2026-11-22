import { StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { PullGlyphs } from "./PagePull";

export const barBaseLook = { fade: 28, fadeAlpha: "E0", solidFromControl: 0.5 } as const;

export function barBaseGradient(color: string, controlTop: number, control: number): { height: number; image: string } {
  const height = controlTop + barBaseLook.fade;
  const eased = (barBaseLook.fade / height) * 100;
  const solid = ((barBaseLook.fade + control * barBaseLook.solidFromControl) / height) * 100;
  const opaque = color.length === 7 ? color : color.slice(0, 7);
  return { height, image: `linear-gradient(to bottom, ${opaque}00 0%, ${opaque}${barBaseLook.fadeAlpha} ${eased.toFixed(1)}%, ${opaque} ${solid.toFixed(1)}%)` };
}

export function BarBase({ color, controlTop, control, fold, foldDrop }: { color: string; controlTop: number; control: number; fold: SharedValue<number>; foldDrop: number }) {
  const { height, image } = barBaseGradient(color, controlTop, control);
  const folded = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(Math.max(fold.value, 0), 1) * foldDrop }] }), [foldDrop]);
  return (
    <PullGlyphs style={[styles.place, { height }]}>
      <Animated.View testID="pageBarBase" pointerEvents="none" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: image }, folded]} />
    </PullGlyphs>
  );
}

const styles = StyleSheet.create({ place: { position: "absolute", left: 0, right: 0, bottom: 0 } });
