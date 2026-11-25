import { Platform, ScrollView, StyleSheet, Text } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance } from "react-test-renderer";
import { floatingSheetLayout, menuLayout, Sheet, SheetScrollView, sheetMaxHeight } from "../components/ui";
import { renderSurface, unmount } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const panelOf = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityViewIsModal === true)[0]!;
const flat = (node: ReactTestInstance | undefined) => StyleSheet.flatten(node?.props.style) ?? {};
const listOf = (root: Root) => root.root.findAll((node) => node.type === ScrollView)[0]!;

function drag(translationY: number, velocityY = 0) {
  act(() =>
    fireGestureHandler(getByGestureTestId("sheetDrag"), [
      { state: State.BEGAN, translationY: 0, velocityY: 0 },
      { state: State.ACTIVE, translationY: translationY / 2, velocityY },
      { state: State.ACTIVE, translationY, velocityY },
      { state: State.END, translationY, velocityY },
    ]),
  );
  act(() => jest.advanceTimersByTime(2000));
}

function HalfMenu({ onDismiss, onExpand }: { onDismiss: () => void; onExpand: () => void }) {
  return (
    <Sheet open halfOpen onDismiss={onDismiss} onExpand={onExpand} onHidden={() => undefined}>
      <SheetScrollView testID="halfMenu">
        <Text>Rows</Text>
      </SheetScrollView>
    </Sheet>
  );
}

function halfMenu(onDismiss: () => void, onExpand: () => void) {
  const root = renderSurface(<HalfMenu onDismiss={onDismiss} onExpand={onExpand} />);
  const full = flat(panelOf(root)).height as number;
  act(() => panelOf(root).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: full } } }));
  act(() => {
    listOf(root).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: full - 14 } } });
    listOf(root).props.onContentSizeChange(393, full * 2);
  });
  return root;
}

onAndroid("the page menu sheet opens at half height with a handle, drags up to full, back down to half, then closes", () => {
  const dismiss = jest.fn();
  const expand = jest.fn();
  const root = halfMenu(dismiss, expand);
  expect(flat(panelOf(root)).height).toBeGreaterThan(0);
  expect(root.root.findAll((node) => node.props.testID === "sheetGrabber" && typeof node.type === "string")).toHaveLength(1);
  expect(listOf(root).props.scrollEnabled).toBe(false);

  drag(-400, -900);
  expect(expand).toHaveBeenCalledTimes(1);
  expect(listOf(root).props.scrollEnabled).not.toBe(false);
  expect(dismiss).not.toHaveBeenCalled();

  drag(-200);
  expect(listOf(root).props.scrollEnabled).not.toBe(false);

  drag(220, 600);
  expect(listOf(root).props.scrollEnabled).toBe(false);
  expect(dismiss).not.toHaveBeenCalled();

  drag(200);
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(expand).toHaveBeenCalledTimes(1);
  unmount(root);
});

onAndroid("a short drag up from half springs back to half", () => {
  const expand = jest.fn();
  const root = halfMenu(jest.fn(), expand);
  drag(-40);
  expect(expand).not.toHaveBeenCalled();
  expect(listOf(root).props.scrollEnabled).toBe(false);
  unmount(root);
});

onAndroid("a sheet without halfOpen keeps its fitted height and no handle", () => {
  const root = renderSurface(
    <Sheet open onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Menu</Text>
    </Sheet>,
  );
  expect(flat(panelOf(root)).height).toBeUndefined();
  expect(flat(panelOf(root)).maxHeight).toBeGreaterThan(0);
  expect(root.root.findAll((node) => node.props.testID === "sheetGrabber")).toHaveLength(0);
  expect(sheetMaxHeight(873, 24)).toBe(873 - 24 - 24);
  unmount(root);
});

const WINDOW = { width: 393, height: 873 };
const byTestId = (root: Root, id: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === id)[0]!;
const moved = (node: ReactTestInstance) => {
  const steps = (getAnimatedStyle(node).transform ?? []) as { translateY?: number; scale?: number }[];
  return { y: steps.reduce((sum, step) => sum + (step.translateY ?? 0), 0), scale: steps.reduce((product, step) => product * (step.scale ?? 1), 1) };
};

function cardGeometry(root: Root) {
  const full = flat(panelOf(root)).height as number;
  const card = moved(byTestId(root, "floatingSheetCard"));
  const window = moved(byTestId(root, "floatingSheetTop")).y;
  const bottomStyle = getAnimatedStyle(byTestId(root, "sheetFill")) as { borderBottomLeftRadius: number };
  const bottom = WINDOW.height + card.y;
  return {
    side: (WINDOW.width - WINDOW.width * card.scale) / 2,
    bottomInset: WINDOW.height - bottom,
    height: card.scale * (full - window),
    topRadius: menuLayout.sheetRadius * card.scale,
    bottomRadius: bottomStyle.borderBottomLeftRadius * card.scale,
    rowsShift: moved(byTestId(root, "floatingSheetContent")).y - window,
  };
}

function floatingMenu(onDismiss: () => void, onExpand: () => void) {
  const root = renderSurface(
    <Sheet open floating grabber onDismiss={onDismiss} onExpand={onExpand} onHidden={() => undefined}>
      <SheetScrollView testID="floatingMenu">
        <Text>Rows</Text>
      </SheetScrollView>
    </Sheet>,
  );
  const full = flat(panelOf(root)).height as number;
  act(() => panelOf(root).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: WINDOW.width, height: full } } }));
  act(() => {
    listOf(root).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: WINDOW.width, height: full } } });
    listOf(root).props.onContentSizeChange(WINDOW.width, full * 2);
  });
  act(() => jest.advanceTimersByTime(2000));
  return root;
}

test("a floating sheet rests as the iPhone's medium card: inset 8 on the sides and bottom, 450 tall on an 873 high screen, every corner rounded, its rows pinned to its top", () => {
  const root = floatingMenu(jest.fn(), jest.fn());
  const half = cardGeometry(root);
  expect(half.side).toBeCloseTo(floatingSheetLayout.inset, 1);
  expect(half.bottomInset).toBeCloseTo(floatingSheetLayout.inset, 1);
  expect(half.height).toBeCloseTo(WINDOW.height * floatingSheetLayout.halfShare, 0);
  expect(half.height).toBeCloseTo(450, 0);
  expect(half.bottomRadius).toBeCloseTo(floatingSheetLayout.bottomRadius, 1);
  expect(half.topRadius).toBeCloseTo(36.5, 0);
  expect(half.rowsShift).toBe(0);
  const grabber = flat(byTestId(root, "sheetGrabber"));
  expect([grabber.width, grabber.height, grabber.top]).toEqual([60, 4, 6]);
  expect(listOf(root).props.scrollEnabled).toBe(false);
  unmount(root);
});

test("dragging the floating card up grows it into the full, edge-to-edge sheet with square bottom corners, and down from there returns the card", () => {
  const dismiss = jest.fn();
  const expand = jest.fn();
  const root = floatingMenu(dismiss, expand);
  drag(-500, -900);
  expect(expand).toHaveBeenCalledTimes(1);
  const full = cardGeometry(root);
  expect(full.side).toBeCloseTo(0, 5);
  expect(full.bottomInset).toBeCloseTo(0, 5);
  expect(full.height).toBeCloseTo(flat(panelOf(root)).height as number, 5);
  expect(full.bottomRadius).toBeCloseTo(0, 5);
  expect(listOf(root).props.scrollEnabled).not.toBe(false);

  drag(260, 900);
  const half = cardGeometry(root);
  expect(half.side).toBeCloseTo(floatingSheetLayout.inset, 1);
  expect(half.height).toBeCloseTo(450, 0);
  expect(dismiss).not.toHaveBeenCalled();

  drag(240, 900);
  expect(dismiss).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("pulling the floating card down slides the whole card rather than shrinking it from the top", () => {
  const root = floatingMenu(jest.fn(), jest.fn());
  act(() =>
    fireGestureHandler(getByGestureTestId("sheetDrag"), [
      { state: State.BEGAN, translationY: 0, velocityY: 0 },
      { state: State.ACTIVE, translationY: 30, velocityY: 0 },
      { state: State.ACTIVE, translationY: 60, velocityY: 0 },
    ]),
  );
  act(() => jest.advanceTimersByTime(32));
  const pulled = cardGeometry(root);
  expect(pulled.height).toBeCloseTo(450, 0);
  expect(pulled.bottomInset).toBeLessThan(floatingSheetLayout.inset - 30);
  expect(pulled.side).toBeCloseTo(floatingSheetLayout.inset, 1);
  unmount(root);
});
