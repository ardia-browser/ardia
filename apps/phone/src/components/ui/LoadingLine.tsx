import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { delay, duration, tabsCurve } from "./motion";
import { useTheme } from "./theme";
import { browseLayout } from "./tokens";

export type LoadWatch = (show: (progress: number, isLoading: boolean) => void) => () => void;

export function LoadingLine({ watch }: { watch: LoadWatch }) {
  const color = useTheme().spaceAccentInk;
  const fraction = useSharedValue(0);
  const alpha = useSharedValue(0);

  useEffect(() => {
    let loading: boolean | null = null;
    return watch((progress, isLoading) => {
      if (isLoading) {
        if (loading !== true) alpha.value = withDelay(delay.progressReveal, withTiming(1, { duration: duration.progressFill, easing: tabsCurve.easeOut }));
        loading = true;
        fraction.value = withTiming(Math.max(0.1, progress), { duration: duration.progressAdvance, easing: tabsCurve.easeOut });
        return;
      }
      if (loading === null) {
        loading = false;
        return;
      }
      if (loading === false) return;
      loading = false;
      cancelAnimation(alpha);
      fraction.value = withTiming(1, { duration: duration.progressFill, easing: tabsCurve.easeOut }, (filled) => {
        if (!filled) return;
        alpha.value = withTiming(0, { duration: duration.progressFade, easing: tabsCurve.easeOut }, (faded) => {
          if (faded) fraction.value = 0;
        });
      });
    });
  }, [alpha, fraction, watch]);

  const lineStyle = useAnimatedStyle(() => ({ opacity: alpha.value, transform: [{ scaleX: fraction.value }] }));

  return (
    <View testID="loadingLine" style={styles.track} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.line, { backgroundColor: color }, lineStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: browseLayout.progressHeight, width: "100%" },
  line: { height: browseLayout.progressHeight, width: "100%", transformOrigin: "left" },
});
