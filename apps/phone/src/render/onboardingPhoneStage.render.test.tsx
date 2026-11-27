import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { fitPhoneScale, frameTarget, phoneSize, sameSlot, scaledFromTopLeft } from "../components/onboarding/phoneGeometry";
import { onboardingMotion, openLink, phoneFrame, phoneStage } from "../components/onboarding/onboardingTokens";
import { openLinkProgress } from "../components/onboarding/OpenLinkScene";
import { OpenLinkDemo, openLinkScale } from "../components/onboarding/StepPhones";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const onIos = Platform.OS === "ios" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  mockMotion.reduced = false;
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");

test("a slot's window rect becomes the phone's centre and its scale from the drawn 236-point frame", () => {
  const rect = { x: 20, y: 100, width: phoneFrame.width / 2, height: phoneFrame.height / 2 };
  expect(frameTarget(rect)).toEqual({ centerX: 20 + phoneFrame.width / 4, centerY: 100 + phoneFrame.height / 4, scale: 0.5 });
  expect(phoneSize(0.5)).toEqual({ width: rect.width, height: rect.height });
});

test("scaling from the top-left corner keeps the scaled frame's corner where the box starts", () => {
  const [x, y, s] = scaledFromTopLeft(200, 400, 0.5) as [{ translateX: number }, { translateY: number }, { scale: number }];
  expect(x.translateX).toBe(-50);
  expect(y.translateY).toBe(-100);
  expect(s.scale).toBe(0.5);
});

test("a phone fits its space between its smallest and largest scale", () => {
  const range = { minScale: 0.4, maxScale: 0.78 };
  expect(fitPhoneScale(5000, 5000, range)).toBe(0.78);
  expect(fitPhoneScale(10, 10, range)).toBe(0.4);
  expect(fitPhoneScale(5000, phoneFrame.height * 0.5, range)).toBeCloseTo(0.5);
  expect(openLinkScale(5000, 5000)).toBe(openLink.maxScale);
});

test("a repeated report of the same slot is not a change, a moved or resized one is", () => {
  const slot = { screen: "blocking" as const, rect: { x: 1, y: 2, width: 3, height: 4 } };
  expect(sameSlot(slot, { ...slot, rect: { ...slot.rect } })).toBe(true);
  expect(sameSlot(slot, { ...slot, rect: { ...slot.rect, y: 3 } })).toBe(false);
  expect(sameSlot(slot, { ...slot, screen: "sync" })).toBe(false);
  expect(sameSlot(undefined, slot)).toBe(false);
});

test("the shared phone moves on the primary capsule's motion, and its screens cross-fade 220 ms out and 320 ms in", () => {
  expect(onboardingMotion.capsuleMove).toEqual({ response: 0.6, damping: 1 });
  expect(onboardingMotion.capsuleMoveDelayMs).toBe(90);
  expect(phoneStage.screenOutMs).toBe(220);
  expect(phoneStage.screenInMs).toBe(320);
  expect(phoneStage.vanishGraceMs).toBeLessThan(phoneStage.screenInMs);
});

test("the open-link loop rests on the thread, opens the page after the tap and closes it before it starts again", () => {
  const at = openLink.timeline;
  expect(openLinkProgress(0)).toBe(0);
  expect(openLinkProgress(at.press[1])).toBe(0);
  expect(openLinkProgress(at.open[1])).toBe(1);
  expect(openLinkProgress((at.open[1] + at.close[0]) / 2)).toBe(1);
  expect(openLinkProgress(1)).toBe(0);
  expect(at.press[0]).toBeGreaterThanOrEqual(at.reach[1]);
  expect(at.open[0]).toBeGreaterThanOrEqual(at.press[0]);
});

onIos("without the shared stage the default-browser art draws its own phone: a Messages thread with the tapas link that a finger taps open in Ardia", () => {
  const root = renderSurface(<OpenLinkDemo />, { flushTimers: false });
  const demo = hosts(root, "openLinkDemo")[0]!;
  expect(demo.props).toMatchObject({ accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" });
  act(() => demo.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 300 } } }));
  expect(hosts(root, "phoneFrame")).toHaveLength(1);
  expect(hosts(root, "openLinkCard")).toHaveLength(1);
  expect(hosts(root, "openLinkPage")).toHaveLength(1);
  expect(hosts(root, "sceneFinger")).toHaveLength(1);
  expect(textOf(root)).toContain("The best tapas in Lisbon");
  expect(textOf(root)).toContain("timeout.com");
  unmount(root);
});

onIos("with Reduce Motion the open-link scene draws no finger and cross-fades between the thread and the page on holds", () => {
  mockMotion.reduced = true;
  const root = renderSurface(<OpenLinkDemo />, { flushTimers: false });
  act(() => hosts(root, "openLinkDemo")[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 300 } } }));
  expect(hosts(root, "sceneFinger")).toHaveLength(0);
  act(() => jest.advanceTimersByTime(openLink.reducedThreadMs + openLink.reducedPageMs));
  expect(hosts(root, "openLinkPage")).toHaveLength(1);
  unmount(root);
});
