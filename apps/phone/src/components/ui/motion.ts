import { Easing, Platform } from "react-native";
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

const arrive = WorkletEasing.bezier(0.05, 0.7, 0.1, 1);
const rise = WorkletEasing.bezier(0.2, 0, 0, 1);

const cardOpening: Motion = { timing: { duration: 190, easing: arrive } };

const trayRise: Motion = { timing: { duration: 360, easing: rise } };

export const tabsMotion = {
  openScale: cardOpening,
  openPosition: cardOpening,
  expand: progressSpring(0.18, 1),
  release: spring(0.26, 1),
  settle: spring(0.28, 1),
  gapClose: spring(0.22, 1),
  pagerSettle: spring(0.26, 1),
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
  barCollapse: spring(0.26, 1),
  sheetRise: spring(0.42, 0.9),
  sheetDismiss: spring(0.32, 1),
  sheetReduced: 200,
  toneFade: 300,
  barCollapseReduced: 200,
  deckStandby: 600,
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
  settle: spring(0.26, 1),
  dismiss: spring(0.14, 1),
  press: spring(0.16, 1),
  dim: 200,
  dimEasing: WorkletEasing.bezier(0, 0, 0.58, 1),
  reduced: 200,
  resultsIn: 100,
  modeToggle: spring(0.2, 1),
  rise: trayRise,
} as const;

export const barReturnMotion = { leaveMs: 100, delayMs: 120, fadeMs: 150, scale: 0.8, shift: 12, back: spring(0.26, 1) } as const;

export const stageMotion = { dimMs: 200, heldLiftGraceMs: 650, settle: spring(0.26, 1) } as const;

export const trayLandingDelayMs = TRAY_LIFT.landingDelayMs;

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
