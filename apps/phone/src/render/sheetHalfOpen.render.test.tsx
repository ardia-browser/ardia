import { Platform, ScrollView, StyleSheet, Text } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Sheet, SheetScrollView, sheetMaxHeight } from "../components/ui";
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
