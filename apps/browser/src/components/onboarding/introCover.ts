import { provideIntroHold } from "../../state/onboarding/introWindow";
import { holdWindowHidden, introCanCoverScreen } from "../../state/onboarding/introCover";
import { reduceMotion } from "../ui/reduceMotion";

export { INTRO_WINDOW_ID } from "../../state/onboarding/introWindow";
export { closeIntroWindow, closeIntroWindowFor, coverOrReveal, handOffFromIntro } from "../../state/onboarding/introCover";

export const onboardingShowsDesktop = introCanCoverScreen;
export const introCoversScreen = () => introCanCoverScreen && reduceMotion() !== true;

provideIntroHold((browserWindowId) => {
  if (introCoversScreen()) holdWindowHidden(browserWindowId);
});
