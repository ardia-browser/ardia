import type { ReactElement } from "react";
import { Text } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { DeckBottomBar } from "../components/tabs/DeckBottomBar";
import { FullSheet, Sheet } from "../components/ui";
import { FABRIC_CATCH_UP_MS, FABRIC_CATCH_UP_PING_MS, FabricCatchUp } from "../components/ui/FabricCatchUp";
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

test("a catch-up given a ping window, as Android's page menu and Settings sheets are, wakes the JS thread at most once per window, and the leaf still remounts once, after the last change", () => {
  const reactions: Array<(now: number, was: number | null) => void> = [];
  jest.spyOn(Reanimated, "useAnimatedReaction").mockImplementation((_prepare, react) => {
    reactions.push(react as (now: number, was: number | null) => void);
  });
  const root = renderSurface(<FabricCatchUp motion={() => 0} pingMs={FABRIC_CATCH_UP_PING_MS} />, { flushTimers: false });
  const first = leaves(root, "fabricCatchUp")[0]!;
  const react = () => reactions[reactions.length - 1]!;
  const waits = jest.spyOn(global, "setTimeout");
  const FRAME = 16;
  const FRAMES = 30;
  for (let frame = 1; frame <= FRAMES; frame++) {
    act(() => react()(frame, frame - 1));
    act(() => jest.advanceTimersByTime(FRAME));
  }
  const pings = waits.mock.calls.filter(([, delay]) => delay === FABRIC_CATCH_UP_MS).length;
  expect(pings).toBeLessThanOrEqual(Math.ceil((FRAMES * FRAME) / FABRIC_CATCH_UP_PING_MS) + 1);
  expect(pings).toBeGreaterThan(1);
  expect(leaves(root, "fabricCatchUp")[0]).toBe(first);
  act(() => jest.advanceTimersByTime(FABRIC_CATCH_UP_MS - FABRIC_CATCH_UP_PING_MS - FRAME));
  expect(leaves(root, "fabricCatchUp")[0]).toBe(first);
  act(() => jest.advanceTimersByTime(FABRIC_CATCH_UP_MS));
  const second = leaves(root, "fabricCatchUp")[0]!;
  expect(second).not.toBe(first);
  act(() => jest.advanceTimersByTime(FABRIC_CATCH_UP_MS * 2));
  expect(leaves(root, "fabricCatchUp")[0]).toBe(second);
  unmount(root);
});

test("a catch-up with no ping window, as the bar, the deck, search and the iPhone's sheets keep, still wakes the JS thread on every change", () => {
  const reactions: Array<(now: number, was: number | null) => void> = [];
  jest.spyOn(Reanimated, "useAnimatedReaction").mockImplementation((_prepare, react) => {
    reactions.push(react as (now: number, was: number | null) => void);
  });
  const root = renderSurface(<FabricCatchUp motion={() => 0} />, { flushTimers: false });
  const react = () => reactions[reactions.length - 1]!;
  const waits = jest.spyOn(global, "setTimeout");
  for (let frame = 1; frame <= 10; frame++) {
    act(() => react()(frame, frame - 1));
    act(() => jest.advanceTimersByTime(16));
  }
  expect(waits.mock.calls.filter(([, delay]) => delay === FABRIC_CATCH_UP_MS)).toHaveLength(10);
  unmount(root);
});

test("the page menu's sheet hands its ping window to its catch-up, and the full-height sheets keep every change", () => {
  const pingOf = (node: ReactElement, testID: string) => {
    const root = renderSurface(node);
    const ping = root.root.findAll((child) => child.type === FabricCatchUp && child.props.testID === testID)[0]!.props.pingMs;
    unmount(root);
    return ping;
  };
  expect(pingOf(<Sheet open onDismiss={() => undefined} onHidden={() => undefined} catchUpPingMs={FABRIC_CATCH_UP_PING_MS}><Text>Menu</Text></Sheet>, "sheetFabricCatchUp")).toBe(FABRIC_CATCH_UP_PING_MS);
  expect(pingOf(<Sheet open onDismiss={() => undefined} onHidden={() => undefined}><Text>Menu</Text></Sheet>, "sheetFabricCatchUp")).toBeUndefined();
  expect(pingOf(<FullSheet sheet="settings" progress={{ value: 0 } as never} onDismiss={() => undefined}>{() => <Text>Settings</Text>}</FullSheet>, "fullSheetFabricCatchUp")).toBeUndefined();
});
