import { t } from "../../lib/uiLanguage";
export const INTRO_COPY = {
  tagline: t(`Your new home on the internet`),
  skip: t(`Skip`),
  skipHint: t(`Button that skips the onboarding intro animation`),
  mute: t(`Mute intro music`),
  unmute: t(`Unmute intro music`),
} as const;

export const INTRO_LOOK = {
  icon: 96,
  inset: 28,
  iconFrom: 0.6,
  iconOpaque: 0.4,
  letterRise: 14,
  taglineRise: 6,
  exitScale: 1.08,
  exitHold: 0.6,
} as const;

export const INTRO_MUTE = {
  mutedIcon: "speaker.slash.fill",
  playingIcon: "speaker.wave.3.fill",
  iconSize: 13,
  iconWeight: "medium",
  iconBox: 20,
} as const;
