import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useRunningDownloads } from "../../state/downloads/running";
import { combinedProgress, indicatorLabel } from "../../state/downloads/runningRules";
import { openDownloadsFromIndicator } from "../../state/page/downloadCards";
import { haptics } from "../../state/app/haptics";
import { tabsMotion, useReduceMotion, useSurfaceInk } from "../ui";
import { downloadIndicatorLayout } from "./downloadIndicatorTokens";

export type DownloadIndicatorPlace = "bar" | "pill";

export function DownloadIndicator({ place = "bar", ink, testID = "downloadIndicator", gesture = false }: { place?: DownloadIndicatorPlace; ink?: string; testID?: string; gesture?: boolean }) {
  const shown = useRunningDownloads((s) => s.indicatorShown);
  if (!shown) return null;
  return <ShownIndicator place={place} ink={ink} testID={testID} gesture={gesture} />;
}

function ShownIndicator({ place, ink, testID, gesture }: { place: DownloadIndicatorPlace; ink?: string; testID: string; gesture: boolean }) {
  const plate = useSurfaceInk().chrome.foreground;
  const rows = useRunningDownloads((s) => s.running);
  const reduceMotion = useReduceMotion();
  const progress = combinedProgress(rows);
  const look = downloadIndicatorLayout[place];
  const Press = (gesture ? GesturePressable : Pressable) as typeof Pressable;
  return (
    <Animated.View entering={reduceMotion ? undefined : INDICATOR_IN} exiting={reduceMotion ? undefined : INDICATOR_OUT} style={[styles.slot, { width: look.slot }]}>
      <Press
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={indicatorLabel(rows.length, progress)}
        accessibilityHint="Opens Downloads."
        accessibilityLiveRegion="polite"
        hitSlop={look.slop}
        onPressIn={haptics.barPress}
        onPress={openDownloadsFromIndicator}
        style={({ pressed }) => [styles.hit, pressed ? styles.pressed : null]}
      >
        <DownloadRing progress={progress} size={look.ring} stroke={look.stroke} color={ink ?? plate} reduceMotion={reduceMotion} />
      </Press>
    </Animated.View>
  );
}

export function DownloadRing({ progress, size, stroke, color, reduceMotion }: { progress: number | null; size: number; stroke: number; color: string; reduceMotion: boolean }) {
  const turn = useSharedValue(0);
  const spins = progress === null && !reduceMotion;
  useEffect(() => {
    if (!spins) {
      cancelAnimation(turn);
      turn.value = 0;
      return;
    }
    turn.value = 0;
    turn.value = withRepeat(withTiming(1, { duration: downloadIndicatorLayout.spinMs, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [spins]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  const radius = (size - stroke) / 2;
  const around = 2 * Math.PI * radius;
  const shown = progress === null ? downloadIndicatorLayout.indeterminateShare : Math.min(1, Math.max(0, progress));
  const centre = size / 2;
  const arrow = size * downloadIndicatorLayout.arrowShare;
  const top = centre - arrow / 2;
  const bottom = centre + arrow / 2;
  const wing = arrow * downloadIndicatorLayout.wingShare;
  return (
    <View testID="downloadRing" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={centre} cy={centre} r={radius} stroke={color} strokeOpacity={downloadIndicatorLayout.trackOpacity} strokeWidth={stroke} fill="none" />
        <Path d={`M${centre} ${top}L${centre} ${bottom}M${centre - wing} ${bottom - wing}L${centre} ${bottom}L${centre + wing} ${bottom - wing}`} stroke={color} strokeWidth={stroke * downloadIndicatorLayout.arrowStroke} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, spin]}>
        <Svg width={size} height={size}>
          <Circle testID="downloadRingArc" cx={centre} cy={centre} r={radius} stroke={color} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={`${around} ${around}`} strokeDashoffset={around * (1 - shown)} transform={`rotate(-90 ${centre} ${centre})`} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const INDICATOR_IN = FadeIn.duration(tabsMotion.surfaceFade);
const INDICATOR_OUT = FadeOut.duration(tabsMotion.surfaceFade);

const styles = StyleSheet.create({
  slot: { alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  hit: { alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.5 },
});
