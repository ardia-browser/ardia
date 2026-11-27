import { useEffect } from "react";
import { Image, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import type { OnboardingStep } from "../../state/settings/settingsRules";
import { useReduceMotion } from "../ui";
import { landscape, type Hour } from "./onboardingTokens";

const SUN = require("../../../assets/onboarding/sun.png") as number;
const IMPASTO = require("../../../assets/onboarding/impasto.webp") as number;

const HOURS = landscape.hours;
const HOUR_KEYS = Object.keys(HOURS) as Hour[];

export const hourOfStep = (step: OnboardingStep): number => landscape.stepHours[step];

const skyCss = (hour: Hour) => {
  const { top, mid, low } = HOURS[hour].sky;
  return `linear-gradient(180deg, ${top} 0%, ${mid} ${landscape.skyStops[0]}%, ${low} ${landscape.skyStops[1]}%)`;
};

function Layer({ clock, at, index, children }: { clock: SharedValue<number>; at: number; index: number; children: React.ReactNode }) {
  const shown = useAnimatedStyle(() => ({ opacity: index === 0 ? 1 : Math.min(1, Math.max(0, clock.value - (at - 1))) }), [at, index]);
  return <Animated.View style={[StyleSheet.absoluteFill, shown]}>{children}</Animated.View>;
}

export function Landscape({ step }: { step: OnboardingStep }) {
  const reduceMotion = useReduceMotion();
  const { width, height } = useWindowDimensions();
  const target = hourOfStep(step);
  const hour = useSharedValue(step === "welcome" && !reduceMotion ? landscape.sunriseFrom : target);

  useEffect(() => {
    const first = step === "welcome" && hour.value < target;
    hour.value = withTiming(target, {
      duration: reduceMotion ? landscape.reducedMs : first ? landscape.sunriseMs : landscape.travelMs,
      easing: Easing.inOut(Easing.cubic),
    });
  }, [target, reduceMotion, hour, step]);

  const sunSide = width * landscape.sun.share;
  const glowSide = sunSide * landscape.sun.glowShare;
  const sun = useAnimatedStyle(() => {
    const at = hour.value;
    const x = interpolate(at, landscape.sun.path.map((point) => point.hour), landscape.sun.path.map((point) => point.x)) * width;
    const y = interpolate(at, landscape.sun.path.map((point) => point.hour), landscape.sun.path.map((point) => point.y)) * height;
    return { transform: [{ translateX: x - glowSide / 2 }, { translateY: y - glowSide / 2 }] };
  }, [width, height, glowSide]);

  return (
    <View testID="onboardingLandscape" pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {HOUR_KEYS.map((key, index) => (
        <Layer key={`sky-${key}`} clock={hour} at={index} index={index}>
          <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: skyCss(key) }]} />
        </Layer>
      ))}
      <Animated.View style={[styles.sunSlot, { width: glowSide, height: glowSide }, sun]}>
        <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: landscape.sun.glow }]} />
        <Image source={SUN} style={{ width: sunSide, height: sunSide }} resizeMode="contain" />
      </Animated.View>
      {HOUR_KEYS.map((key, index) => (
        <Layer key={`hills-${key}`} clock={hour} at={index} index={index}>
          <Svg width={width} height={height} viewBox={`0 0 ${landscape.view.width} ${landscape.view.height}`} preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
            <Path d={landscape.hills.back} fill={HOURS[key].hills.back} />
            <Path d={landscape.hills.front} fill={HOURS[key].hills.front} />
          </Svg>
        </Layer>
      ))}
      <Image source={IMPASTO} resizeMode="repeat" style={[StyleSheet.absoluteFill, styles.oil]} />
    </View>
  );
}

const styles = StyleSheet.create({
  sunSlot: { position: "absolute", left: 0, top: 0, alignItems: "center", justifyContent: "center" },
  oil: { width: "100%", height: "100%", mixBlendMode: "soft-light", opacity: landscape.oilOpacity },
});
