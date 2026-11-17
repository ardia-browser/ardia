import { Platform, StyleSheet } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { OnboardingView, stepIn, stepOut } from "../components/onboarding/OnboardingView";
import { onboardingCurves, onboardingLayout, onboardingMotion } from "../components/onboarding/onboardingTokens";
import { ToggleRow } from "../components/settings/SettingsKit";
import { Symbol } from "../components/ui";
import { advanceOnboarding, useOnboarding } from "../state/onboarding/store";
import type { OnboardingStep } from "../state/settings/settingsRules";
import { useSync } from "../state/sync/store";
import { status } from "../../test/syncFixture";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;
const iPhone = Platform.OS === "ios";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  mockMotion.reduced = false;
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }) }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  useOnboarding.setState({ showing: false, step: "welcome", forward: true });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const textIn = (node: ReactTestInstance) => textOf({ root: node } as Root);

const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");

const styleOf = (root: Root, testID: string) => StyleSheet.flatten(hosts(root, testID)[0]!.props.style);

const header = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "header")[0]!;

const showStep = (step: OnboardingStep) => {
  useOnboarding.setState({ showing: true, step, forward: true });
  return renderSurface(<OnboardingView />);
};

const buttonStyle = (root: Root, title: string) => StyleSheet.flatten(root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button" && textIn(node) === title)[0]!.props.style);

test.each(["welcome", "blocking", "sync", "allSet"] as const)("the %s step's title is SwiftUI's 28-point bold title on iPhone, and Compose's size on Android", (step) => {
  const root = showStep(step);
  const title = StyleSheet.flatten(header(root).props.style);
  expect(title.fontSize).toBe(iPhone ? 28 : step === "welcome" ? 40 : 34);
  expect(title.lineHeight).toBe(iPhone ? 34 : step === "welcome" ? 46 : 41);
  expect(title.fontWeight).toBe("700");
  unmount(root);
});

test.each([
  ["welcome", "Get Started"],
  ["blocking", "Continue"],
  ["sync", "Connect to Your Mac"],
  ["allSet", "Start Browsing"],
] as const)("the %s step's %s is SwiftUI's capsule on iPhone and Compose's 14-point rounded rectangle on Android", (step, title) => {
  const root = showStep(step);
  const style = buttonStyle(root, title);
  expect(style.borderRadius).toBeCloseTo(iPhone ? 190 / 6 : 14);
  expect(style.minHeight).toBeCloseTo(iPhone ? 190 / 3 : 50);
  unmount(root);
});

onIos("a taller button at a large text size stays a capsule", () => {
  const root = showStep("welcome");
  const button = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button" && textIn(node) === "Get Started")[0]!;
  act(() => button.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 354, height: 90 } } }));
  expect(buttonStyle(root, "Get Started").borderRadius).toBe(45);
  unmount(root);
});

onIos("the welcome step is SwiftUI's: the icon 24 points above the words, a 17-point subtitle 12 under the title, the words 32 in, and the button 24 under the space in 24-point margins with 12 below", () => {
  const root = showStep("welcome");
  expect(styleOf(root, "welcomeIcon").marginBottom).toBe(24);
  const words = styleOf(root, "welcomeWords");
  expect(words).toMatchObject({ paddingHorizontal: 32, gap: 12 });
  const subtitle = hosts(root, "welcomeWords")[0]!.findAll((node) => typeof node.type === "string" && textIn(node) === "Get what you want twice as fast.")[0]!;
  expect(StyleSheet.flatten(subtitle.props.style).fontSize).toBe(17);
  expect(styleOf(root, "onboardingActions")).toMatchObject({ paddingTop: 24, paddingHorizontal: 24, paddingBottom: 12, gap: 8 });
  unmount(root);
});

onAndroid("the welcome step keeps Compose's 40-point title and 20-point subtitle", () => {
  const root = showStep("welcome");
  const subtitle = hosts(root, "welcomeWords")[0]!.findAll((node) => typeof node.type === "string" && textIn(node) === "Get what you want twice as fast.")[0]!;
  expect(StyleSheet.flatten(subtitle.props.style).fontSize).toBe(20);
  expect(styleOf(root, "welcomeIcon").marginBottom).toBe(0);
  unmount(root);
});

test.each(["blocking", "sync", "allSet"] as const)("the %s step puts the words 20 points under the art, 32 in and 12 apart, and the buttons 24 below in 24-point margins, 8 apart with 12 under them, as both native apps' pages do", (step) => {
  const root = showStep(step);
  expect(styleOf(root, "onboardingWords")).toMatchObject({ paddingTop: 20, paddingHorizontal: 32, gap: 12 });
  expect(styleOf(root, "onboardingActions")).toMatchObject({ paddingTop: 24, paddingHorizontal: 24, paddingBottom: 12, gap: 8 });
  expect(styleOf(root, "onboardingIllustration").paddingHorizontal).toBe(16);
  unmount(root);
});

test("the sync step's art sits centred in its space, as both native apps' pages do, while the blocking and all-set cards sit at the bottom", () => {
  for (const [step, place] of [
    ["sync", "center"],
    ["blocking", "flex-end"],
    ["allSet", "flex-end"],
  ] as const) {
    const root = showStep(step);
    expect(styleOf(root, "onboardingIllustration").justifyContent).toBe(place);
    unmount(root);
  }
});

onIos("the blocking step's rows are SwiftUI's plain toggles: three titles 50 points tall and 16 in, no icon tiles, dividers 16 in, on a 20-point card of the page colour at 90% with SwiftUI's soft shadow", () => {
  const root = showStep("blocking");
  const card = hosts(root, "onboardingCard")[0]!;
  const switches = card.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "switch");
  expect(switches.map((node) => node.props.accessibilityLabel)).toEqual(["Block Ads", "Block Trackers", "Block Cookie Banners"]);
  for (const row of switches) expect(StyleSheet.flatten(row.props.style)).toMatchObject({ minHeight: 50, paddingHorizontal: 16 });
  expect(card.findAll((node) => node.type === Symbol)).toHaveLength(0);
  expect(card.findAll((node) => node.type === ToggleRow)).toHaveLength(0);
  expect(StyleSheet.flatten(card.props.style)).toMatchObject({ borderRadius: 20, paddingVertical: 4, backgroundColor: "rgba(255, 255, 255, 0.9)", boxShadow: "0px 6px 32px rgba(0, 0, 0, 0.06)" });
  expect(onboardingLayout.rowIcons).toBe(false);
  unmount(root);
});

onAndroid("the blocking step keeps Compose's rows with their icon tiles", () => {
  const root = showStep("blocking");
  const rows = root.root.findAll((node) => node.type === ToggleRow);
  expect(rows.map((row) => row.props.icon)).toEqual(["handRaised", "eyeglasses", "listBulletFill"]);
  unmount(root);
});

onIos("the all-set step's tips are SwiftUI's plain rows: body text, 50 points tall, 16 in, no icons, on the same card", () => {
  const root = showStep("allSet");
  const card = hosts(root, "onboardingCard")[0]!;
  for (const tip of ["Tap + to search.", "Flick a tab up to close it.", "Swipe a page to go back.", "Old tabs archive after a day."]) expect(textIn(card)).toContain(tip);
  expect(card.findAll((node) => node.type === Symbol)).toHaveLength(0);
  const tip = card.findAll((node) => typeof node.type === "string" && textIn(node) === "Tap + to search." && StyleSheet.flatten(node.props.style)?.minHeight !== undefined)[0]!;
  expect(StyleSheet.flatten(tip.props.style)).toMatchObject({ minHeight: 50, paddingHorizontal: 16 });
  unmount(root);
});

onAndroid("the all-set step keeps Compose's tips with their icons", () => {
  const root = showStep("allSet");
  expect(root.root.findAll((node) => node.type === Symbol).map((node) => node.props.name)).toEqual(expect.arrayContaining(["plus", "squareOnSquare", "handDrawFill", "archivebox"]));
  unmount(root);
});

test("the steps follow welcome, blocking, sync and all set (with the default-browser step before sync where offered), and Start Browsing finishes", async () => {
  useOnboarding.setState({ showing: true, step: "welcome", forward: true });
  const root = renderSurface(<OnboardingView />);
  await pressButton(root, "Get Started");
  expect(useOnboarding.getState()).toMatchObject({ step: "blocking", forward: true });
  await pressButton(root, "Continue");
  expect(["sync", "defaultBrowser"]).toContain(useOnboarding.getState().step);
  if (useOnboarding.getState().step === "defaultBrowser") act(() => advanceOnboarding());
  expect(useOnboarding.getState().step).toBe("sync");
  await pressButton(root, "Not Now");
  expect(useOnboarding.getState().step).toBe("allSet");
  await pressButton(root, "Start Browsing");
  expect(useOnboarding.getState().showing).toBe(false);
  unmount(root);
});

type Animation = { type?: string; toValue: number; current: number; onStart: (animation: Animation, value: number, now: number, previous: unknown) => void; onFrame: (animation: Animation, now: number) => boolean };

type Built = { initialValues: { opacity: number; transform?: { translateX: number }[] }; animations: { opacity: Animation; transform?: { translateX: Animation }[] } };

const run = (animation: Animation, from: number, ms: number) => {
  const copy = { ...animation };
  copy.onStart(copy, from, 0, undefined);
  const done = copy.onFrame(copy, ms);
  return { value: copy.current, done };
};

const bezier = (curve: readonly number[], t: number) => Reanimated.Easing.bezier(curve[0]!, curve[1]!, curve[2]!, curve[3]!).factory()(t);

const expectTiming = (animation: Animation, from: number, durationMs: number, curve: readonly number[]) => {
  expect(animation.type).toBe("timing");
  for (const share of [0.1, 0.3, 0.6]) expect(run(animation, from, durationMs * share).value).toBeCloseTo(from + (animation.toValue - from) * bezier(curve, share), 4);
  expect(run(animation, from, durationMs - 1).done).toBe(false);
  expect(run(animation, from, durationMs)).toEqual({ value: animation.toValue, done: true });
};

const shownStep = (root: Root) => root.root.findAll((node) => node.props.testID === "onboardingStep" && node.props.entering !== undefined)[0]!;

test("the step motion is main's Motion.step on iPhone: the new step comes in 72 points from the right and the old leaves 72 to the left, both on 300 ms of (0.05, 0.7, 0.1, 1); Android keeps Compose's 60 dp on its spring", () => {
  const root = showStep("blocking");
  const step = shownStep(root);
  const entering = (step.props.entering as () => Built)();
  const exiting = (step.props.exiting as () => Built)();
  const shift = iPhone ? 72 : 60;
  expect(entering.initialValues).toEqual({ opacity: 0, transform: [{ translateX: shift }] });
  expect(exiting.initialValues).toEqual({ opacity: 1, transform: [{ translateX: 0 }] });
  expect(entering.animations.transform![0]!.translateX.toValue).toBe(0);
  expect(exiting.animations.transform![0]!.translateX.toValue).toBe(-shift);
  if (iPhone) {
    expect(onboardingCurves.step).toEqual([0.05, 0.7, 0.1, 1]);
    expectTiming(entering.animations.opacity, 0, 300, onboardingCurves.step);
    expectTiming(entering.animations.transform![0]!.translateX, 72, 300, onboardingCurves.step);
    expectTiming(exiting.animations.opacity, 1, 300, onboardingCurves.step);
    expectTiming(exiting.animations.transform![0]!.translateX, 0, 300, onboardingCurves.step);
  } else {
    expect(entering.animations.transform![0]!.translateX.type).not.toBe("timing");
    expect(onboardingMotion.step).toEqual({ spring: expect.objectContaining({ mass: 1 }) });
  }
  unmount(root);
});

test("a step going back comes in from the left and the old one leaves to the right", () => {
  const entering = stepIn(-1, false)() as unknown as Built;
  expect(entering.initialValues.transform).toEqual([{ translateX: -onboardingMotion.stepTravel }]);
  const exiting = stepOut(-1, false)() as unknown as Built;
  expect(exiting.animations.transform![0]!.translateX.toValue).toBe(onboardingMotion.stepTravel);
});

test("with Reduce Motion a step only fades, on main's Motion.fade (150 ms ease-out) on iPhone and Compose's 200 ms on Android", () => {
  mockMotion.reduced = true;
  const root = showStep("blocking");
  const step = shownStep(root);
  const entering = (step.props.entering as () => Built)();
  const exiting = (step.props.exiting as () => Built)();
  expect(entering.initialValues.transform).toEqual([{ translateX: 0 }]);
  expect(exiting.animations.transform![0]!.translateX.toValue).toBe(0);
  if (iPhone) {
    expectTiming(entering.animations.opacity, 0, 150, onboardingCurves.easeOut);
    expectTiming(exiting.animations.opacity, 1, 150, onboardingCurves.easeOut);
  } else {
    expect(run(entering.animations.opacity, 0, 199).done).toBe(false);
    expect(run(entering.animations.opacity, 0, 200).done).toBe(true);
  }
  unmount(root);
});

test("the backdrop cross-fades on the step's motion on iPhone, as main animates both in one transaction", () => {
  useOnboarding.setState({ showing: true, step: "welcome", forward: true });
  const root = renderSurface(<OnboardingView />);
  const backdrop = root.root.findAll((node) => node.props.entering !== undefined && node.props.testID === undefined && node.props.exiting !== undefined)[0]!;
  const entering = (backdrop.props.entering as () => Built)();
  expect(entering.initialValues).toEqual({ opacity: 0 });
  if (iPhone) expectTiming(entering.animations.opacity, 0, 300, onboardingCurves.step);
  else expect(run(entering.animations.opacity, 0, 300).done).toBe(true);
  unmount(root);
});

test("the welcome step rises on main's Motion.rise on iPhone: 360 ms of (0.2, 0, 0, 1) after 50 ms; Android keeps Compose's spring after 100 ms", () => {
  const delay = jest.spyOn(Reanimated, "withDelay");
  const root = showStep("welcome");
  expect(delay).toHaveBeenCalledTimes(1);
  const [wait, rise] = delay.mock.calls[0]! as unknown as [number, Animation];
  expect(wait).toBe(iPhone ? 50 : 100);
  expect(rise.toValue).toBe(1);
  if (iPhone) expectTiming(rise, 0, 360, onboardingCurves.rise);
  else expect(rise.type).not.toBe("timing");
  unmount(root);
});

test("with Reduce Motion the welcome step fades in at once without the tilt, scale or lift, on SwiftUI's 300 ms ease-out on iPhone", () => {
  mockMotion.reduced = true;
  const delay = jest.spyOn(Reanimated, "withDelay");
  const root = showStep("welcome");
  expect(delay).not.toHaveBeenCalled();
  if (iPhone) expect(onboardingMotion.riseReduced).toEqual({ timing: { duration: 300, easing: expect.anything() } });
  expect(styleOf(root, "welcomeIcon").transform).toEqual([{ rotate: "-6deg" }, { scale: 1 }]);
  expect(styleOf(root, "welcomeWords").transform).toEqual([{ translateY: 0 }]);
  unmount(root);
});
