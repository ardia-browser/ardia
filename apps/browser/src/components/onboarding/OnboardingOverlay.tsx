import { WindowDragRegion, VisualEffect } from "../ui";
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { curve, springs } from "../ui/motion";
import { onboardingMotion } from "./tokens";
import { useWindowId } from "../../state/browser/hooks";
import { Intro } from "./Intro";
import { dismissOnboarding, goToStep, useOnboarding } from "../../state/onboarding/onboarding";
import { OnboardingConsentSheet } from "./PluginsStep";
import { OnboardingFlow } from "./OnboardingFlow";
import { ToolTour } from "./tour/ToolTour";
import { useTour } from "../../state/onboarding/tour";
import { useOpenedOnce } from "../ui/useOpenedOnce";
import { useOnboardingColors } from "./Parts";
import { DevResetOnboarding } from "./DevResetOnboarding";
import { coverOrReveal, introCoversScreen, onboardingShowsDesktop } from "./introCover";

export function OnboardingOverlay() {
  const windowId = useWindowId();
  const session = useOnboarding((s) => (s.windowId === windowId ? s.session : null));
  const touring = useOpenedOnce(useTour((s) => s.windowId === windowId && s.stops.length > 0));
  return (
    <>
      {session !== null ? <Overlay key={session} session={session} /> : null}
      {touring ? <ToolTour /> : null}
      {__DEV__ ? <DevResetOnboarding /> : null}
    </>
  );
}

function Overlay({ session }: { session: number }) {
  const colors = useOnboardingColors();
  const windowId = useWindowId();
  const step = useOnboarding((s) => s.step);
  const introCovers = step === "intro" && introCoversScreen();
  const leaving = useOnboarding((s) => s.leaving);
  const presence = useRef(new Animated.Value(0)).current;
  const card = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(presence, { toValue: 1, duration: onboardingMotion.overlayIn, easing: curve.enter, useNativeDriver: true }).start();
  }, []);

  useEffect(() => coverOrReveal(windowId, introCovers, onboardingMotion.introCoverDeadline), [introCovers, windowId]);

  useEffect(() => {
    if (step === "intro") return card.setValue(0);
    Animated.spring(card, { toValue: 1, ...springs.smooth, useNativeDriver: true }).start();
  }, [step === "intro"]);

  useEffect(() => {
    if (!leaving) return;
    Animated.parallel([
      Animated.timing(presence, { toValue: 0, duration: onboardingMotion.overlayOut, easing: curve.exit, useNativeDriver: true }),
      Animated.timing(card, { toValue: 2, duration: onboardingMotion.overlayOut, easing: curve.exit, useNativeDriver: true }),
    ]).start(({ finished }) => finished && dismissOnboarding(session));
  }, [leaving]);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: presence }]}>
      {onboardingShowsDesktop || step === "intro" ? (
        <VisualEffect material="fullScreenUI" blendingMode={onboardingShowsDesktop ? "behindWindow" : "withinWindow"} style={StyleSheet.absoluteFill} />
      ) : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: onboardingShowsDesktop ? colors.overlayOverDesktop : colors.overlay }]} />
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      {step !== "intro" && (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: card.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
              transform: [
                { translateY: card.interpolate({ inputRange: [0, 1, 2], outputRange: [24, 0, 0] }) },
                { scale: card.interpolate({ inputRange: [0, 1, 2], outputRange: [0.97, 1, 1.03] }) },
              ],
            },
          ]}
        >
          <OnboardingFlow key={session} />
        </Animated.View>
      )}
      {step === "intro" && !introCovers && <Intro onDone={() => goToStep("source")} />}
      <OnboardingConsentSheet />
    </Animated.View>
  );
}
