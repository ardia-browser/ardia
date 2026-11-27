import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { meadowIsNative, PhoneMeadow, type MeadowHour } from "@ardia/phone-native";

type StepHour = MeadowHour | "sunrise";
import type { OnboardingStep } from "../../state/settings/settingsRules";
import { useReduceMotion } from "../ui";
import { Landscape } from "./Landscape";
import { meadow } from "./onboardingTokens";

type MeadowState = "loading" | "ready" | "failed";

export const meadowHourOf = (step: OnboardingStep): StepHour => meadow.stepHours[step];

export function MeadowBackdrop({ step }: { step: OnboardingStep }) {
  const reduceMotion = useReduceMotion();
  const [state, setState] = useState<MeadowState>(meadowIsNative() ? "loading" : "failed");
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    if (state !== "ready") return;
    const timer = setTimeout(() => setCovered(true), (reduceMotion ? meadow.reducedFadeMs : meadow.fadeInMs) + meadow.coverSlackMs);
    return () => clearTimeout(timer);
  }, [state, reduceMotion]);
  const live = useAnimatedStyle(() => ({ opacity: withTiming(state === "ready" ? 1 : 0, { duration: reduceMotion ? meadow.reducedFadeMs : meadow.fadeInMs }) }), [state, reduceMotion]);
  return (
    <View testID="onboardingMeadow" pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {state === "failed" ? <Landscape step={step} /> : covered ? null : <View testID="meadowCover" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: meadow.dawnWash }]} />}
      {state === "failed" ? null : (
        <Animated.View style={[StyleSheet.absoluteFill, live]}>
          <PhoneMeadow hour={meadowHourOf(step)} travelMs={meadow.travelMs} onMeadow={(event) => setState(event.nativeEvent.state)} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: meadow.scrim }]} />
        </Animated.View>
      )}
      <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: meadow.statusFade }]} />
    </View>
  );
}
