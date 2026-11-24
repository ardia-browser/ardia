import { Easing, Platform } from "react-native";
import { CARD_MOVE_RESPONSE, GLASS_FADE_MS, SETTLE_RESPONSE } from "../../lib/sharedMotion";
import { TRAY_LIFT } from "../../lib/trayMotion";
import { Easing as WorkletEasing, withSpring, withTiming, type AnimationCallback, type WithTimingConfig } from "react-native-reanimated";

const onIPhone = Platform.OS === "ios";

export const iPhoneOr = <T,>(iPhone: T, android: T): T => (onIPhone ? iPhone : android);

export const curve = { easeOut: Easing.bezier(0, 0, 0.58, 1) } as const;

export const duration = { resultsIn: 100, progressFill: 150, progressFade: 200, progressAdvance: 300, toneFade: 250, crossfade: 300 } as const;

export const delay = { progressReveal: 100 } as const;

export const spring = (response: number, dampingFraction: number) => {
  const stiffness = (2 * Math.PI / response) ** 2;
  return { stiffness, damping: 2 * dampingFraction * Math.sqrt(stiffness), mass: 1 };
};

export const COMPOSE_PROGRESS_SETTLE = 1e-4;

export const progressSpring = (response: number, dampingFraction: number) => ({ ...spring(response, dampingFraction), energyThreshold: COMPOSE_PROGRESS_SETTLE });

type SpringConfig = ReturnType<typeof spring> & { energyThreshold?: number };

export type Motion = { spring: SpringConfig } | { timing: { duration: number; easing: NonNullable<WithTimingConfig["easing"]> } };

export function moveTo(target: number, motion: Motion, done?: AnimationCallback): number {
  "worklet";
  return "timing" in motion ? withTiming(target, motion.timing, done) : withSpring(target, motion.spring, done);
}

const rise = WorkletEasing.bezier(0.2, 0, 0, 1);

export const glassFadeMs = GLASS_FADE_MS;

const settleSpring = spring(SETTLE_RESPONSE, 1);

const cardMove = progressSpring(CARD_MOVE_RESPONSE, 1);

const cardOpening: Motion = { spring: cardMove };

const trayRise: Motion = { timing: { duration: 360, easing: rise } };

export const tabsMotion = {
  openScale: cardOpening,
  openPosition: cardOpening,
  expand: cardMove,
  release: settleSpring,
  settle: settleSpring,
  gapClose: settleSpring,
  pagerSettle: settleSpring,
  pagerPeek: 260,
  pagerArrive: 90,
  fade: 150,
  sideLeave: 90,
  flyAway: 160,
  cardFlyAway: 0.32,
  barTone: 200,
  menu: 160,
  longPress: 400,
  sheetIn: spring(0.39, 1),
  sheetOut: spring(0.32, 1),
  surfaceFade: 150,
  barCollapse: settleSpring,
  sheetRise: spring(0.42, 0.9),
  sheetDismiss: spring(0.32, 1),
  sheetReduced: 200,
  toneFade: 300,
  barCollapseReduced: 200,
  deckStandby: 500,
  deckStandbyIdle: 200,
} as const;

export const menuMotion = {
  open: spring(0.3, 1),
  fromScale: 0.18,
  contentFade: 67,
  glassFade: 33,
  close: 200,
  heldOpen: 280,
  heldClose: 270,
  sheetOut: 270,
} as const;

export const trayMotion = {
  settle: settleSpring,
  dismiss: spring(0.14, 1),
  press: spring(0.16, 1),
  dim: 200,
  dimEasing: WorkletEasing.bezier(0, 0, 0.58, 1),
  reduced: 200,
  resultsIn: 100,
  modeToggle: spring(0.2, 1),
  rise: trayRise,
} as const;

export const barReturnMotion = { leaveMs: 100, fadeMs: glassFadeMs, shift: 12 } as const;

export const stageMotion = { dimMs: 200, heldLiftGraceMs: 650, settle: settleSpring } as const;

export const trayLandingDelayMs = TRAY_LIFT.landingDelayMs;

export const startMotion = { rise: 360, reduced: 200, trayScale: 0.96, pageDot: 200 } as const;

export const deckChromeMotion = { pillScale: 0.9, keyboard: 300, archiveScale: 0.96 } as const;

export const pageMenuMotion = { titleFade: 150 } as const;

export const scanMotion = { cameraStopMs: 120 } as const;

export const toastMotion = { snappy: spring(0.3, 1) } as const;

export const snapSpring = { stiffness: 1500, damping: 2 * Math.sqrt(1500), mass: 1 } as const;

export const settingsMotion = { swatchRing: spring(0.3, 0.86), titleFade: snapSpring } as const;

export const departBezier = [0.2, 0, 0, 1] as const;

export const tabsCurve = { easeOut: WorkletEasing.bezier(0, 0, 0.58, 1), easeInOut: WorkletEasing.bezier(0.42, 0, 0.58, 1), depart: WorkletEasing.bezier(...departBezier) } as const;

export const easeOutBezier = [0, 0, 0.58, 1] as const;

const stepBezier = [0.05, 0.7, 0.1, 1] as const;

export const motionAliases = {
  hostPillEase: tabsCurve.easeOut,
  loadingRevealEase: tabsCurve.easeOut,
  voiceTranscriptFadeMs: tabsMotion.surfaceFade,
  voiceWaveEaseMs: duration.resultsIn,
  readerTextSize: snapSpring,
  settingsTitleFade: snapSpring,
  onboardingStep: { timing: { duration: 300, easing: WorkletEasing.bezier(...stepBezier) } } as Motion,
  onboardingStepReduced: { timing: { duration: 150, easing: WorkletEasing.bezier(...easeOutBezier) } } as Motion,
  toggleKnob: spring(0.12, 1),
  toggleKnobReducedMs: 0,
} as const;

export const reducedMotionMs = (ms: number) => (Platform.OS === "android" ? 0 : ms);
