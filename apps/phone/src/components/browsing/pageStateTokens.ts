import { iPhoneOr } from "../ui/motion";
import { t } from "../../lib/uiLanguage";


export const loadingPlaceholderLayout = {
  icon: 44,
  iconCorner: 44 * 0.26,
  iconShadow: t(`0px 2px 12px rgba(0,0,0,0.08)`),
  spacing: 12,
  sideInset: 32,
  titleLines: 3,
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  host: { fontSize: 15, lineHeight: 20 },
  themeLightest: 0.94,
  themeInkFlip: 0.55,
  themeInk: { onLight: "rgba(0,0,0,0.85)", onDark: "rgba(255,255,255,0.92)" },
  themeHostInk: { onLight: `rgba(0,0,0,${0.85 * 0.65})`, onDark: `rgba(255,255,255,${0.92 * 0.65})` },
  revealDelayMs: 250,
  revealMs: 150,
} as const;

export const failureButton = {
  filled: iPhoneOr(true, false),
  height: iPhoneOr(50, 40),
  sideInset: iPhoneOr(20, 24),
  fill: { light: "rgba(118,118,128,0.16)", dark: "rgba(120,120,128,0.32)" },
  iconBox: iPhoneOr((36 * 24) / 20, 36),
} as const;
