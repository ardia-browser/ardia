import type { MeadowIntro } from "../ui";
import { cssEasing, cssSpring, timeToReach } from "../ui/cssMotion";
import { curve, springs } from "../ui/motion";
import { font, space, weight } from "../ui/tokens";
import { EXIT, INTRO_CUES, LETTER, TAGLINE, WORDMARK } from "./introCues";
import { INTRO_COPY, INTRO_LOOK, INTRO_MUTE } from "./introCopy";
import type { OnboardingColors } from "./tokens";
import { onboardingButton, onboardingMotion, onboardingType } from "./tokens";

const ms = (s: number) => Math.round(s * 1000);

const textOf = (style: { fontSize: number; fontWeight?: string; letterSpacing?: number }) => ({
  fontSize: style.fontSize,
  fontWeight: style.fontWeight ?? weight.regular,
  letterSpacing: style.letterSpacing,
});

export function meadowIntroFor({ colors, muted, startedAt }: { colors: OnboardingColors; muted: boolean; startedAt: number }): MeadowIntro {
  const enter = cssEasing(curve.enter);
  const icon = cssSpring(springs.smooth);
  const press = cssSpring(springs.snappy);
  const skip = onboardingMotion.introSkip;
  return {
    startedAt,
    muted,
    wordmark: WORDMARK,
    tagline: INTRO_COPY.tagline,
    skip: { label: INTRO_COPY.skip, hint: INTRO_COPY.skipHint },
    mute: { mute: INTRO_COPY.mute, unmute: INTRO_COPY.unmute, ...INTRO_MUTE },
    colors: { background: colors.background, buttonBorder: colors.noThanksBorder, buttonText: colors.noThanksText, buttonHover: colors.outlinedHover },
    type: { wordmark: textOf(onboardingType.wordmark), tagline: textOf(onboardingType.tagline), button: textOf({ ...font.body, fontWeight: weight.medium }) },
    layout: {
      gap: space.xl,
      icon: INTRO_LOOK.icon,
      inset: INTRO_LOOK.inset,
      button: onboardingButton.height,
      buttonPad: onboardingButton.secondaryPad,
      iconFrom: INTRO_LOOK.iconFrom,
      iconOpaque: INTRO_LOOK.iconOpaque,
      letterRise: INTRO_LOOK.letterRise,
      taglineRise: INTRO_LOOK.taglineRise,
      exitScale: INTRO_LOOK.exitScale,
      exitHold: INTRO_LOOK.exitHold,
    },
    motion: {
      icon: { delay: ms(INTRO_CUES.icon), ...icon },
      letters: [...WORDMARK].map((_, i) => ({ delay: ms(INTRO_CUES.letters + i * INTRO_CUES.letterStep), duration: ms(LETTER), easing: enter })),
      tagline: { delay: ms(INTRO_CUES.tagline), duration: ms(TAGLINE), easing: enter },
      exit: { delay: ms(INTRO_CUES.exit), duration: ms(EXIT), easing: cssEasing(curve.move) },
      skip: { delay: 0, duration: skip, easing: enter },
      holds: { exit: Math.round(ms(EXIT) * timeToReach(curve.move, INTRO_LOOK.exitHold)), skip: Math.round(skip * timeToReach(curve.enter, INTRO_LOOK.exitHold)) },
      press: { scale: onboardingButton.pressScale, circleScale: onboardingButton.circlePressScale, ...press },
    },
  };
}
