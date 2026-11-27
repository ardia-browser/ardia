import { Platform, StyleSheet } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { archiveTip, OnboardingView, stepIn, stepOut } from "../components/onboarding/OnboardingView";
import { onboardingCurves, onboardingMotion, phoneFrame, tipsReel } from "../components/onboarding/onboardingTokens";
import { reelScale } from "../components/onboarding/StepPhones";
import { REEL_TIPS } from "../components/onboarding/TipsScenes";
import { presetLook } from "../lib/profileLook";
import { ToggleRow } from "../components/settings/SettingsKit";
import { ActionButton, DEFAULT_PROFILE_COLOR, PrimaryButton, PROFILE_PRESETS, rolesFor, Symbol, ToggleRow as SwitchRow } from "../components/ui";
import { StartBackdrop } from "../components/search/StartSpaces";
import { PHONE_SHARING_COPY } from "../lib/telemetryCopy";
import { defaultBrowser } from "../platform/defaultBrowser";
import { useDefaultBrowser } from "../state/settings/defaultBrowser";
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

const showStep = (step: OnboardingStep, flushTimers = true) => {
  useOnboarding.setState({ showing: true, step, forward: true });
  return renderSurface(<OnboardingView />, { flushTimers });
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

const PRIMARIES = [
  ["welcome", "Get Started"],
  ["blocking", "Continue"],
  ["sync", "Connect to Your Mac"],
  ["allSet", "Start Browsing"],
] as const;

const labelInk = (root: Root, title: string) => {
  const button = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button" && textIn(node) === title)[0]!;
  return StyleSheet.flatten(button.findAll((node) => node.type === "Text")[0]!.props.style).color;
};

(iPhone ? test.each(PRIMARIES) : test.skip.each(PRIMARIES))("on iPhone the %s step's %s is a capsule at SwiftUI's 63⅓-point height, filled in the label colour with the page-surface label, not the accent rounded rectangle", (step, title) => {
  const root = showStep(step);
  const style = buttonStyle(root, title);
  const light = rolesFor(false);
  expect(style.minHeight).toBeCloseTo(190 / 3);
  expect(style.borderRadius).toBeCloseTo(style.minHeight / 2);
  expect(style.backgroundColor).toBe(light.label);
  expect(labelInk(root, title)).toBe(light.pageSurface);
  unmount(root);
});

(iPhone ? test.skip.each(PRIMARIES) : test.each(PRIMARIES))("on Android the %s step's %s keeps Compose's 50-point, 16-point rounded rectangle in the space's accent", (step, title) => {
  const root = showStep(step);
  const style = buttonStyle(root, title);
  expect(style.borderRadius).toBe(16);
  expect(style.backgroundColor).toBe("#B25B6B");
  expect(style.minHeight).toBeCloseTo(50);
  unmount(root);
});

onIos("the welcome step: the icon 24 points above the words, no subtitle under the title, the words 32 in, and the button 24 under the space in 24-point margins with 12 below", () => {
  const root = showStep("welcome");
  expect(styleOf(root, "welcomeIcon").marginBottom).toBe(24);
  const words = styleOf(root, "welcomeWords");
  expect(words).toMatchObject({ paddingHorizontal: 32, gap: 12 });
  expect(textIn(hosts(root, "welcomeWords")[0]!)).toBe("Meet your new favorite browser");
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

onIos("on iPhone the blocking step shows the phone demo of blocking instead of a card of switch rows, a hero tile or a subtitle", () => {
  selectCopy(Platform.OS);
  const root = showStep("blocking");
  expect(hosts(root, "blockingDemo")).toHaveLength(1);
  expect(hosts(root, "onboardingCard")).toHaveLength(0);
  expect(hosts(root, "onboardingHero")).toHaveLength(0);
  expect(hosts(root, "onboardingSubtitle")).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === SwitchRow || node.type === ToggleRow)).toHaveLength(0);
  unmount(root);
});

onAndroid("the blocking step keeps Compose's rows with their icon tiles", () => {
  const root = showStep("blocking");
  const rows = root.root.findAll((node) => node.type === ToggleRow);
  expect(rows.map((row) => row.props.icon)).toEqual(["handRaised", "eyeglasses", "listBulletFill"]);
  unmount(root);
});

onIos("the all-set step shows three tips as a looping reel instead of a list: one caption at a time, each held for a scene, all three read to screen readers", () => {
  const root = showStep("allSet", false);
  const reel = hosts(root, "tipsReel")[0]!;
  expect(reel.props.accessibilityLabel).toBe(REEL_TIPS.join(" "));
  expect(REEL_TIPS).toHaveLength(3);
  expect(hosts(root, "onboardingCard")).toHaveLength(0);
  expect(textOf(root)).not.toContain("archive");
  const caption = () => textIn(hosts(root, "tipsReelCaption").at(-1)!);
  expect(caption()).toBe("Tap + to search.");
  act(() => jest.advanceTimersByTime(tipsReel.sceneMs));
  expect(caption()).toBe("Swipe a tab up to close it.");
  act(() => jest.advanceTimersByTime(tipsReel.sceneMs));
  expect(caption()).toBe("Swipe a page to go back.");
  act(() => jest.advanceTimersByTime(tipsReel.sceneMs));
  expect(caption()).toBe("Tap + to search.");
  expect(hosts(root, "sceneFinger")).toHaveLength(1);
  unmount(root);
});

onIos("a reel dot jumps to its tip, and tapping the phone moves to the next", () => {
  const root = showStep("allSet", false);
  const caption = () => textIn(hosts(root, "tipsReelCaption").at(-1)!);
  const pressable = (testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.props.onPress === "function");
  act(() => pressable("tipsReelDot")[2]!.props.onPress());
  expect(caption()).toBe("Swipe a page to go back.");
  act(() => pressable("tipsReelStage")[0]!.props.onPress());
  expect(caption()).toBe("Tap + to search.");
  unmount(root);
});

onIos("with Reduce Motion the reel draws no finger and still steps through the tips", () => {
  mockMotion.reduced = true;
  const root = showStep("allSet", false);
  expect(hosts(root, "sceneFinger")).toHaveLength(0);
  act(() => jest.advanceTimersByTime(tipsReel.reducedSceneMs));
  expect(textIn(hosts(root, "tipsReelCaption").at(-1)!)).toBe("Swipe a tab up to close it.");
  unmount(root);
});

onIos("the reel's phone shrinks to fit a short screen and never grows past its drawn size", () => {
  expect(reelScale(2000)).toBe(tipsReel.maxScale);
  expect(reelScale(0)).toBe(tipsReel.minScale);
  const mid = reelScale(phoneFrame.height * 0.6 + 100);
  expect(mid).toBeGreaterThan(tipsReel.minScale);
  expect(mid).toBeLessThan(tipsReel.maxScale);
});

onIos("on iPhone the all-set step has no subtitle, and its sharing row is the plain shared switch row with no icon tile and no footnote", () => {
  const root = showStep("allSet");
  expect(hosts(root, "onboardingSubtitle")).toHaveLength(0);
  expect(textOf(root)).not.toContain("Happy browsing.");
  expect(textOf(root)).not.toContain(PHONE_SHARING_COPY.onboardingNote);
  expect(root.root.findAll((node) => node.type === ToggleRow)).toHaveLength(0);
  const row = root.root.findAll((node) => node.type === SwitchRow && node.props.label === PHONE_SHARING_COPY.toggle);
  expect(row).toHaveLength(1);
  expect(row[0]!.findAll((node) => node.type === Symbol)).toHaveLength(0);
  unmount(root);
});

test("the default-browser step sits on the start screen's gradient with ink actions on iPhone, and keeps its floating sheet with the shared actions on Android", async () => {
  jest.spyOn(defaultBrowser, "status").mockImplementation(async () => ({ isDefault: false, canAsk: false }));
  useDefaultBrowser.setState({ status: { isDefault: false, canAsk: false } });
  const root = showStep("defaultBrowser");
  await act(async () => undefined);
  const sheet = styleOf(root, "defaultBrowserSheet");
  const actions = root.root.findAll((node) => node.type === ActionButton).map((node) => ({ title: node.props.title, variant: node.props.variant, tone: node.props.tone, size: node.props.size, capsule: node.props.capsule }));
  const action = root.root.findAll((node) => node.type === ActionButton && node.props.variant === "filled").map((node) => node.props.title)[0] ?? root.root.findAll((node) => node.type === PrimaryButton)[0]!.props.title;
  if (iPhone) {
    expect(sheet.backgroundColor).toBeUndefined();
    expect(sheet.boxShadow).toBeUndefined();
    expect(root.root.findAll((node) => node.type === PrimaryButton)).toHaveLength(0);
    expect(actions).toEqual([
      { title: action, variant: "filled", tone: "ink", size: "hero", capsule: true },
      { title: "Maybe Later", variant: "plain", tone: "ink", size: "regular", capsule: undefined },
    ]);
  } else {
    expect(sheet.backgroundColor).toBeDefined();
    expect(sheet.boxShadow).toBeDefined();
    expect(root.root.findAll((node) => node.type === PrimaryButton).map((node) => node.props.title)).toEqual([action]);
    expect(actions.find((entry) => entry.title === "Maybe Later")).toMatchObject({ variant: "plain", tone: "neutral" });
  }
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

onIos("on iPhone every step sits on one start-screen gradient that stays put from step to step, with no fill cross-fading behind it", () => {
  useOnboarding.setState({ showing: true, step: "welcome", forward: true });
  const root = renderSurface(<OnboardingView />);
  const backdrop = hosts(root, "onboardingStartBackdrop");
  expect(backdrop).toHaveLength(1);
  const look = presetLook(PROFILE_PRESETS.find((preset) => preset.key === DEFAULT_PROFILE_COLOR)!);
  expect(backdrop[0]!.findAll((node) => node.type === StartBackdrop)[0]!.props).toMatchObject({ look, dark: false, incognito: false });
  expect(root.root.findAll((node) => node.props.entering !== undefined && node.props.testID === undefined && node.props.exiting !== undefined)).toHaveLength(0);
  const first = backdrop[0]!;
  act(() => useOnboarding.setState({ step: "blocking", forward: true }));
  const after = hosts(root, "onboardingStartBackdrop");
  expect(after).toHaveLength(1);
  expect(after[0]).toBe(first);
  unmount(root);
});

onAndroid("the backdrop cross-fades on the step's motion, as main animates both in one transaction", () => {
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

test("with Reduce Motion the welcome step fades in at once without a scale or lift, on SwiftUI's 300 ms ease-out on both phones, the icon upright on iPhone and at Compose's resting tilt on Android", () => {
  mockMotion.reduced = true;
  const delay = jest.spyOn(Reanimated, "withDelay");
  const root = showStep("welcome");
  expect(delay).not.toHaveBeenCalled();
  expect(onboardingMotion.riseReduced).toEqual({ timing: { duration: 300, easing: expect.anything() } });
  expect(styleOf(root, "welcomeIcon").transform).toEqual([{ rotate: iPhone ? "0deg" : "-6deg" }, { scale: 1 }]);
  expect(styleOf(root, "welcomeWords").transform).toEqual([{ translateY: 0 }]);
  unmount(root);
});

test("the archive tip reads the same Archive Tabs preference Settings shows, and names no duration when archiving is off", () => {
  expect(archiveTip("day")).toBe("Old tabs archive after 1 day.");
  expect(archiveTip("week")).toBe("Old tabs archive after 7 days.");
  expect(archiveTip("twelveHours")).toBe("Old tabs archive after 12 hours.");
  expect(archiveTip("never")).not.toMatch(/\d|day|hour/);
});

onAndroid("Android's all-set tips name the Archive Tabs interval", () => {
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

onIos("on iPhone every step's primary is the shared action filled in ink at hero size as a capsule, and Not Now is the shared plain action in ink, not a rebuilt button", () => {
  const root = showStep("sync");
  const buttons = root.root.findAll((node) => node.type === ActionButton);
  expect(root.root.findAll((node) => node.type === PrimaryButton)).toHaveLength(0);
  expect(buttons.filter((node) => node.props.variant === "filled").map((node) => node.props)).toEqual([expect.objectContaining({ title: "Connect to Your Mac", testID: "onboardingPrimary", tone: "ink", size: "hero", capsule: true })]);
  expect(buttons.filter((node) => node.props.variant === "plain").map((node) => node.props)).toEqual([expect.objectContaining({ title: "Not Now", tone: "ink" })]);
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
