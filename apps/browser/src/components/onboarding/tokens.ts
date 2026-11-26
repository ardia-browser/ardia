import { Easing } from "react-native";
import { duration, period } from "../ui/motion";
import type { Theme } from "../ui/theme";
import { display, font, ink, lineHeight, perLook, proseLineHeight, space, tracking } from "../ui/tokens";

const dark = {
  background: "#000000",
  overlay: "rgba(0,0,0,0.6)",
  overlayOverDesktop: "rgba(0,0,0,0.25)",
  card: "#161616",
  cardOverDesktop: "rgba(22,22,22,0.72)",
  cardBorder: "rgba(255,255,255,0.3)",
  steps: "rgba(255,255,255,0.3)",
  title: "#FFFFFF",
  subtitle: "rgba(255,255,255,0.6)",
  body: "rgba(255,255,255,0.55)",
  footnote: "rgba(255,255,255,0.5)",
  row: "rgba(255,255,255,0.08)",
  rowBorder: "rgba(255,255,255,0.16)",
  rowSubtitle: "rgba(255,255,255,0.6)",
  primary: "rgba(255,255,255,0.85)",
  primaryHover: "rgba(255,255,255,0.9)",
  button: "rgba(255,255,255,0.08)",
  buttonHover: "rgba(255,255,255,0.1)",
  buttonText: "#FFFFFF",
  outlinedHover: "rgba(255,255,255,0.03)",
  noThanksBorder: "rgba(255,255,255,0.2)",
  noThanksText: "rgba(255,255,255,0.5)",
  iconContainer: "rgba(255,255,255,0.15)",
  preview: "rgba(255,255,255,0.04)",
  previewBorder: "rgba(255,255,255,0.1)",
  tile: "rgba(255,255,255,0.06)",
  tileLit: "rgba(255,255,255,0.1)",
  tileBorder: "rgba(255,255,255,0.07)",
  tileBorderSelected: "rgba(255,255,255,0.34)",
  flowGlyph: "rgba(255,255,255,0.75)",
  progressTrack: "rgba(255,255,255,0.12)",
  progressFill: "#FDD023",
  tourScrim: "#00000080",
};

export type OnboardingColors = typeof dark & {
  primaryText: string;
  separator: string;
  checkbox: string;
  checkboxBorder: string;
  checkmark: string;
  stage: string;
};

const light: typeof dark = {
  background: "#FFFFFF",
  overlay: "rgba(255,255,255,0.6)",
  overlayOverDesktop: "rgba(255,255,255,0.2)",
  card: "#FFFFFF",
  cardOverDesktop: "rgba(255,255,255,0.72)",
  cardBorder: "rgba(0,0,0,0.08)",
  steps: "rgba(0,0,0,0.3)",
  title: "#000000",
  subtitle: "rgba(0,0,0,0.53)",
  body: "rgba(0,0,0,0.55)",
  footnote: "rgba(0,0,0,0.5)",
  row: "rgba(0,0,0,0.015)",
  rowBorder: "rgba(0,0,0,0.08)",
  rowSubtitle: "rgba(0,0,0,0.6)",
  primary: "rgba(0,0,0,0.85)",
  primaryHover: "rgba(0,0,0,0.9)",
  button: "rgba(0,0,0,0.08)",
  buttonHover: "rgba(0,0,0,0.1)",
  buttonText: "#000000",
  outlinedHover: "rgba(0,0,0,0.03)",
  noThanksBorder: "rgba(0,0,0,0.1)",
  noThanksText: "rgba(0,0,0,0.5)",
  iconContainer: "rgba(0,0,0,0.03)",
  preview: "rgba(0,0,0,0.025)",
  previewBorder: "rgba(0,0,0,0.07)",
  tile: "rgba(255,255,255,0.9)",
  tileLit: "rgba(0,0,0,0.035)",
  tileBorder: "rgba(0,0,0,0.06)",
  tileBorderSelected: "rgba(0,0,0,0.3)",
  flowGlyph: "rgba(0,0,0,0.6)",
  progressTrack: "rgba(0,0,0,0.08)",
  progressFill: "#FDD023",
  tourScrim: "#0000004D",
};

const byTheme = new WeakMap<Theme, OnboardingColors>();

export function onboardingColorsOf(theme: Theme): OnboardingColors {
  let colors = byTheme.get(theme);
  if (!colors) {
    const roles = {
      primaryText: theme.onPrimary,
      separator: theme.divider,
      checkbox: theme.ringRadioFill,
      checkboxBorder: theme.ringRadioBorder,
      checkmark: theme.onPrimary,
      stage: theme.card,
    };
    byTheme.set(theme, (colors = { ...(theme.dark ? dark : light), ...roles }));
  }
  return colors;
}

export const trafficLights = ["#FF5F57", "#FEBC2E", "#28C840"] as const;

export const anonCard = {
  width: 300,
  height: 430,
  radius: 18,
  inset: 8,
  artHeight: 150,
  artGlyph: 76,
  sheenWidth: 90,
  floatMs: 7000,
  floatEase: Easing.linear,
  perspective: 900,
  swing: ["-14deg", "0deg", "14deg"],
  lift: ["-6deg", "0deg", "6deg"],
  offOpacity: 0.55,
  energy: 11,
  hairline: 1,
  foil: ["#E1E1FE", "#FD02F5"],
  sheen: "#FFFFFF33",
  panel: { dark: "#121214EB", light: "#FFFFFFEB" },
} as const;

export const tourRing = "#FFFFFFB3";

export const onboardingTile = {
  shadow: { color: ink.black, opacity: { dark: 0.3, light: 0.06 }, radius: 10, offset: [0, 3] as [number, number] },
  selectedShadow: { color: ink.black, opacity: { dark: 0.4, light: 0.1 }, radius: 14, offset: [0, 5] as [number, number] },
} as const;

export const onboardingPane = { shadow: { color: ink.black, opacity: { dark: 0.35, light: 0.08 }, radius: 24, offset: [0, 10] as [number, number] } } as const;

export const onboardingFlow = {
  column: 432,
  columnPad: 32,
  titleBar: 46,
  previewBelow: 880,
  gap: 64,
  edge: 32,
  peekOpacity: 0.28,
  peekScale: 0.97,
  paneMargin: 16,
  panePad: 40,
  mockAspect: 1.42,
  mockMaxWidth: 760,
  barHeight: 84,
} as const;

export const onboardingButton = { height: 36, primaryPad: space.xxl, secondaryPad: space.xl, pressScale: 0.98, circlePressScale: 0.96, disabledOpacity: 0.4 } as const;

export const onboardingMotion = {
  busyLabelDelay: 300,
  overlayIn: duration.slow,
  overlayOut: duration.long,
  mockOverlay: duration.slow,
  introSkip: duration.slow,
  introCoverDeadline: 15000,
  tourIn: duration.slow,
  tourOut: duration.base,
  tourPulse: period.pulse,
  swatch: duration.base,
  layoutShift: 300,
  sectionScroll: 600,
  previewSwap: duration.long,
  importFlow: 2400,
  importStagger: 600,
} as const;

export const sectionEase = Easing.bezier(0.5, 1, 0.89, 1);

const ONBOARDING_TYPE = perLook(
  () =>
    ({
      tagline: { ...font.large, fontWeight: "300" },
      stepTitle: { ...display.large, lineHeight: lineHeight.display, fontWeight: "300" },
      stepSubtitle: { ...font.body, lineHeight: proseLineHeight.body },
      postcardHello: { ...display.title, fontWeight: "300", fontStyle: "italic" },
      galleryCaption: { ...font.tiny, lineHeight: lineHeight.tiny, fontWeight: "500" },
      coachCount: { ...font.tiny, fontWeight: "600", letterSpacing: tracking.caps },
      coachTitle: { ...font.title, fontWeight: "600" },
    }) as const,
);

export const onboardingType = {
  wordmark: { ...display.wordmark, fontWeight: "200" },
  get tagline() { return ONBOARDING_TYPE().tagline; },
  get stepTitle() { return ONBOARDING_TYPE().stepTitle; },
  get stepSubtitle() { return ONBOARDING_TYPE().stepSubtitle; },
  get bodyCompact() { return font.small; },
  get postcardHello() { return ONBOARDING_TYPE().postcardHello; },
  get galleryCaption() { return ONBOARDING_TYPE().galleryCaption; },
  get coachCount() { return ONBOARDING_TYPE().coachCount; },
  get coachTitle() { return ONBOARDING_TYPE().coachTitle; },
} as const;

export const CONTENT_WIDTH = 368;

export const TILE_WIDTH = (CONTENT_WIDTH - space.m * 3) / 4;
