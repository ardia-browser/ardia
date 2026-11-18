import { Platform } from "react-native";
import { duration, spring, tabsMotion, trayLandingDelayMs, trayMotion } from "../components/ui";
import { delay } from "../components/ui/motion";

const onIPhone = Platform.OS === "ios";
const response = (config: { stiffness: number }) => Math.round((2 * Math.PI) / Math.sqrt(config.stiffness) * 1000) / 1000;
const damping = (config: { stiffness: number; damping: number }) => Math.round((config.damping / (2 * Math.sqrt(config.stiffness))) * 100) / 100;
const asSpring = (config: { stiffness: number; damping: number }) => [response(config), damping(config)];

const springs = {
  "card open (tabsMotion.expand)": [tabsMotion.expand, [0.18, 1], [0.3, 1]],
  "card release (tabsMotion.release)": [tabsMotion.release, [0.26, 1], [0.3, 0.9]],
  "deck scroll settle (tabsMotion.settle)": [tabsMotion.settle, [0.28, 1], [0.4, 1]],
  "gap close (tabsMotion.gapClose)": [tabsMotion.gapClose, [0.22, 1], [0.4, 0.8]],
  "pager settle (tabsMotion.pagerSettle)": [tabsMotion.pagerSettle, [0.26, 1], [0.38, 1]],
  "bar collapse (tabsMotion.barCollapse)": [tabsMotion.barCollapse, [0.26, 1], [0.4, 1]],
  "panel settle (trayMotion.settle)": [trayMotion.settle, [0.26, 1], [0.34, 0.86]],
  "panel dismiss (trayMotion.dismiss)": [trayMotion.dismiss, [0.14, 1], [0.32, 1]],
  "row press (trayMotion.press)": [trayMotion.press, [0.16, 1], [0.2, 0.7]],
  "incognito toggle (trayMotion.modeToggle)": [trayMotion.modeToggle, [0.2, 1], [0.3, 0.85]],
} as const;

for (const [name, [config, iPhone, android]] of Object.entries(springs)) {
  test(`${name} is main's SwiftUI spring on iPhone and Compose's on Android`, () => {
    expect(asSpring(config)).toEqual(onIPhone ? iPhone : android);
  });
}

test("the deck's open is SwiftUI's arrive curve, 190 ms for scale and position together, on iPhone, and Compose's two springs on Android", () => {
  if (onIPhone) {
    expect(tabsMotion.openScale).toEqual({ timing: expect.objectContaining({ duration: 190 }) });
    expect(tabsMotion.openPosition).toEqual({ timing: expect.objectContaining({ duration: 190 }) });
  } else {
    expect("spring" in tabsMotion.openScale && asSpring(tabsMotion.openScale.spring)).toEqual([0.19, 1]);
    expect("spring" in tabsMotion.openPosition && asSpring(tabsMotion.openPosition.spring)).toEqual([0.3, 1]);
  }
});

test("the search panel rises on SwiftUI's 360 ms rise curve on iPhone, and Compose's 0.39 s spring on Android", () => {
  if (onIPhone) expect(trayMotion.rise).toEqual({ timing: expect.objectContaining({ duration: 360 }) });
  else expect("spring" in trayMotion.rise && asSpring(trayMotion.rise.spring)).toEqual([0.39, 1]);
});

test("fades, flights and waits are SwiftUI's lengths on iPhone and Compose's on Android", () => {
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
  };
  expect(lengths).toEqual(
    onIPhone
      ? { fade: 150, flyAway: 160, barTone: 200, surfaceFade: 150, trayDim: 200, resultsIn: 100, panelLanding: 220, progressFill: 150, progressFade: 200, progressAdvance: 300, progressReveal: 100 }
      : { fade: 200, flyAway: 200, barTone: 250, surfaceFade: 200, trayDim: 300, resultsIn: 140, panelLanding: 450, progressFill: 200, progressFade: 250, progressAdvance: 450, progressReveal: 150 },
  );
  expect(spring(1, 1).mass).toBe(1);
});

test("a closed card flies off on main's fly-away spring on both phones: response 0.32 with no bounce, and the gap closes on each phone's own gap spring", () => {
  expect(tabsMotion.cardFlyAway).toBe(0.32);
  expect(asSpring(tabsMotion.gapClose)).toEqual(onIPhone ? [0.22, 1] : [0.4, 0.8]);
});
