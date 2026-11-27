import { predictiveBack, type PredictiveBackHandlers } from "@ardia/phone-native";
import { Platform, Text } from "react-native";
import { act } from "react-test-renderer";
import { Dialog, DesignProvider, Menu, Sheet } from "../components/ui";
import { backSwipe, materialSheetBackOffset, materialSheetFrame, onMaterialBackSwiped } from "../components/ui/MaterialSurfaces";
import { floatingPanelLayout } from "../components/ui/tokens";
import { renderSurface, unmount, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const claims: PredictiveBackHandlers[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  claims.length = 0;
  jest.spyOn(predictiveBack, "isNative").mockImplementation(() => true);
  jest.spyOn(predictiveBack, "claim").mockImplementation((handlers) => {
    claims.push(handlers);
    return { remove: () => void claims.splice(claims.indexOf(handlers), 1) };
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const material = (node: React.ReactNode) => renderSurface(<DesignProvider design="material">{node}</DesignProvider>);
const top = () => claims[claims.length - 1]!;

onAndroid("an open Material sheet claims predictive back: it follows the swipe down by up to 72 dp, and a committed swipe dismisses it", () => {
  const dismissed = jest.fn();
  const root = material(
    <Sheet open onDismiss={dismissed} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  expect(claims).toHaveLength(1);
  expect(materialSheetBackOffset(0.5)).toBe(36);
  expect(materialSheetBackOffset(2)).toBe(72);
  act(() => top().onProgress?.(0.5, "left"));
  act(() => top().onCancel?.());
  expect(dismissed).not.toHaveBeenCalled();
  act(() => top().onCommit?.());
  expect(dismissed).toHaveBeenCalledTimes(1);
  unmount(root);
  expect(claims).toHaveLength(0);
});

onAndroid("when a Material sheet has an onBack handler, a committed back invokes onBack instead of dismissing the sheet", () => {
  const dismissed = jest.fn();
  const back = jest.fn();
  const root = material(
    <Sheet open onDismiss={dismissed} onBack={back} onHidden={() => undefined}>
      <Text>Subpage</Text>
    </Sheet>,
  );
  act(() => top().onProgress?.(0.5, "left"));
  act(() => top().onCommit?.());
  expect(back).toHaveBeenCalledTimes(1);
  expect(dismissed).not.toHaveBeenCalled();
  unmount(root);
});

onAndroid("a Material dialog opened over a sheet takes Back from it, and gives it back when it closes", () => {
  const sheet = jest.fn();
  const dialog = jest.fn();
  const root = material(
    <Sheet open onDismiss={sheet} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  const over = material(<Dialog title="Close All Tabs?" onDismiss={dialog} buttons={[{ title: "Cancel", onPress: dialog }]} />);
  act(() => top().onCommit?.());
  expect(dialog).toHaveBeenCalledTimes(1);
  unmount(over);
  act(() => top().onCommit?.());
  expect(sheet).toHaveBeenCalledTimes(1);
  unmount(root);
});

onAndroid("a closed sheet holds no claim", () => {
  const root = material(
    <Sheet open={false} onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  expect(claims).toHaveLength(0);
  unmount(root);
});

onAndroid("a committed back swipe that moved counts once; a 3-button Back, which never moves, and a cancelled swipe count nothing", () => {
  const counted = jest.fn();
  onMaterialBackSwiped(counted);
  const root = material(
    <Sheet open onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  act(() => top().onCommit?.());
  expect(counted).not.toHaveBeenCalled();
  act(() => top().onProgress?.(0.4, "left"));
  act(() => top().onCancel?.());
  act(() => top().onCommit?.());
  expect(counted).not.toHaveBeenCalled();
  act(() => top().onProgress?.(0.6, "right"));
  act(() => top().onCommit?.());
  expect(counted).toHaveBeenCalledTimes(1);
  unmount(root);
  onMaterialBackSwiped(() => undefined);
  const swipe = backSwipe(counted);
  swipe.progress(0);
  swipe.commit();
  expect(counted).toHaveBeenCalledTimes(1);
});

onAndroid("a back swipe out of a menu opened privately counts nothing, while the same swipe out of a normal menu counts once", () => {
  const counted = jest.fn();
  onMaterialBackSwiped(counted);
  const swipeOut = (privately: boolean) => {
    const dismissed = jest.fn();
    const root = material(<Menu items={[{ label: "Close Incognito Tabs", destructive: true, onPress: () => undefined }]} place={{ top: 100, left: 20 }} privately={privately} onDismiss={dismissed} />);
    act(() => top().onProgress?.(0.6, "left"));
    act(() => top().onCommit?.());
    expect(dismissed).toHaveBeenCalledTimes(1);
    unmount(root);
  };
  swipeOut(true);
  expect(counted).not.toHaveBeenCalled();
  swipeOut(false);
  expect(counted).toHaveBeenCalledTimes(1);
  onMaterialBackSwiped(() => undefined);
});

onAndroid("the sheet's drag-to-dismiss lives on its handle, so a tall sheet's content scrolls instead of dragging the sheet", () => {
  const root = material(
    <Sheet open onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  const grip = root.root.findAll((found) => found.props.testID === "materialSheetGrip" && typeof found.type === "string")[0]!;
  expect(grip.findAll((found) => found.props.testID === "materialDragHandle").length).toBeGreaterThan(0);
  expect(grip.findAll((found) => found.type === Text && found.props.children === "Rows")).toHaveLength(0);
  unmount(root);
});

test("the Material search sheet floats in from the screen edges like the iPhone tray and fills the screen when expanded", () => {
  const gap = floatingPanelLayout.inset;
  expect(materialSheetFrame(0, 0, 400, 400, 400, 0)).toEqual({ left: 0, width: 400 });
  expect(materialSheetFrame(0, 1, 400, 400, 400, 0)).toEqual({ left: gap, width: 400 - gap * 2 });
  expect(materialSheetFrame(0, 0.5, 400, 400, 400, 0)).toEqual({ left: gap / 2, width: 400 - gap });
  expect(materialSheetFrame(1, 1, 400, 400, 400, 0)).toEqual({ left: 0, width: 400 });
  expect(materialSheetFrame(0, 1, 1000, 640, 1000, 0)).toEqual({ left: 180, width: 640 });
});
