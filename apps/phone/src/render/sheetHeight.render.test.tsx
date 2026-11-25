import { Platform, ScrollView, StyleSheet, Text } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Sheet, SheetScrollView, sheetMaxHeight } from "../components/ui";
import { sheetPullOffset } from "../components/ui/Sheet";
import { renderSurface, unmount } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;
const SCREEN = 873;
const TOP_INSET = 40;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const panelOf = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityViewIsModal === true)[0]!;
const flat = (node: ReactTestInstance | undefined) => StyleSheet.flatten(node?.props.style) ?? {};

function drag(translationY: number, velocityY = 0) {
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

function tallSheet(onDismiss: () => void, onTapAway?: () => void) {
  const root = renderSurface(
    <Sheet open onDismiss={onDismiss} onHidden={() => undefined} onTapAway={onTapAway}>
      <SheetScrollView testID="tallMenu">
        <Text>Rows</Text>
      </SheetScrollView>
    </Sheet>,
  );
  act(() => panelOf(root).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 780 } } }));
  const list = root.root.findAll((node) => node.type === ScrollView || (typeof node.type !== "string" && node.props.testID === "tallMenu" && typeof node.props.onContentSizeChange === "function"))[0]!;
  act(() => {
    list.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 700 } } });
    list.props.onContentSizeChange(393, 1200);
  });
  return root;
}

onIos("on iPhone a tall sheet stops 10 points below the safe top and draws a grabber", () => {
  expect(sheetMaxHeight(SCREEN, 59)).toBe(SCREEN - 59 - 10);
  expect(sheetMaxHeight(568, 20)).toBe(568 - 20 - 10);
  const root = renderSurface(
    <Sheet open onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Menu</Text>
    </Sheet>,
  );
  expect(flat(panelOf(root)).maxHeight).toBe(SCREEN - TOP_INSET - 10);
  expect(root.root.findAll((node) => node.props.testID === "sheetGrabber" && typeof node.type === "string")).toHaveLength(1);
  unmount(root);
});

onIos("a tap on the page above the sheet closes it and reports the tap", () => {
  const dismiss = jest.fn();
  const tapped = jest.fn();
  const root = tallSheet(dismiss, tapped);
  act(() => {
    root.root.findAll((node) => node.props.accessibilityLabel === "Close" && typeof node.props.onPress === "function")[0]!.props.onPress();
  });
  expect(tapped).toHaveBeenCalledTimes(1);
  expect(dismiss).toHaveBeenCalledTimes(1);
  unmount(root);
});

onIos("a menu taller than the sheet scrolls inside it, and a drag down from its top still closes the sheet while a drag up never does", () => {
  const dismiss = jest.fn();
  const root = tallSheet(dismiss);
  drag(-200);
  expect(dismiss).not.toHaveBeenCalled();
  drag(200);
  expect(dismiss).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("the pull follows the finger only downward and only from the top while the content scrolls; a sheet that doesn't scroll keeps today's drag", () => {
  expect(sheetPullOffset(100, true, true)).toBeGreaterThan(0);
  expect(sheetPullOffset(100, true, false)).toBe(0);
  expect(sheetPullOffset(-50, true, true)).toBe(0);
  expect(sheetPullOffset(100, false, false)).toBeGreaterThan(0);
});

onAndroid("Android's sheet keeps its height rule and has no grabber, and a tap above reports nothing", () => {
  expect(sheetMaxHeight(SCREEN, 24)).toBe(SCREEN - 24 - 24);
  const tapped = jest.fn();
  const dismiss = jest.fn();
  const root = renderSurface(
    <Sheet open onDismiss={dismiss} onHidden={() => undefined} onTapAway={tapped}>
      <Text>Menu</Text>
    </Sheet>,
  );
  expect(root.root.findAll((node) => node.props.testID === "sheetGrabber")).toHaveLength(0);
  act(() => {
    root.root.findAll((node) => node.props.accessibilityLabel === "Close" && typeof node.props.onPress === "function")[0]!.props.onPress();
  });
  expect(tapped).not.toHaveBeenCalled();
  expect(dismiss).toHaveBeenCalledTimes(1);
  unmount(root);
});
