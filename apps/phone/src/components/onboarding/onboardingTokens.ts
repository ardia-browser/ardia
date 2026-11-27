import { Easing } from "react-native-reanimated";
import { departBezier, easeOutBezier, font, iPhoneOr, motionAliases, shape, space, tabsMotion } from "../ui";
import type { Motion } from "../ui/motion";

type Curve = readonly [number, number, number, number];

type TextSize = { fontSize: number; lineHeight: number };

export const onboardingLayout = {
  title: iPhoneOr<TextSize>(font.title, font.largeTitle),
  welcomeTitle: iPhoneOr<TextSize>(font.title, font.hero),
  welcomeSubtitleSize: iPhoneOr<TextSize>(font.body, font.title3),
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
  rowHeight: iPhoneOr(56, 50),
  rowInset: space.l,
  cardInset: space.xs,
  cardRadius: shape.card,
  sketchScale: iPhoneOr(1.22, 1),
  rowIcons: iPhoneOr(false, true),
  startBackdrop: iPhoneOr(true, false),
  phoneDemos: iPhoneOr(true, false),
  plainSharing: iPhoneOr(true, false),
  welcomeSubtitle: iPhoneOr(false, true),
  tipIcons: iPhoneOr(false, true),
  tipGlyph: 20,
  tipGlyphSlot: 28,
  minPage: 560,
  scrollsAboveFontScale: 1.35,
} as const;

export const onboardingInk = {
  light: { welcome: "#FFFFFF", steps: "#F2F2F7", subtitle: "rgba(60,60,67,0.88)" },
  dark: { welcome: "#000000", steps: "#000000", subtitle: "rgba(235,235,245,0.8)" },
} as const;

export type Hour = "dawn" | "morning" | "noon" | "golden" | "dusk";

type HourLook = { sky: { top: string; mid: string; low: string }; hills: { back: string; front: string } };

export const textHalo = { textShadowColor: "rgba(6, 10, 8, 0.55)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 14 } as const;

export const brand = {
  paper: "#FAF2DF",
  ink: "#16130F",
  cream: "#F3E9D6",
  creamMuted: "rgba(243, 233, 214, 0.72)",
  forest: "#1E5141",
  glass: "rgba(243, 233, 214, 0.12)",
  glassEdge: "rgba(243, 233, 214, 0.18)",
} as const;

export const landscape = {
  hours: {
    dawn: { sky: { top: "#919ABB", mid: "#B8A7BD", low: "#F4B08A" }, hills: { back: "#9AA66C", front: "#2C5F4A" } },
    morning: { sky: { top: "#BCCFD9", mid: "#E1E4DC", low: "#F7E5C2" }, hills: { back: "#A6B96C", front: "#1E5141" } },
    noon: { sky: { top: "#AEC7D7", mid: "#D6E0E0", low: "#F4EAD6" }, hills: { back: "#ADC070", front: "#22594A" } },
    golden: { sky: { top: "#B9B0B6", mid: "#E2BFA4", low: "#F8C47C" }, hills: { back: "#B5AB5C", front: "#3B6243" } },
    dusk: { sky: { top: "#5D5281", mid: "#B36871", low: "#EF9070" }, hills: { back: "#7D7563", front: "#2A3D3A" } },
  } satisfies Record<Hour, HourLook>,
  skyStops: [30, 52],
  stepHours: { welcome: 1, blocking: 2, defaultBrowser: 2.5, sync: 3, allSet: 4 },
  sunriseFrom: 0,
  sunriseMs: 2600,
  travelMs: 1100,
  reducedMs: 250,
  view: { width: 400, height: 1000 },
  hills: {
    back: "M-20 430C50 372 130 340 220 352C300 362 360 400 420 440V1000H-20Z",
    front: "M-20 540C70 500 170 478 270 468C330 462 380 458 420 456V1000H-20Z",
  },
  sun: {
    share: 0.2,
    glowShare: 3.2,
    glow: "radial-gradient(circle, rgba(255, 196, 120, 0.55) 0%, rgba(255, 196, 120, 0.22) 38%, rgba(255, 196, 120, 0) 70%)",
    path: [
      { hour: 0, x: 0.2, y: 0.46 },
      { hour: 1, x: 0.2, y: 0.2 },
      { hour: 2, x: 0.84, y: 0.1 },
      { hour: 3, x: 0.86, y: 0.17 },
      { hour: 4, x: 0.84, y: 0.34 },
    ],
  },
  oilOpacity: 0.55,
} as const;

export const meadow = {
  stepHours: { welcome: "sunrise", blocking: "morning", defaultBrowser: "midday", sync: "afternoon", allSet: "golden" },
  fadeInMs: 300,
  reducedFadeMs: 200,
  coverSlackMs: 120,
  scrim: "linear-gradient(180deg, rgba(10, 16, 13, 0) 0%, rgba(10, 16, 13, 0.04) 38%, rgba(10, 16, 13, 0.5) 58%, rgba(10, 16, 13, 0.8) 100%)",
  statusFade: "linear-gradient(180deg, rgba(10, 16, 13, 0.4) 0%, rgba(10, 16, 13, 0.4) 4%, rgba(10, 16, 13, 0.06) 13%, rgba(10, 16, 13, 0) 20%)",
  dawnWash: "linear-gradient(180deg, #919ABB 0%, #B8A7BD 38%, #F4B08A 66%, #6E7A52 74%, #2C3D2A 100%)",
  travelMs: 2400,
} as const;

export const blurStage = {
  radius: 26,
  inS: 0.55,
  inDelayS: 0.12,
  outS: 0.27,
  holdMs: 320,
  reducedS: 0.2,
} as const;

export const blurTitle = {
  size: 30,
  ink: brand.cream,
  maxWidth: 340,
  room: 24,
  blur: 22,
  fromScale: 1.25,
  durationS: 0.85,
  delayS: 0.12,
  reducedS: 0.3,
} as const;

export const colorStep = {
  swatch: 58,
  gap: 22,
  ring: 3,
  ringGap: 4,
  perRow: 3,
  check: 22,
  pressScale: 0.9,
} as const;

export const phoneFrame = {
  width: 236,
  height: 470,
  radius: 40,
  bezel: 7,
  bezelColor: "#FFFFFF",
  screen: "#FFFFFF",
  statusHeight: 30,
  statusInk: "#111111",
  shadow: "0px 24px 60px rgba(0, 0, 0, 0.28)",
} as const;

export const welcomeIntro = {
  appearSettleMs: 60,
  titleMaxWidth: 340,
  iconSide: 76,
  iconTopShare: 0.12,
  launchScale: 2.7,
  holdMs: 380,
  flight: { response: 0.75, damping: 0.72 },
  wobbleDegrees: -10,
  titleSize: 38,
  titleBlur: 26,
  titleFromScale: 1.3,
  titleS: 0.95,
  titleDelayS: 0.6,
  blurRoom: 28,
  wordsBottom: space.xl - 28,
  actionDelayMs: 1250,
  actionRise: 0,
  actionsInset: space.xl + space.xs,
  actionsBottom: space.m,
  reducedFadeMs: 300,
} as const;

export const phoneStage = {
  layer: 1,
  appearMs: 320,
  appearDelayMs: 120,
  vanishGraceMs: 160,
  vanishMs: 220,
  screenOutMs: 220,
  screenInMs: 320,
  reducedOutMs: 150,
  reducedInMs: 200,
} as const;

export const phoneScene = {
  density: 1.35,
  bar: { height: 34, inset: 14, bottom: 12, glyph: 15, plus: 26, shadow: "0px 4px 14px rgba(0, 0, 0, 0.18)" },
  finger: { side: 26, ring: 1.5, pressScale: 0.78, fill: "rgba(110,110,118,0.5)", edge: "rgba(255,255,255,0.95)", shadow: "0px 2px 10px rgba(0, 0, 0, 0.35)" },
  page: { header: 0.27, titleWidth: 0.68, lines: [0.9, 0.78, 0.86, 0.62], line: 5, title: 8, gap: 7, pad: 12 },
  pageShadow: "-6px 0px 16px rgba(0, 0, 0, 0.22)",
  looks: ["plum", "blue", "green", "orange"] as const,
} as const;

export const tipsReel = {
  sceneMs: 3400,
  reducedSceneMs: 3200,
  reducedFrame: 0.9,
  captionGap: space.l,
  captionHeight: 22,
  dotsGap: space.s,
  dot: { width: 22, height: 4, gap: 6, hitSlop: 14 },
  minScale: 0.45,
  maxScale: 0.73,
  tray: { share: 0.6, radius: 20, field: 28, query: "ardia.dev", queryWidth: 47, caret: 12, keyRows: [10, 9, 7], keyHeight: 17, keyGap: 3, rowGap: 5 },
  deck: { widthShare: 0.62, heightShare: 0.58, topShare: 0.15, gap: 10, radius: 16, lift: 0.17 },
  back: { parallax: -0.33, shade: 0.32, edge: 8, dragShare: 0.55 },
  captionInk: brand.cream,
} as const;

export const openLink = {
  loopMs: 4600,
  reducedThreadMs: 1800,
  reducedPageMs: 2600,
  reducedFadeMs: 300,
  minScale: 0.4,
  maxScale: 0.78,
  paper: "#FFFFFF",
  ink: "#111111",
  muted: "rgba(60,60,67,0.6)",
  rule: "rgba(60,60,67,0.18)",
  incoming: "#E9E9EB",
  outgoing: "#0A84FF",
  outgoingInk: "#FFFFFF",
  header: { top: 22, height: 50, avatar: 24, avatarInk: "#FFFFFF", nameSize: 7.5, back: 10, name: "Maya", initial: "M" },
  thread: { top: 84, inset: 10, gap: 6, radius: 13, padX: 9, padY: 5, size: 8.5, line: 11, maxShare: 0.8 },
  messages: { asked: "Dinner tonight?", answered: "Yes! Somewhere good?" },
  card: { width: 118, image: 58, radius: 13, padX: 8, padY: 6, titleSize: 8, titleLine: 10, hostSize: 6.5, tint: "orange", pressScale: 0.96, pressDim: 0.12 },
  compose: { bottom: 12, inset: 10, height: 22, plus: 20, placeholder: "iMessage", size: 7.5 },
  page: { image: 0.3, pad: 12, gap: 6, titleSize: 13, titleLine: 16, hostSize: 7, lines: [0.94, 0.88, 0.97, 0.7, 0.92, 0.84, 0.6], line: 5 },
  link: { title: "The best tapas in Lisbon", host: "timeout.com" },
  timeline: { fingerIn: [0.1, 0.18], reach: [0.18, 0.36], press: [0.36, 0.46], fingerOut: [0.44, 0.5], open: [0.46, 0.64], close: [0.9, 0.98] },
  fingerFrom: { x: 0.72, y: 0.82 },
  parallax: -0.3,
  shade: 0.28,
} as const;

export const onboardingCurves = {
  step: [0.05, 0.7, 0.1, 1] as Curve,
  rise: departBezier as Curve,
  easeOut: easeOutBezier as Curve,
} as const;

const timing = (duration: number, curve: Curve): Motion => ({ timing: { duration, easing: Easing.bezier(...curve) } });

export const onboardingMotion = {
  stepTravel: 72,
  capsuleFirstDelayMs: 1350,
  capsuleFadeMs: 280,
  labelSwapMs: 150,
  capsuleMove: { response: 0.6, damping: 1 },
  capsuleMoveDelayMs: 90,
  riseDelayMs: 50,
  step: motionAliases.onboardingStep,
  stepReduced: motionAliases.onboardingStepReduced,
  rise: timing(360, onboardingCurves.rise),
  riseReduced: timing(300, onboardingCurves.easeOut),
  connectRise: tabsMotion.sheetRise,
  welcomeTilt: { fromDegrees: -18, travelDegrees: 12, reducedDegrees: -6, fromScale: 0.7, wordsRise: 16 },
} as const;
