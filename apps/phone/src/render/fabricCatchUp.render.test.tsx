import { Text } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { DeckBottomBar } from "../components/tabs/DeckBottomBar";
import { FullSheet, Sheet } from "../components/ui";
import { FABRIC_CATCH_UP_MS, FabricCatchUp } from "../components/ui/FabricCatchUp";
import { renderSurface, unmount } from "../../test/render/harness";


beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const leaves = (root: ReactTestRenderer, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");

const containers = () => [
  { testID: "sheetFabricCatchUp", node: <Sheet open onDismiss={() => undefined} onHidden={() => undefined}><Text>Menu</Text></Sheet> },
  { testID: "fullSheetFabricCatchUp", node: <FullSheet sheet="settings" progress={{ value: 0 } as never} onDismiss={() => undefined}>{() => <Text>Settings</Text>}</FullSheet> },
  { testID: "deckBarFabricCatchUp", node: <DeckBottomBar shown barCenterY={700} deckHeight={800} width={402} layout={{ span: { left: 24, right: 24 }, strip: null }} incognito={false} onQuery={() => undefined} /> },
];

test("on both phones, once a watched motion stops changing, the catch-up remounts its leaf one time, 120 ms after the last change, so Fabric learns where the moved controls are", () => {
  const reactions: Array<(now: number, was: number | null) => void> = [];
  jest.spyOn(Reanimated, "useAnimatedReaction").mockImplementation((_prepare, react) => {
    reactions.push(react as (now: number, was: number | null) => void);
  });
  const root = renderSurface(<FabricCatchUp motion={() => 0} />, { flushTimers: false });
  const first = leaves(root, "fabricCatchUp")[0]!;
  const react = () => reactions[reactions.length - 1]!;
  act(() => react()(1, null));
  act(() => jest.advanceTimersByTime(FABRIC_CATCH_UP_MS * 2));
  expect(leaves(root, "fabricCatchUp")[0]).toBe(first);
  act(() => react()(2, 1));
  act(() => jest.advanceTimersByTime(FABRIC_CATCH_UP_MS - 20));
  act(() => react()(3, 2));
  act(() => jest.advanceTimersByTime(FABRIC_CATCH_UP_MS - 20));
  expect(leaves(root, "fabricCatchUp")[0]).toBe(first);
  act(() => jest.advanceTimersByTime(20));
  const second = leaves(root, "fabricCatchUp")[0]!;
  expect(second).not.toBe(first);
  act(() => react()(3, 3));
  act(() => jest.advanceTimersByTime(FABRIC_CATCH_UP_MS * 2));
  expect(leaves(root, "fabricCatchUp")[0]).toBe(second);
  unmount(root);
});

test("on both phones, where Reanimated writes props straight to the views, the page menu's sheet, the full-height sheets and the deck's bottom bar each carry a catch-up while they're up", () => {
  for (const { testID, node } of containers()) {
    const root = renderSurface(node);
    expect(leaves(root, testID)).toHaveLength(1);
    unmount(root);
  }
});
