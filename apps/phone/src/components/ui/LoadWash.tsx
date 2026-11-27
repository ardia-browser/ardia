import { useMemo } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import type { MaterialScheme } from "../../lib/material/schemes";
import { spaceAccentFor } from "./accentRoles";
import { neutralAccent } from "./paletteTokens";
import { useProfileLook } from "./theme";
import { loadWashLayout } from "./tokens";

export type LoadWashValues = { fill: SharedValue<number>; alpha: SharedValue<number> };

export type WashTint = { color: string; alpha: number };

export function useWashTint(incognito: boolean, dark: boolean): WashTint {
  const look = useProfileLook();
  return useMemo(() => {
    if (incognito) return { color: (dark ? neutralAccent.dark : neutralAccent.light).fill, alpha: dark ? loadWashLayout.privateAlpha.dark : loadWashLayout.privateAlpha.light };
    return { color: spaceAccentFor(look, dark).spaceAccentInk, alpha: dark ? loadWashLayout.accentAlpha.dark : loadWashLayout.accentAlpha.light };
  }, [look, incognito, dark]);
}

export const materialWashTint = (scheme: MaterialScheme, isPrivate: boolean): WashTint =>
  isPrivate ? { color: scheme.onSurface, alpha: loadWashLayout.materialPrivateAlpha } : { color: scheme.primary, alpha: loadWashLayout.materialAlpha };

export function LoadWash({ values, tint, cornerRadius, testID }: { values: LoadWashValues; tint: WashTint; cornerRadius: number; testID: string }) {
  const { fill, alpha } = values;
  const width = useSharedValue(0);
  const measured = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    width.value = layout.width;
  };
  const strip = useAnimatedStyle(() => {
    const across = width.value;
    return { opacity: across > 0 ? alpha.value : 0, transform: [{ translateX: (fill.value - 1) * (across + loadWashLayout.feather) }] };
  });
  const solid = withAlpha(tint.color, tint.alpha);
  const feather = useMemo(() => ({ experimental_backgroundImage: `linear-gradient(to right, ${solid}, ${withAlpha(tint.color, 0)})` }), [solid, tint.color]);
  return (
    <View testID={testID} collapsable={false} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={measured} style={[styles.clip, { borderRadius: cornerRadius }]}>
      <Animated.View testID={`${testID}Fill`} collapsable={false} style={[styles.strip, strip]}>
        <View style={[styles.solid, { backgroundColor: solid }]} />
        <View style={[styles.feather, feather]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { ...StyleSheet.absoluteFill, overflow: "hidden", borderCurve: "continuous" },
  strip: { position: "absolute", top: 0, bottom: 0, left: 0, right: -loadWashLayout.feather, flexDirection: "row" },
  solid: { flex: 1 },
  feather: { width: loadWashLayout.feather },
});
