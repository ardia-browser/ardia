import { Easing } from "react-native-reanimated";
import { capsule, font, iPhoneOr, settingsLayout, space } from "../ui";
import type { Motion } from "../ui/motion";

type Curve = readonly [number, number, number, number];

type TextSize = { fontSize: number; lineHeight: number };

export const onboardingLayout = {
  title: iPhoneOr<TextSize>(font.title, font.largeTitle),
  welcomeTitle: iPhoneOr<TextSize>(font.title, font.hero),
  welcomeSubtitle: iPhoneOr<TextSize>(font.body, font.title3),
  welcomeIconBottom: iPhoneOr(space.xxl, 0),
  welcomeGap: iPhoneOr(0, space.xxl),
  welcomeActionsTop: iPhoneOr(space.xxl, 0),
  illustrationInset: space.l,
  wordsTop: space.xl,
  wordsInset: space.huge,
  wordsGap: space.m,
  actionsTop: space.xxl,
  actionsInset: space.xl + space.xs,
  actionsBottom: space.m,
  actionsGap: space.s,
  rowHeight: 50,
  rowInset: space.l,
  cardInset: space.xs,
  cardRadius: 20,
  cardFill: 0.9,
  cardShadow: "0px 6px 32px rgba(0, 0, 0, 0.06)",
  rowIcons: iPhoneOr(false, true),
  tipIcons: iPhoneOr(false, true),
  secondaryHeight: 44,
  buttonRadius: (height: number) => iPhoneOr(capsule(height), settingsLayout.primaryButton.radius),
} as const;

export const onboardingCurves = {
  step: [0.05, 0.7, 0.1, 1] as Curve,
  rise: [0.2, 0, 0, 1] as Curve,
  easeOut: [0, 0, 0.58, 1] as Curve,
} as const;

const timing = (duration: number, curve: Curve): Motion => ({ timing: { duration, easing: Easing.bezier(...curve) } });

export const onboardingMotion = {
  stepTravel: 72,
  riseDelayMs: 50,
  step: timing(300, onboardingCurves.step),
  stepReduced: timing(150, onboardingCurves.easeOut),
  backdrop: timing(300, onboardingCurves.step),
  backdropReduced: timing(150, onboardingCurves.easeOut),
  rise: timing(360, onboardingCurves.rise),
  riseReduced: timing(300, onboardingCurves.easeOut),
} as const;
