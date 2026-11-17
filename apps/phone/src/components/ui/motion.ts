import { Easing, Platform } from "react-native";
import { POOF } from "../../lib/poof";
import { TRAY_LIFT } from "../../lib/trayMotion";
import { Easing as WorkletEasing, withSpring, withTiming, type AnimationCallback, type WithTimingConfig } from "react-native-reanimated";

const onIPhone = Platform.OS === "ios";

export const iPhoneOr = <T,>(iPhone: T, android: T): T => (onIPhone ? iPhone : android);

export const curve = { easeOut: Easing.bezier(0, 0, 0.58, 1) } as const;

export const duration = { resultsIn: iPhoneOr(100, 140), progressFill: iPhoneOr(150, 200), progressFade: iPhoneOr(200, 250), progressAdvance: iPhoneOr(300, 450), toneFade: 250, crossfade: 300 } as const;

export const delay = { progressReveal: iPhoneOr(100, 150) } as const;

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

const arrive = WorkletEasing.bezier(0.05, 0.7, 0.1, 1);
const rise = WorkletEasing.bezier(0.2, 0, 0, 1);

export const tabsMotion = {
  openScale: iPhoneOr<Motion>({ timing: { duration: 190, easing: arrive } }, { spring: progressSpring(0.19, 1) }),
  openPosition: iPhoneOr<Motion>({ timing: { duration: 190, easing: arrive } }, { spring: progressSpring(0.3, 1) }),
  expand: iPhoneOr(progressSpring(0.18, 1), progressSpring(0.3, 1)),
  release: iPhoneOr(spring(0.26, 1), spring(0.3, 0.9)),
  settle: iPhoneOr(spring(0.28, 1), spring(0.4, 1)),
  gapClose: iPhoneOr(spring(0.22, 1), spring(0.4, 0.8)),
  pagerSettle: iPhoneOr(spring(0.26, 1), spring(0.38, 1)),
  fade: iPhoneOr(150, 200),
  flyAway: iPhoneOr(160, 200),
  barTone: iPhoneOr(200, 250),
  menu: 160,
  longPress: 400,
  sheetIn: spring(0.39, 1),
  sheetOut: spring(0.32, 1),
  surfaceFade: iPhoneOr(150, 200),
  barCollapse: iPhoneOr(spring(0.26, 1), spring(0.4, 1)),
  sheetRise: spring(0.42, 0.9),
  sheetDismiss: spring(0.32, 1),
  sheetReduced: 200,
  toneFade: 300,
  barCollapseReduced: 200,
  deckStandby: 600,
} as const;

export const trayMotion = {
  settle: iPhoneOr(spring(0.26, 1), spring(0.34, 0.86)),
  dismiss: iPhoneOr(spring(0.14, 1), spring(0.32, 1)),
  press: iPhoneOr(spring(0.16, 1), spring(0.2, 0.7)),
  dim: iPhoneOr(200, 300),
  dimEasing: iPhoneOr(WorkletEasing.bezier(0, 0, 0.58, 1), WorkletEasing.bezier(0.42, 0, 0.58, 1)),
  reduced: 200,
  resultsIn: iPhoneOr(100, 140),
  modeToggle: iPhoneOr(spring(0.2, 1), spring(0.3, 0.85)),
  rise: iPhoneOr<Motion>({ timing: { duration: 360, easing: rise } }, { spring: spring(0.39, 1) }),
} as const;

export const barReturnMotion = { leaveMs: 100, delayMs: 120, fadeMs: 150, scale: 0.8, shift: 12, back: spring(0.26, 1) } as const;

export const stageMotion = { dimMs: 200, heldLiftGraceMs: 650, settle: spring(0.26, 1) } as const;

export const poofMs = iPhoneOr(POOF.iPhoneDurationMs, POOF.durationMs);

export const trayLandingDelayMs = iPhoneOr(TRAY_LIFT.iPhoneLandingDelayMs, TRAY_LIFT.landingDelayMs);

export const startMotion = { rise: 360, reduced: 200, trayScale: 0.96, pageDot: 200 } as const;

export const deckChromeMotion = { pill: spring(0.2, 1), pillScale: 0.9, chromeShift: spring(0.18, 1), keyboard: 300, archiveScale: 0.96 } as const;

export const pageMenuMotion = { press: spring(0.2, 1), titleFade: 150 } as const;

export const toastMotion = { snappy: spring(0.3, 0.86) } as const;

export const settingsMotion = { swatchRing: spring(0.3, 0.86), titleFade: { stiffness: 1500, damping: 2 * Math.sqrt(1500), mass: 1 } } as const;

export const tabsCurve = { easeOut: WorkletEasing.bezier(0, 0, 0.58, 1), easeInOut: WorkletEasing.bezier(0.42, 0, 0.58, 1), depart: WorkletEasing.bezier(0.2, 0, 0, 1) } as const;

export const springs = {
  barPress: { stiffness: (2 * Math.PI / 0.12) ** 2, damping: 4 * Math.PI * 0.9 / 0.12, mass: 1 },
} as const;

export const reducedMotionMs = (ms: number) => (Platform.OS === "android" ? 0 : ms);
