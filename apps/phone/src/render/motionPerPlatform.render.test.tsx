import { barReturnMotion, duration, menuMotion, motionAliases, spring, stageMotion, tabsMotion, toastMotion, trayLandingDelayMs, trayMotion } from "../components/ui";
import { hostPillLayout } from "../components/browsing/hostPillTokens";
import { DECK_PULL, DECK_PULL_SPRING } from "../lib/deckPull";
import { CARD_MOVE_RESPONSE } from "../lib/sharedMotion";
import { delay } from "../components/ui/motion";
import { loadingPlaceholderLayout } from "../components/browsing/pageStateTokens";
import { onboardingMotion } from "../components/onboarding/onboardingTokens";
import { OPENING_CARD_RESPONSE } from "../components/tabs/DeckCard";

const response = (config: { stiffness: number }) => Math.round((2 * Math.PI) / Math.sqrt(config.stiffness) * 1000) / 1000;
const damping = (config: { stiffness: number; damping: number }) => Math.round((config.damping / (2 * Math.sqrt(config.stiffness))) * 100) / 100;
const asSpring = (config: { stiffness: number; damping: number }) => [response(config), damping(config)];

const springs = {
  "card open (tabsMotion.expand)": [tabsMotion.expand, [0.15, 1]],
  "card release (tabsMotion.release)": [tabsMotion.release, [0.26, 1]],
  "deck scroll settle (tabsMotion.settle)": [tabsMotion.settle, [0.26, 1]],
  "gap close (tabsMotion.gapClose)": [tabsMotion.gapClose, [0.26, 1]],
  "pager settle (tabsMotion.pagerSettle)": [tabsMotion.pagerSettle, [0.26, 1]],
  "bar collapse (tabsMotion.barCollapse)": [tabsMotion.barCollapse, [0.26, 1]],
  "panel settle (trayMotion.settle)": [trayMotion.settle, [0.26, 1]],
  "panel dismiss (trayMotion.dismiss)": [trayMotion.dismiss, [0.14, 1]],
  "row press (trayMotion.press)": [trayMotion.press, [0.16, 1]],
  "incognito label (trayMotion.modeToggle)": [trayMotion.modeToggle, [0.2, 1]],
  "menu open (menuMotion.open)": [menuMotion.open, [0.3, 1]],
} as const;

for (const [name, [config, expected]] of Object.entries(springs)) {
  test(`${name} is main's SwiftUI spring on both phones, with no bounce`, () => {
    expect(asSpring(config)).toEqual(expected);
  });
}

test("a page and its card move on one critically damped 0.15 spring every way: deck open, card open, the pull's landing and growth", () => {
  for (const motion of [tabsMotion.openScale, tabsMotion.openPosition]) {
    if (!("spring" in motion)) throw new Error("the deck open is a spring");
    expect(asSpring(motion.spring)).toEqual([CARD_MOVE_RESPONSE, 1]);
  }
  expect(asSpring(tabsMotion.expand)).toEqual([CARD_MOVE_RESPONSE, 1]);
  expect(asSpring(DECK_PULL_SPRING.land)).toEqual([CARD_MOVE_RESPONSE, 1]);
  expect(asSpring(DECK_PULL_SPRING.grow)).toEqual([CARD_MOVE_RESPONSE, 1]);
  expect(OPENING_CARD_RESPONSE).toBe(CARD_MOVE_RESPONSE);
});

test("every settle is the one 0.26 spring and every glass fades over the one 150 ms, so nothing on screen runs on its own clock", () => {
  const settles = [tabsMotion.settle, tabsMotion.release, tabsMotion.gapClose, tabsMotion.pagerSettle, tabsMotion.barCollapse, trayMotion.settle, stageMotion.settle];
  for (const settle of settles) expect(settle).toBe(tabsMotion.settle);
  expect([barReturnMotion.fadeMs, hostPillLayout.glassMs, DECK_PULL.barBackMs]).toEqual([150, 150, 150]);
});

test("toasts move, scale and fade on a critically damped spring, with no bounce", () => {
  expect(asSpring(toastMotion.snappy)).toEqual([0.3, 1]);
});

test("the search panel rises on SwiftUI's 360 ms rise curve on both phones", () => {
  expect(trayMotion.rise).toEqual({ timing: expect.objectContaining({ duration: 360 }) });
});

test("fades, flights and waits are SwiftUI's lengths on both phones", () => {
  const lengths = {
    fade: tabsMotion.fade,
    flyAway: tabsMotion.flyAway,
    barTone: tabsMotion.barTone,
    surfaceFade: tabsMotion.surfaceFade,
    trayDim: trayMotion.dim,
    resultsIn: trayMotion.resultsIn,
    panelLanding: trayLandingDelayMs,
    progressFill: duration.progressFill,
    progressFade: duration.progressFade,
    progressAdvance: duration.progressAdvance,
    progressReveal: delay.progressReveal,
    placeholderRevealDelay: loadingPlaceholderLayout.revealDelayMs,
    placeholderReveal: loadingPlaceholderLayout.revealMs,
    openingCardResponse: OPENING_CARD_RESPONSE,
  };
  expect(lengths).toEqual({ fade: 150, flyAway: 160, barTone: 200, surfaceFade: 150, trayDim: 200, resultsIn: 100, panelLanding: 220, progressFill: 150, progressFade: 200, progressAdvance: 300, progressReveal: 100, placeholderRevealDelay: 250, placeholderReveal: 150, openingCardResponse: 0.15 });
  expect(spring(1, 1).mass).toBe(1);
});

test("onboarding moves on SwiftUI's timed curves on both phones: 300 ms steps over 72 points, a 360 ms rise after 50 ms, the step and backdrop on the one shared step alias", () => {
  expect(onboardingMotion.stepTravel).toBe(72);
  expect(onboardingMotion.riseDelayMs).toBe(50);
  expect(onboardingMotion.step).toEqual({ timing: expect.objectContaining({ duration: 300 }) });
  expect(onboardingMotion.rise).toEqual({ timing: expect.objectContaining({ duration: 360 }) });
  expect(onboardingMotion.step).toBe(motionAliases.onboardingStep);
  expect(onboardingMotion.stepReduced).toBe(motionAliases.onboardingStepReduced);
  expect(Object.keys(onboardingMotion)).not.toEqual(expect.arrayContaining(["backdrop", "backdropReduced"]));
  expect([onboardingMotion.stepReduced, onboardingMotion.riseReduced]).toEqual([150, 300].map((ms) => ({ timing: expect.objectContaining({ duration: ms }) })));
});

test("a closed card flies off on main's fly-away spring on both phones: response 0.32 with no bounce, and the gap closes on the same gap spring", () => {
  expect(tabsMotion.cardFlyAway).toBe(0.32);
  expect(tabsMotion.gapClose).toBe(tabsMotion.settle);
});
