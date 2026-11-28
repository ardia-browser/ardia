import { Pressable, StyleSheet } from "react-native";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { ToastHost } from "../components/toasts/ToastHost";
import { press } from "../components/ui";
import { holdToast, showToast, useToasts } from "../state/toasts/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

type Point = { absoluteX: number; absoluteY: number; x: number; y: number; id: number };
type TouchEvent = { allTouches: Point[]; changedTouches: Point[]; numberOfTouches: number };
type Manager = { activate: jest.Mock; end: jest.Mock; fail: jest.Mock };
type Handlers = { onTouchesDown: (event: TouchEvent, manager: Manager) => void; onTouchesMove: (event: TouchEvent, manager: Manager) => void; onTouchesUp: (event: TouchEvent, manager: Manager) => void; onTouchesCancelled: (event: TouchEvent, manager: Manager) => void };

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useToasts.setState({ toast: null });
});

afterEach(() => {
  act(() => holdToast(false));
  act(() => useToasts.setState({ toast: null }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const touchOf = () => (getByGestureTestId("toastTouch") as unknown as { handlers: Handlers }).handlers;
const manager = (): Manager => ({ activate: jest.fn(), end: jest.fn(), fail: jest.fn() });
const at = (absoluteX: number, absoluteY: number, local = { x: 10, y: 10 }): TouchEvent => {
  const point = { absoluteX, absoluteY, x: local.x, y: local.y, id: 0 };
  return { allTouches: [point], changedTouches: [point], numberOfTouches: 1 };
};
const lifted = (): TouchEvent => ({ allTouches: [], changedTouches: [{ absoluteX: 0, absoluteY: 0, x: 0, y: 0, id: 0 }], numberOfTouches: 0 });
const frames = (ms = 600) => act(() => jest.advanceTimersByTime(ms));
const cardOf = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "toast" && typeof node.type === "string")[0]!;

test("the card is one native touch target: no JS responder Pressable inside the gesture that could lose the tap to it", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast({ key: "download:1", title: "2 downloads complete", detail: "a.pdf, b.zip", tile: { kind: "count", count: 2 }, action: { label: "Show", run: () => undefined } }));
  const card = cardOf(root);
  expect(root.root.findAll((node) => node.type === Pressable)).toHaveLength(0);
  expect(card.props.onPress).toBeUndefined();
  expect(card.props.onStartShouldSetResponder).toBeUndefined();
  expect(card.props.collapsable).toBe(false);
  expect(root.root.findAll((node) => node.props.testID === "toastPlace" && typeof node.type === "string")[0]!.props.collapsable).toBe(false);
  unmount(root);
});

test("a tap on a card that moves or updates in place under a still finger still runs its action, and dims while the finger is down", () => {
  const show = jest.fn();
  const root = renderSurface(<ToastHost />);
  act(() => showToast({ key: "download:1", title: "a.pdf", detail: "Downloaded · 2 KB", tile: { kind: "file", ext: "pdf" }, action: { label: "Open", run: () => undefined } }));
  frames();
  const touch = touchOf();
  const hand = manager();
  act(() => touch.onTouchesDown(at(908, 2107, { x: 842, y: 79 }), hand));
  expect(getAnimatedStyle(cardOf(root)).opacity).toBeCloseTo(press.filledOpacity, 5);
  act(() => showToast({ key: "download:1", title: "2 downloads complete", detail: "a.pdf, b.zip", tile: { kind: "count", count: 2 }, action: { label: "Show", run: show } }));
  act(() => touch.onTouchesMove(at(908, 2107, { x: 842, y: 40 }), hand));
  act(() => touch.onTouchesUp(lifted(), hand));
  frames(16);
  expect(hand.activate).not.toHaveBeenCalled();
  expect(hand.end).toHaveBeenCalled();
  expect(show).toHaveBeenCalledTimes(1);
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("a card without an action ignores a tap but still drags away", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  frames();
  const touch = touchOf();
  const tap = manager();
  act(() => touch.onTouchesDown(at(500, 2100), tap));
  expect(getAnimatedStyle(cardOf(root)).opacity).not.toBeCloseTo(press.filledOpacity, 5);
  act(() => touch.onTouchesUp(lifted(), tap));
  frames(16);
  expect(useToasts.getState().toast).not.toBeNull();
  const drag = manager();
  act(() => touch.onTouchesDown(at(500, 2100), drag));
  act(() => touch.onTouchesMove(at(500, 2112), drag));
  act(() => touch.onTouchesMove(at(500, 2140), drag));
  expect(drag.activate).toHaveBeenCalledTimes(1);
  act(() => touch.onTouchesUp(lifted(), drag));
  frames(16);
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("a short drag holds the card and lets it settle back, and a dragged tap never runs the action", () => {
  const run = jest.fn();
  const root = renderSurface(<ToastHost />);
  act(() => showToast({ title: "Couldn’t download a.pdf", detail: "The site didn’t send the file.", tile: { kind: "icon", icon: "warning" }, action: { label: "Retry", run } }));
  frames();
  const touch = touchOf();
  const hand = manager();
  act(() => touch.onTouchesDown(at(900, 2100), hand));
  act(() => jest.advanceTimersByTime(200));
  act(() => touch.onTouchesMove(at(900, 2110), hand));
  act(() => jest.advanceTimersByTime(200));
  act(() => touch.onTouchesMove(at(900, 2112), hand));
  act(() => touch.onTouchesUp(lifted(), hand));
  frames(16);
  expect(run).not.toHaveBeenCalled();
  expect(useToasts.getState().toast).not.toBeNull();
  act(() => jest.advanceTimersByTime(1300));
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("a leaving card takes no touches and hides from screen readers, so nothing lands on a card that is on its way out", () => {
  const root = renderSurface(<ToastHost />, { flushTimers: false });
  act(() => showToast("Copied Link", "link"));
  act(() => useToasts.setState({ toast: null }));
  const card = cardOf(root);
  expect(card.props.pointerEvents).toBe("none");
  expect(card.props.importantForAccessibility).toBe("no-hide-descendants");
  expect(StyleSheet.flatten(card.props.style).position).toBeUndefined();
  unmount(root);
});
