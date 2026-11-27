import { useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions, View, type ViewInstance } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Host, Text as SwiftText } from "@expo/ui/swift-ui";
import { accessibilityHidden, animation, Animation, blur, font, foregroundStyle, frame, multilineTextAlignment, onAppear, opacity, padding, scaleEffect } from "@expo/ui/swift-ui/modifiers";
import { AppIcon, spring, useReduceMotion } from "../ui";
import { KitPrimary } from "./OnboardingKit";
import { brand, welcomeIntro } from "./onboardingTokens";

export const WELCOME_TITLE = "Welcome to Ardia";

function useAfterAppear(delayMs = 0): [boolean, () => void] {
  const [appeared, setAppeared] = useState(false);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!appeared) return;
    const timer = setTimeout(() => setStarted(true), delayMs);
    return () => clearTimeout(timer);
  }, [appeared, delayMs]);
  return [started, () => setAppeared(true)];
}

export function WelcomeIntro({ onStart, headingRef }: { onStart: () => void; headingRef?: (node: ViewInstance | null) => void }) {
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [revealed, titleAppeared] = useAfterAppear(welcomeIntro.appearSettleMs);
  const flight = useSharedValue(reduceMotion ? 1 : 0);
  const shown = useSharedValue(reduceMotion ? 0 : 1);
  const action = useSharedValue(0);
  const iconTop = height * welcomeIntro.iconTopShare - insets.top;
  const fromCenter = height / 2 - insets.top - (iconTop + welcomeIntro.iconSide / 2);

  useEffect(() => {
    if (!revealed) return;
    if (reduceMotion) {
      shown.value = withTiming(1, { duration: welcomeIntro.reducedFadeMs });
      action.value = withDelay(welcomeIntro.reducedFadeMs, withTiming(1, { duration: welcomeIntro.reducedFadeMs }));
      return;
    }
    flight.value = withDelay(welcomeIntro.holdMs, withSpring(1, spring(welcomeIntro.flight.response, welcomeIntro.flight.damping)));
    shown.value = 1;
    action.value = withDelay(welcomeIntro.actionDelayMs, withSpring(1, spring(0.5, 0.9)));
  }, [revealed, reduceMotion, flight, shown, action]);

  const icon = useAnimatedStyle(() => {
    const travel = 1 - flight.value;
    return {
      opacity: shown.value,
      transform: [
        { translateY: fromCenter * travel },
        { scale: 1 + (welcomeIntro.launchScale - 1) * travel },
        { rotate: `${welcomeIntro.wobbleDegrees * Math.sin(Math.min(1, Math.max(0, flight.value)) * Math.PI)}deg` },
      ],
    };
  }, [fromCenter]);
  const start = useAnimatedStyle(() => ({ opacity: action.value, transform: [{ translateY: (1 - action.value) * welcomeIntro.actionRise }] }));
  const sharp = revealed || reduceMotion;

  return (
    <View testID="welcomeIntro" style={styles.fill}>
      <Animated.View testID="welcomeIcon" style={[styles.icon, { top: iconTop }, icon]}>
        <AppIcon side={welcomeIntro.iconSide} shadow scalesWithText={false} />
      </Animated.View>
      <View style={styles.fill} />
      <View ref={headingRef} accessible accessibilityRole="header" accessibilityLabel={WELCOME_TITLE} style={styles.words}>
        <Host matchContents={{ vertical: true }} style={styles.wordsHost} colorScheme="dark">
          <SwiftText
            modifiers={[
              font({ size: welcomeIntro.titleSize, weight: "bold", design: "rounded" }),
              foregroundStyle(brand.cream),
              multilineTextAlignment("center"),
              frame({ maxWidth: welcomeIntro.titleMaxWidth }),
              padding({ all: welcomeIntro.blurRoom }),
              blur(sharp ? 0 : welcomeIntro.titleBlur),
              scaleEffect(sharp ? 1 : welcomeIntro.titleFromScale),
              opacity(sharp ? 1 : 0),
              animation(reduceMotion ? Animation.easeOut({ duration: welcomeIntro.reducedFadeMs / 1000 }) : Animation.smooth({ duration: welcomeIntro.titleS }).delay(welcomeIntro.titleDelayS), sharp),
              accessibilityHidden(true),
              onAppear(titleAppeared),
            ]}
          >
            {WELCOME_TITLE}
          </SwiftText>
        </Host>
      </View>
      <Animated.View testID="onboardingActions" style={[styles.actions, start]}>
        <KitPrimary title="Get Started" onPress={onStart} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  icon: { position: "absolute", alignSelf: "center", zIndex: 1 },
  words: { alignItems: "center", marginBottom: welcomeIntro.wordsBottom },
  wordsHost: { alignSelf: "stretch" },
  actions: { paddingHorizontal: welcomeIntro.actionsInset, paddingBottom: welcomeIntro.actionsBottom },
});
