import { Platform, StyleSheet, Text } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import * as Reanimated from "react-native-reanimated";
import { act } from "react-test-renderer";
import { FullSheet, Sheet } from "../components/ui";
import { renderSurface, unmount, updateSurface } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const SHEET_HEIGHT = 500;

function openSheet(onDismiss: () => void, onHidden: () => void = () => undefined, open = true) {
  const root = renderSurface(
    <Sheet open={open} onDismiss={onDismiss} onHidden={onHidden}>
      <Text>Menu</Text>
    </Sheet>,
  );
  const panel = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityViewIsModal === true)[0]!;
  act(() => panel.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: SHEET_HEIGHT } } }));
  return root;
}

function drag(translationY: number, velocityY: number) {
  act(() =>
    fireGestureHandler(getByGestureTestId("sheetDrag"), [
      { state: State.BEGAN, translationY: 0, velocityY: 0 },
      { state: State.ACTIVE, translationY: translationY / 2, velocityY },
      { state: State.ACTIVE, translationY, velocityY },
      { state: State.END, translationY, velocityY },
    ]),
  );
  act(() => jest.runOnlyPendingTimers());
}

test("dragging the sheet down past 35% of its height, capped at 120 points, closes it, as Compose's tray drag", () => {
  const dismiss = jest.fn();
  const root = openSheet(dismiss);
  drag(130, 0);
  expect(dismiss).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("a short slow drag springs back, and a flick past 800 points a second closes it however short", () => {
  const dismiss = jest.fn();
  const root = openSheet(dismiss);
  drag(40, 100);
  expect(dismiss).not.toHaveBeenCalled();
  drag(30, 900);
  expect(dismiss).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("with Reduce Motion the sheet leaves on a short timing instead of its spring, and with Android's Remove animations it leaves at once, as Compose's sheets do when the system scales their durations to zero", () => {
  mockMotion.reduced = true;
  const timing = jest.spyOn(Reanimated, "withTiming");
  const spring = jest.spyOn(Reanimated, "withSpring");
  const root = renderSurface(
    <Sheet open={false} onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Menu</Text>
    </Sheet>,
  );
  expect(timing).toHaveBeenCalledWith(0, expect.objectContaining({ duration: Platform.OS === "android" ? 0 : 200 }), expect.any(Function));
  expect(spring.mock.calls.filter(([to]) => to === 0)).toHaveLength(0);
  unmount(root);
  mockMotion.reduced = false;
});

test("with Remove animations on Android the Settings sheet comes up and goes at once, as Compose's do; with Reduce Motion on iPhone it moves on a short timing", () => {
  mockMotion.reduced = true;
  const timing = jest.spyOn(Reanimated, "withTiming");
  const progress = { value: 0 } as never;
  const root = renderSurface(
    <FullSheet sheet={null} progress={progress} onDismiss={() => undefined}>
      {() => <Text>Settings</Text>}
    </FullSheet>,
  );
  updateSurface(
    root,
    <FullSheet sheet="settings" progress={progress} onDismiss={() => undefined}>
      {() => <Text>Settings</Text>}
    </FullSheet>,
  );
  expect(timing).toHaveBeenCalledWith(0, expect.objectContaining({ duration: Platform.OS === "android" ? 0 : 200 }));
  unmount(root);
  mockMotion.reduced = false;
  timing.mockRestore();
});

test("on iPhone the Settings sheet starts at the safe area and its bottom corners follow the display's, as main's iOS sheet does; on Android it keeps Compose's 10-point gap and square bottom", () => {
  const progress = { value: 0 } as never;
  const root = renderSurface(
    <FullSheet sheet="settings" progress={progress} onDismiss={() => undefined}>
      {() => <Text>Settings</Text>}
    </FullSheet>,
  );
  const panel = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityViewIsModal === true)[0]!;
  const style = StyleSheet.flatten(panel.props.style);
  const ios = Platform.OS === "ios";
  expect(style.top).toBe(ios ? 40 : 50);
  expect(style.borderBottomLeftRadius).toBe(ios ? 55 : 0);
  expect(style.borderBottomRightRadius).toBe(style.borderBottomLeftRadius);
  unmount(root);
});
