import { faviconLayout, font, space, tabsMotion, type ActionSize, type ActionVariant } from "../ui";
import { iPhoneOr } from "../ui/motion";

const PLACEHOLDER_ICON = 44;

export const loadingPlaceholderLayout = {
  icon: PLACEHOLDER_ICON,
  iconCorner: PLACEHOLDER_ICON * faviconLayout.cornerShare,
  iconShadow: "0px 2px 12px rgba(0,0,0,0.08)",
  spacing: space.m,
  sideInset: space.huge,
  titleLines: 3,
  title: { ...font.body, fontWeight: "600" },
  host: font.subheadline,
  themeLightest: 0.94,
  themeInkFlip: 0.55,
  themeInk: { onLight: "rgba(0,0,0,0.85)", onDark: "rgba(255,255,255,0.92)" },
  themeHostInk: { onLight: `rgba(0,0,0,${0.85 * 0.65})`, onDark: `rgba(255,255,255,${0.92 * 0.65})` },
  revealDelayMs: 250,
  revealMs: tabsMotion.surfaceFade,
} as const;

export const failureRetry = {
  variant: iPhoneOr<ActionVariant>("filled", "outlined"),
  size: iPhoneOr<ActionSize>("regular", "compact"),
  iconBox: iPhoneOr((36 * 24) / 20, 36),
} as const;
