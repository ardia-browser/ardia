import { Platform, StyleSheet } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { archiveTip, OnboardingView, stepIn, stepOut } from "../components/onboarding/OnboardingView";
import { onboardingCurves, onboardingLayout, onboardingMotion } from "../components/onboarding/onboardingTokens";
import { ToggleRow } from "../components/settings/SettingsKit";
import { ActionButton, PrimaryButton, shadowCss, Symbol, ToggleRow as SwitchRow } from "../components/ui";
import { setPreference } from "../state/settings/store";
import { selectCopy } from "../lib/platformCopy";
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
] as const)("the %s step's %s is a 16-point smooth rounded rectangle in the space's accent on iPhone, not a capsule, and Compose's 16-point rounded rectangle on Android", (step, title) => {
  const root = showStep(step);
  const style = buttonStyle(root, title);
  expect(style.borderRadius).toBe(16);
  expect(style.backgroundColor).toBe("#B25B6B");
  expect(style.minHeight).toBeCloseTo(iPhone ? 190 / 3 : 50);
  unmount(root);
});

onIos("a taller button at a large text size keeps its 16-point corners instead of growing into a capsule", () => {
  const root = showStep("welcome");
  expect(buttonStyle(root, "Get Started").borderRadius).toBe(16);
  unmount(root);
});

onIos("the welcome step: the icon 24 points above the words, a 17-point subtitle 12 under the title, the words 32 in, and the button 24 under the space in 24-point margins with 12 below", () => {
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

test("every step's art sits centred in its space, so the blocking and all-set cards leave no empty band above them", () => {
  for (const [step, place] of [
    ["sync", "center"],
    ["blocking", "center"],
    ["allSet", "center"],
  ] as const) {
    const root = showStep(step);
    expect(styleOf(root, "onboardingIllustration").justifyContent).toBe(place);
    unmount(root);
  }
});

onIos("the blocking step's rows are the shared switch rows, knob-only on iPhone as the page menu's are: three titles, no icon tiles, dividers 16 in, on a 16-point white card with the shared card shadow, under an accent hero tile", () => {
  selectCopy(Platform.OS);
  const root = showStep("blocking");
  const card = hosts(root, "onboardingCard")[0]!;
  const switches = card.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "switch");
  expect(switches.map((node) => node.props.accessibilityLabel)).toEqual(["Block Ads", "Block Trackers", "Block Cookie Banners"]);
  expect(card.findAll((node) => node.type === SwitchRow).map((row) => row.props.press)).toEqual(["knob", "knob", "knob"]);
  expect(card.findAll((node) => node.type === Symbol)).toHaveLength(0);
  expect(card.findAll((node) => node.type === ToggleRow)).toHaveLength(0);
  expect(StyleSheet.flatten(card.props.style)).toMatchObject({ borderRadius: 16, paddingVertical: 4, backgroundColor: "#FFFFFF", boxShadow: shadowCss("card", false) });
  expect(hosts(root, "onboardingHero")[0]!.findAll((node) => node.type === Symbol)[0]!.props.name).toBe("handRaised");
  expect(onboardingLayout.rowIcons).toBe(false);
  unmount(root);
});

onAndroid("the blocking step keeps Compose's rows with their icon tiles", () => {
  const root = showStep("blocking");
  const rows = root.root.findAll((node) => node.type === ToggleRow);
  expect(rows.map((row) => row.props.icon)).toEqual(["handRaised", "eyeglasses", "listBulletFill"]);
  unmount(root);
});

onIos("the all-set step's tips are plain rows: body text, 56 points tall, 16 in, no icons, on the same card", () => {
  const root = showStep("allSet");
  const card = hosts(root, "onboardingCard")[0]!;
  for (const tip of ["Tap + to search.", "Flick a tab up to close it.", "Swipe a page to go back.", "Old tabs archive after 1 day."]) expect(textIn(card)).toContain(tip);
  expect(card.findAll((node) => node.type === Symbol)).toHaveLength(0);
  const tip = card.findAll((node) => typeof node.type === "string" && textIn(node) === "Tap + to search." && StyleSheet.flatten(node.props.style)?.minHeight !== undefined)[0]!;
  expect(StyleSheet.flatten(tip.props.style)).toMatchObject({ minHeight: 56, paddingHorizontal: 16 });
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

test("the step motion is main's Motion.step on both phones: the new step comes in 72 points from the right and the old leaves 72 to the left, both on 300 ms of (0.05, 0.7, 0.1, 1)", () => {
  const root = showStep("blocking");
  const step = shownStep(root);
  const entering = (step.props.entering as () => Built)();
  const exiting = (step.props.exiting as () => Built)();
  const shift = 72;
  expect(entering.initialValues).toEqual({ opacity: 0, transform: [{ translateX: shift }] });
  expect(exiting.initialValues).toEqual({ opacity: 1, transform: [{ translateX: 0 }] });
  expect(entering.animations.transform![0]!.translateX.toValue).toBe(0);
  expect(exiting.animations.transform![0]!.translateX.toValue).toBe(-shift);
  expect(onboardingCurves.step).toEqual([0.05, 0.7, 0.1, 1]);
  expectTiming(entering.animations.opacity, 0, 300, onboardingCurves.step);
  expectTiming(entering.animations.transform![0]!.translateX, 72, 300, onboardingCurves.step);
  expectTiming(exiting.animations.opacity, 1, 300, onboardingCurves.step);
  expectTiming(exiting.animations.transform![0]!.translateX, 0, 300, onboardingCurves.step);
  unmount(root);
});

test("a step going back comes in from the left and the old one leaves to the right", () => {
  const entering = stepIn(-1, false)() as unknown as Built;
  expect(entering.initialValues.transform).toEqual([{ translateX: -onboardingMotion.stepTravel }]);
  const exiting = stepOut(-1, false)() as unknown as Built;
  expect(exiting.animations.transform![0]!.translateX.toValue).toBe(onboardingMotion.stepTravel);
});

test("with Reduce Motion a step only fades, on main's Motion.fade (150 ms ease-out) on both phones", () => {
  mockMotion.reduced = true;
  const root = showStep("blocking");
  const step = shownStep(root);
  const entering = (step.props.entering as () => Built)();
  const exiting = (step.props.exiting as () => Built)();
  expect(entering.initialValues.transform).toEqual([{ translateX: 0 }]);
  expect(exiting.animations.transform![0]!.translateX.toValue).toBe(0);
  expectTiming(entering.animations.opacity, 0, 150, onboardingCurves.easeOut);
  expectTiming(exiting.animations.opacity, 1, 150, onboardingCurves.easeOut);
  unmount(root);
});

test("the backdrop cross-fades on the step's motion on both phones, as main animates both in one transaction", () => {
  useOnboarding.setState({ showing: true, step: "welcome", forward: true });
  const root = renderSurface(<OnboardingView />);
  const backdrop = root.root.findAll((node) => node.props.entering !== undefined && node.props.testID === undefined && node.props.exiting !== undefined)[0]!;
  const entering = (backdrop.props.entering as () => Built)();
  expect(entering.initialValues).toEqual({ opacity: 0 });
  expectTiming(entering.animations.opacity, 0, 300, onboardingCurves.step);
  unmount(root);
});

test("the welcome step rises on main's Motion.rise on both phones: 360 ms of (0.2, 0, 0, 1) after 50 ms", () => {
  const delay = jest.spyOn(Reanimated, "withDelay");
  const root = showStep("welcome");
  expect(delay).toHaveBeenCalledTimes(1);
  const [wait, rise] = delay.mock.calls[0]! as unknown as [number, Animation];
  expect(wait).toBe(50);
  expect(rise.toValue).toBe(1);
  expectTiming(rise, 0, 360, onboardingCurves.rise);
  unmount(root);
});

test("with Reduce Motion the welcome step fades in at once without the tilt, scale or lift, on SwiftUI's 300 ms ease-out on both phones", () => {
  mockMotion.reduced = true;
  const delay = jest.spyOn(Reanimated, "withDelay");
  const root = showStep("welcome");
  expect(delay).not.toHaveBeenCalled();
  expect(onboardingMotion.riseReduced).toEqual({ timing: { duration: 300, easing: expect.anything() } });
  expect(styleOf(root, "welcomeIcon").transform).toEqual([{ rotate: "-6deg" }, { scale: 1 }]);
  expect(styleOf(root, "welcomeWords").transform).toEqual([{ translateY: 0 }]);
  unmount(root);
});

test("the archive tip reads the same Archive Tabs preference Settings shows, and names no duration when archiving is off", () => {
  expect(archiveTip("day")).toBe("Old tabs archive after 1 day.");
  expect(archiveTip("week")).toBe("Old tabs archive after 7 days.");
  expect(archiveTip("twelveHours")).toBe("Old tabs archive after 12 hours.");
  expect(archiveTip("never")).not.toMatch(/\d|day|hour/);
  setPreference("autoArchiveInterval", "week");
  const root = showStep("allSet");
  expect(textOf(root)).toContain("Old tabs archive after 7 days.");
  expect(textOf(root)).not.toContain("after 1 day");
  unmount(root);
  setPreference("autoArchiveInterval", "day");
});

test("a step that is leaving is dead to touch and hidden from screen readers from the moment it starts to leave, then goes", () => {
  const root = showStep("blocking");
  act(() => useOnboarding.setState({ step: "allSet", forward: true }));
  const steps = hosts(root, "onboardingStep");
  expect(steps).toHaveLength(2);
  const [leaving, arriving] = steps as [ReactTestInstance, ReactTestInstance];
  expect(leaving.props).toMatchObject({ pointerEvents: "none", accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" });
  expect(arriving.props).toMatchObject({ pointerEvents: "auto", accessibilityElementsHidden: false });
  expect(textIn(arriving)).toContain("Start Browsing");
  act(() => jest.advanceTimersByTime(50));
  expect(hosts(root, "onboardingStep")).toHaveLength(1);
  unmount(root);
});

test("finishing makes the whole onboarding dead to touch and hidden from screen readers while it fades, then it goes", async () => {
  const root = showStep("allSet");
  await pressButton(root, "Start Browsing");
  const shell = hosts(root, "onboarding");
  expect(shell).toHaveLength(1);
  expect(shell[0]!.props).toMatchObject({ pointerEvents: "none", accessibilityElementsHidden: true });
  act(() => jest.advanceTimersByTime(50));
  expect(hosts(root, "onboarding")).toHaveLength(0);
  unmount(root);
});

test("every step's primary is the shared PrimaryButton and Not Now is the shared plain action, not a rebuilt button", () => {
  const root = showStep("sync");
  const primaries = root.root.findAll((node) => node.type === PrimaryButton).map((node) => node.props.title);
  const plain = root.root.findAll((node) => node.type === ActionButton && node.props.variant === "plain").map((node) => node.props.title);
  if (iPhone) {
    expect(primaries).toEqual(["Connect to Your Mac"]);
    expect(plain).toEqual(["Not Now"]);
  }
  unmount(root);
});

test("the usage-sharing row is the shared switch row, its label and switch state from the one contract", () => {
  const root = showStep("allSet");
  const rows = root.root.findAll((node) => node.type === SwitchRow && node.props.label === "Share anonymous usage stats");
  expect(rows).toHaveLength(1);
  const control = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "switch" && node.props.accessibilityLabel === "Share anonymous usage stats");
  expect(control).toHaveLength(1);
  expect(control[0]!.props.accessibilityState).toMatchObject({ checked: expect.any(Boolean) });
  unmount(root);
});

test.each(["welcome", "blocking", "sync", "allSet"] as const)("arriving at the %s step gives the screen reader its heading", async (step) => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const root = showStep(step);
  await act(async () => undefined);
  const headingView = root.root.findAll((node) => typeof node.type !== "string" && node.props.accessibilityRole === "header").map((node) => node.instance).filter(Boolean)[0];
  expect(headingView).toBeTruthy();
  expect(asked.mock.calls.some(([target]) => target() === headingView)).toBe(true);
  unmount(root);
});

test("moving on focuses the incoming step's heading and only the closing gate covers the outgoing one", async () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const cancelled = jest.fn();
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => cancelled);
  const root = showStep("welcome");
  await act(async () => undefined);
  const first = asked.mock.calls.length;
  await act(async () => advanceOnboarding());
  await act(async () => undefined);
  expect(cancelled).toHaveBeenCalled();
  const fresh = asked.mock.calls.slice(first).map(([target]) => target());
  const incoming = root.root.findAll((node) => typeof node.type !== "string" && node.props.accessibilityRole === "header" && !textIn(node).includes("Meet your new favorite browser")).map((node) => node.instance).filter(Boolean)[0];
  expect(incoming).toBeTruthy();
  expect(fresh).toContain(incoming);
  const outgoing = hosts(root, "onboardingStep").filter((node) => textIn(node).includes("Meet your new favorite browser"));
  for (const step of outgoing) expect(step.props.accessibilityElementsHidden).toBe(true);
  unmount(root);
});
