import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { getAnimatedStyle } from "react-native-reanimated";
import { SettingsView } from "../components/settings/SettingsView";
import { appDesign, PROFILE_COLORS } from "../components/ui";
import { openSettings } from "../state/settings/nav";
import * as settingsActions from "../state/settings/actions";
import { setPreference } from "../state/settings/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let choose: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  setPreference("colorChoice", "plum");
  choose = jest.spyOn(settingsActions, "setColorChoice").mockImplementation((color) => setPreference("colorChoice", color));
  openSettings(appDesign === "redesigned" ? { page: "appearance" } : { page: "root" });
});

afterEach(() => {
  choose.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const ringOf = (root: ReturnType<typeof renderSurface>, name: string): ReactTestInstance => {
  const radio = root.root.findAll((node) => node.props.accessibilityRole === "radio" && node.props.accessibilityLabel === name)[0]!;
  return radio.findAll((node) => node.props.testID === "swatchRing" && typeof node.type === "string")[0]!;
};

const onAndroid = Platform.OS === "android" ? test : test.skip;

onAndroid("on the hand-built Appearance Android keeps, picking a colour fades its swatch ring in and the old one out on Compose's snappy spring, instead of snapping", () => {
  const root = renderSurface(<SettingsView />);
  const plum = PROFILE_COLORS.plum.name;
  const other = Object.values(PROFILE_COLORS).find((color) => color.name !== plum)!.name;
  expect(getAnimatedStyle(ringOf(root, plum)).opacity).toBe(1);
  expect(getAnimatedStyle(ringOf(root, other)).opacity).toBe(0);
  const radio = root.root.findAll((node) => node.props.accessibilityRole === "radio" && node.props.accessibilityLabel === other && typeof node.props.onPress === "function")[0]!;
  act(() => radio.props.onPress());
  act(() => jest.advanceTimersByTime(48));
  const rising = getAnimatedStyle(ringOf(root, other)).opacity as number;
  const falling = getAnimatedStyle(ringOf(root, plum)).opacity as number;
  expect(rising).toBeGreaterThan(0);
  expect(rising).toBeLessThan(1);
  expect(falling).toBeGreaterThan(0);
  expect(falling).toBeLessThan(1);
  act(() => jest.advanceTimersByTime(1000));
  expect(getAnimatedStyle(ringOf(root, other)).opacity).toBeCloseTo(1, 2);
  expect(getAnimatedStyle(ringOf(root, plum)).opacity).toBeCloseTo(0, 2);
  unmount(root);
});
