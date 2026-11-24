import { Keyboard, Platform, StyleSheet } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { ToastHost } from "../components/toasts/ToastHost";
import { space } from "../components/ui";
import { TOAST_KEYBOARD_TOP } from "../state/toasts/placement";
import { showToast, useToasts } from "../state/toasts/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let liveKeyboard: { height: ReturnType<typeof makeMutable<number>>; state: ReturnType<typeof makeMutable<KeyboardState>> };

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useToasts.setState({ toast: null });
  liveKeyboard = { height: makeMutable(0), state: makeMutable<KeyboardState>(KeyboardState.CLOSED) };
  jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => liveKeyboard as never);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const placeOf = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "toastPlace" && typeof node.type === "string")[0]!;
const lifted = (root: ReturnType<typeof renderSurface>) => {
  const transform = (getAnimatedStyle(placeOf(root)).transform ?? []) as { translateY?: number }[];
  return -(transform.find((step) => step.translateY !== undefined)?.translateY ?? 0);
};
const keyboardAt = (height: number) => act(() => void (liveKeyboard.height.value = height));

const onIPhone = Platform.OS === "ios" ? test : test.skip;

test("with no toast up nothing follows the live keyboard, and on Android nothing ever does, so the window keeps resizing for pages", () => {
  const root = renderSurface(<ToastHost />);
  expect(Reanimated.useAnimatedKeyboard).not.toHaveBeenCalled();
  act(() => showToast("Copied Link", "link"));
  if (Platform.OS === "android") expect(Reanimated.useAnimatedKeyboard).not.toHaveBeenCalled();
  else expect(Reanimated.useAnimatedKeyboard).toHaveBeenCalled();
  unmount(root);
});

onIPhone("a toast on screen rides above the keyboard frame by frame as it rises and falls, and never jumps", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  act(() => jest.advanceTimersByTime(16));
  const resting = StyleSheet.flatten(placeOf(root).props.style).bottom as number;
  expect(lifted(root)).toBeCloseTo(0, 5);
  for (const height of [100, 200, 336, 200, 0]) {
    keyboardAt(height);
    expect(lifted(root)).toBeCloseTo(Math.max(0, height + space.s - resting), 5);
  }
  unmount(root);
});

onIPhone("a toast raised while the keyboard is up sits at the top and stays there while the keyboard moves", () => {
  keyboardAt(336);
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  const place = StyleSheet.flatten(placeOf(root).props.style);
  expect(place.bottom).toBeUndefined();
  expect(place.top).toBeGreaterThanOrEqual(TOAST_KEYBOARD_TOP);
  keyboardAt(0);
  expect(lifted(root)).toBeCloseTo(0, 5);
  expect(StyleSheet.flatten(placeOf(root).props.style).top).toBe(place.top);
  unmount(root);
});

onIPhone("a toast raised while the keyboard is already up sits at the top even though its fresh keyboard subscription starts at zero", () => {
  jest.spyOn(Keyboard, "isVisible").mockReturnValue(true);
  jest.spyOn(Keyboard, "metrics").mockReturnValue({ height: 336, width: 402, screenX: 0, screenY: 538 });
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  const place = StyleSheet.flatten(placeOf(root).props.style);
  expect(place.bottom).toBeUndefined();
  expect(place.top).toBeGreaterThanOrEqual(TOAST_KEYBOARD_TOP);
  unmount(root);
});
