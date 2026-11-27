import { AccessibilityInfo, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { presentVoiceSearchFrom, VoiceSearchView } from "../components/search/VoiceSearchView";
import { ActionButton, AppIcon, appIconLayout, capsule, overlayInk, press, voiceInk, voiceLayout } from "../components/ui";
import { actionRoleOf, primaryActionRoles } from "../components/ui/tokens";
import { ChromeFrost, OverlayCancelButton } from "../components/ui/LookViews";
import { DICTATION_IDLE, type Dictation } from "../state/voice/dictation";
import * as voiceStore from "../state/voice/store";
import { useVoice } from "../state/voice/store";
import { setAppearanceDesign } from "../state/settings/appearance";
import { usePreferences } from "../state/settings/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false, reduceTransparency: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced, useReduceTransparency: () => mockMotion.reduceTransparency }));

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

beforeEach(() => {
  jest.useFakeTimers();
  mockMotion.reduced = false;
  mockMotion.reduceTransparency = false;
  usePreferences.setState({ interfaceStyle: "glass" });
  withTabs(1);
});

afterEach(() => {
  act(() => useVoice.setState({ presented: false, dictation: DICTATION_IDLE }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const host = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const flat = (node: ReactTestInstance | undefined, pressed = false) => StyleSheet.flatten(typeof node?.props.style === "function" ? node.props.style({ pressed }) : node?.props.style) ?? {};
const show = (dictation: Partial<Dictation>, levels?: number[]) => {
  act(() => useVoice.setState({ presented: true, dictation: { ...DICTATION_IDLE, ...dictation }, ...(levels ? { levels } : {}) }));
  return renderSurface(<VoiceSearchView />);
};
const headers = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "header");

test("voice search is a modal overlay: modal to the screen reader, Escape closes it, and its Cancel is the shared top-right overlay button", () => {
  const root = show({ phase: "listening" });
  const cover = host(root, "voiceCover")!;
  expect(cover.props.accessibilityViewIsModal).toBe(true);
  expect(cover.props.pointerEvents).toBe("auto");
  const cancel = root.root.findAll((node) => node.type === OverlayCancelButton)[0]!;
  expect(cancel.props.label).toBe("Cancel");
  const face = host(root, "voiceCancel")!;
  expect(flat(face)).toMatchObject({ width: voiceLayout.cancel, height: voiceLayout.cancel });
  expect(flat(face).right).toBeDefined();
  expect(flat(face).left).toBeUndefined();
  act(() => cover.props.onAccessibilityEscape());
  expect(useVoice.getState().presented).toBe(false);
  unmount(root);
});

test("without permission the heading is a header and Open Settings is the shared overlay recovery action, black on white", () => {
  const root = show({ phase: "denied" });
  expect(headers(root).map((node) => node.props.children)).toContain("Speech and Mic permissions required.");
  const settings = root.root.findAll((node) => node.type === ActionButton && node.props.title === "Open Settings")[0]!;
  expect(settings.props.tone).toBe("overlay");
  const label = host(root, "voiceOpenSettings")!.findAll((node) => typeof node.type === "string" && node.props.children === "Open Settings")[0]!;
  expect(flat(label).color).toBe(overlayInk.onFill);
  expect(flat(host(root, "voiceOpenSettings")).backgroundColor).toBe(overlayInk.fill);
  unmount(root);
});

test("a problem's message is a header too, and Try Again is the overlay recovery action", () => {
  const root = show({ phase: "unavailable", problem: "heardNothing" });
  expect(headers(root)).toHaveLength(1);
  const retry = root.root.findAll((node) => node.type === ActionButton && node.props.title === "Try Again")[0]!;
  expect(retry.props.tone).toBe("overlay");
  unmount(root);
});

test("the voice actions are the shared action's glass face over the cover's frost, with its filled press, and the transcript plate has the continuous curve", () => {
  const root = show({ phase: "finished", transcript: "otters" });
  const search = root.root.findAll((node) => node.type === ActionButton && node.props.title === "Search")[0]!;
  expect(search.props).toMatchObject({ variant: "glass", tone: "overlay", stretch: true });
  expect(search.props.frostSource).toBeDefined();
  expect(search.findAll((node) => node.type === ChromeFrost)).toHaveLength(1);
  expect(flat(host(root, "voiceSearch")).borderCurve).toBe("continuous");
  expect(search.props.capsule).toBe(true);
  expect(flat(host(root, "voiceSearch")).borderRadius).toBe(capsule(primaryActionRoles[actionRoleOf.regular].height));
  const pressable = search.findAll((node) => typeof node.props.style === "function")[0]!;
  expect(flat(pressable, true).opacity).toBe(press.filledOpacity);
  const plate = root.root.findAll((node) => typeof node.type === "string" && flat(node).backgroundColor === voiceInk.transcript)[0]!;
  expect(flat(plate).borderCurve).toBe("continuous");
  unmount(root);
});

test("the voice actions and Cancel keep the frost tint in Glass and take the solid dark overlay face in Classic and under Reduce Transparency", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  act(() => setAppearanceDesign("redesigned"));
  const faces = (root: Root) =>
    root.root
      .findAll((node) => node.type === ChromeFrost)
      .map((frost) => StyleSheet.flatten(frost.findAll((node) => typeof node.type === "string")[0]!.props.style).backgroundColor);
  const glass = show({ phase: "finished", transcript: "otters" });
  expect(faces(glass)).toHaveLength(2);
  expect(faces(glass).every((fill) => fill === overlayInk.glass)).toBe(true);
  unmount(glass);
  act(() => usePreferences.setState({ interfaceStyle: "classic" }));
  const classic = show({ phase: "finished", transcript: "otters" });
  expect(faces(classic)).toEqual([overlayInk.solidGlass, overlayInk.solidGlass]);
  unmount(classic);
  act(() => usePreferences.setState({ interfaceStyle: "glass" }));
  mockMotion.reduceTransparency = true;
  const reduced = show({ phase: "finished", transcript: "otters" });
  expect(faces(reduced)).toEqual([overlayInk.solidGlass, overlayInk.solidGlass]);
  unmount(reduced);
  act(() => setAppearanceDesign("original"));
});

test("where the native glass exists the voice actions and Cancel draw it on both platforms, the same lens as the bar, and Cancel keeps its label and action", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  act(() => setAppearanceDesign("redesigned"));
  const root = show({ phase: "finished", transcript: "otters" });
  const glass = root.root.findAll((node) => node.type === lookModule.Glass);
  const frost = root.root.findAll((node) => node.type === lookModule.Frost);
  expect(glass).toHaveLength(2);
  expect(frost.every((node) => glass.some((plate) => plate.findAll((inner) => inner === node).length > 0))).toBe(true);
  const cancel = root.root.findAll((node) => node.props.testID === "voiceCancel" && node.props.accessibilityRole === "button")[0]!;
  expect(cancel.props.accessibilityLabel).toBe("Cancel");
  act(() => cancel.props.onPress());
  expect(useVoice.getState().presented).toBe(false);
  unmount(root);
  act(() => setAppearanceDesign("original"));
});

test("the waveform follows the level, and holds still at its resting height under Reduce Motion", () => {
  const levels = [0, 0.5, 1];
  const moving = show({ phase: "listening" }, levels);
  const heights = (root: Root) => root.root.findAll((node) => node.props.testID === "voiceWaveBar" && typeof node.type === "string").map((node) => (getAnimatedStyle(node) as { height: number }).height);
  expect(new Set(heights(moving)).size).toBeGreaterThan(1);
  unmount(moving);
  mockMotion.reduced = true;
  const still = show({ phase: "listening" }, levels);
  expect(heights(still)).toEqual(levels.map(() => voiceLayout.barMin));
  unmount(still);
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;

onIPhone("closing voice search gives screen reader focus back to the control that opened it, once the cover has left", async () => {
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  const focused = jest.spyOn(AccessibilityInfo, "setAccessibilityFocus").mockImplementation(() => undefined);
  jest.spyOn(voiceStore, "presentVoiceSearch").mockImplementation(() => {
    useVoice.setState({ presented: true, dictation: { ...DICTATION_IDLE, phase: "listening" } });
    return true;
  });
  const opener = 4343;
  act(() => presentVoiceSearchFrom(() => opener as never));
  const root = renderSurface(<VoiceSearchView />);
  await act(async () => undefined);
  focused.mockClear();
  act(() => host(root, "voiceCover")!.props.onAccessibilityEscape());
  expect(host(root, "voiceCover")).toBeUndefined();
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(100));
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(100));
  expect(focused).toHaveBeenCalledWith(opener);
  unmount(root);
});

test("every voice action is a pill, Cancel is a round glass button, and the mark is the app icon on its Welcome tile", () => {
  const listening = show({ phase: "listening", transcript: "otters" });
  const done = listening.root.findAll((node) => node.type === ActionButton && node.props.testID === "voiceDone")[0];
  if (done) expect(done.props.capsule).toBe(true);
  const icon = listening.root.findAll((node) => node.type === AppIcon)[0]!;
  expect(icon.props.side).toBe(voiceLayout.appIcon);
  const tile = flat(host(listening, "voiceAppIcon"));
  expect(tile).toMatchObject({ padding: appIconLayout.welcomeFrame, backgroundColor: appIconLayout.fill, borderRadius: voiceLayout.appIcon * appIconLayout.corner + appIconLayout.welcomeFrame });
  const cancel = listening.root.findAll((node) => node.type === OverlayCancelButton)[0]!;
  const cancelPlate = cancel.findAll((node) => typeof node.type === "string" && flat(node).borderRadius !== undefined).map((node) => flat(node).borderRadius);
  expect(cancelPlate).toContain(capsule(voiceLayout.cancel));
  unmount(listening);
  const failed = show({ phase: "unavailable", problem: "heardNothing" });
  expect(failed.root.findAll((node) => node.type === ActionButton && node.props.title === "Try Again")[0]!.props.capsule).toBe(true);
  unmount(failed);
});
