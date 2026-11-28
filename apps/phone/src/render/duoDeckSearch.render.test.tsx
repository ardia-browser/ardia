import { Dimensions, Keyboard, Platform, StyleSheet, type KeyboardEvent } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider } from "../components/ui";
import { setRootSize } from "../state/app/rootSize";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const PORTRAIT = Dimensions.get("window");

function onScreen(width: number, height: number, hinge: ScreenHinge, right: number) {
  Dimensions.set({ window: { ...PORTRAIT, width, height }, screen: { ...PORTRAIT, width, height } });
  act(() => setRootSize(width, height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 0, bottom: 34, left: 0, right }));
  act(() => useScreenLayout.setState({ hinge }));
}

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  act(() => setRootSize(0, 0));
  act(() => useScreenLayout.setState({ hinge: "none" }));
  Dimensions.set({ window: PORTRAIT, screen: PORTRAIT });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const deck = () => renderSurface(<DesignProvider design="redesigned"><TabDeck /></DesignProvider>);
const settle = () => {
  for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
};
const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const host = (root: Root, testID: string) => hosts(root, testID)[0];
const shown = (node: ReactTestInstance) => ({ ...StyleSheet.flatten(node.props.style), ...(node.props.style ? getAnimatedStyle(node) : {}) }) as { opacity?: number; marginLeft?: number; paddingLeft?: number; paddingRight?: number; right?: number; width?: number };
const field = (root: Root) => root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onFocus === "function")[0]!;

test("on the open Duo the deck's Search Tabs is a field on the bar's line from 399 to 859, 8 short of the strip, with no magnifier circle; focusing it counts search_tabs_opened and moves nothing", () => {
  onScreen(951, 669, "fullyOpen", 84);
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = deck();
  const bar = () => shown(host(root, "deckBottomBar")!);
  expect(bar()).toMatchObject({ paddingLeft: 399, paddingRight: 92 });
  expect(951 - 92).toBe(951 - 84 - 8);
  expect(host(root, "deckSearchCircle")).toBeUndefined();
  expect(host(root, "deckSearchGrow")).toBeUndefined();
  expect(shown(host(root, "deckHit-search")!)).toMatchObject({ flex: 1 });
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityElementsHidden === true && node.findAll((inner) => inner.props.testID === "deckSearchField").length > 0)).toHaveLength(0);
  act(() => field(root).props.onFocus());
  act(() => field(root).props.onChangeText("site1"));
  settle();
  expect(counted.mock.calls.filter(([name]) => name === "search_tabs_opened")).toHaveLength(1);
  expect(bar()).toMatchObject({ paddingLeft: 399, paddingRight: 92 });
  expect(shown(host(root, "deckHit-search")!).marginLeft).toBeUndefined();
  unmount(root);
});

for (const [name, width, hinge, right] of [["closed Duo", 466, "closed", 84], ["phone with no hinge", 402, "none", 0]] as const) {
  test(`on a ${name} the deck keeps its Search Tabs field across the bottom row, with no circle`, () => {
    onScreen(width, 874, hinge, right);
    const root = deck();
    expect(host(root, "deckSearchGrow")).toBeUndefined();
    expect(host(root, "deckSearchCircle")).toBeUndefined();
    expect(host(root, "deckSearchTabs")).toBeDefined();
    unmount(root);
  });
}

test("on the open Duo the field stays at 399 to 859 while typing with the keyboard up and after it goes down: it no longer widens left over the switcher", () => {
  const listeners = new Map<string, ((event: KeyboardEvent) => void)[]>();
  jest.spyOn(Keyboard, "metrics").mockReturnValue(undefined);
  jest.spyOn(Keyboard, "addListener").mockImplementation((name, listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    return { remove: () => listeners.set(name, (listeners.get(name) ?? []).filter((one) => one !== listener)) } as never;
  });
  const keyboard = (shows: boolean) => {
    const name = Platform.OS === "ios" ? (shows ? "keyboardWillShow" : "keyboardWillHide") : shows ? "keyboardDidShow" : "keyboardDidHide";
    act(() => (listeners.get(name) ?? []).forEach((listener) => listener({ endCoordinates: { height: shows ? 300 : 0, screenX: 0, screenY: shows ? 369 : 669, width: 951 } } as never)));
  };
  onScreen(951, 669, "fullyOpen", 84);
  const root = deck();
  act(() => field(root).props.onFocus());
  keyboard(true);
  settle();
  expect(shown(host(root, "deckBottomBar")!)).toMatchObject({ paddingLeft: 399, paddingRight: 92 });
  expect(shown(host(root, "deckHit-search")!).marginLeft).toBeUndefined();
  act(() => field(root).props.onChangeText("verge"));
  keyboard(false);
  act(() => field(root).props.onBlur());
  settle();
  expect(shown(host(root, "deckBottomBar")!)).toMatchObject({ paddingLeft: 399, paddingRight: 92 });
  unmount(root);
});
