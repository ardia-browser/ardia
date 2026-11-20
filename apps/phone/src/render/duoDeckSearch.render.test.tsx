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
const circle = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Search Tabs" && typeof node.props.onPress === "function" && node.props.testID !== "deckSearchField")[0];

test("on the open Duo the deck's Search Tabs rests as a 48 magnifier circle in the strip's bottom slot, with no field showing", () => {
  onScreen(951, 669, "fullyOpen", 84);
  const root = deck();
  expect(shown(host(root, "deckBottomBar")!)).toMatchObject({ paddingLeft: 527, paddingRight: 24 });
  expect(shown(host(root, "deckSearchGrow")!).marginLeft).toBeCloseTo(352, 3);
  expect(951 - 24).toBe(903 + 24);
  expect(shown(host(root, "deckSearchCircle")!)).toMatchObject({ right: 0, width: 48 });
  expect(shown(host(root, "deckSearchCircle")!).opacity).toBeCloseTo(1, 3);
  expect(root.root.findAll((node) => node.props.testID === "deckSearchCircleGlyph" && node.props.systemName === "magnifyingglass").length).toBeGreaterThan(0);
  expect(circle(root)).toBeDefined();
  expect(shown(host(root, "deckSearchTabsFade")!).opacity).toBeCloseTo(0, 3);
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityElementsHidden === true && node.findAll((inner) => inner.props.testID === "deckSearchField").length > 0).length).toBeGreaterThan(0);
  unmount(root);
});

test("on the open Duo pressing the circle opens Search Tabs: the field grows left out of the slot to 527..927, counts search_tabs_opened, and shrinks back when it closes empty", () => {
  onScreen(951, 669, "fullyOpen", 84);
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = deck();
  act(() => circle(root)!.props.onPress());
  act(() => field(root).props.onFocus());
  settle();
  expect(counted.mock.calls.filter(([name]) => name === "search_tabs_opened")).toHaveLength(1);
  expect(shown(host(root, "deckSearchGrow")!).marginLeft).toBeCloseTo(0, 3);
  expect(shown(host(root, "deckSearchTabsFade")!).opacity).toBeCloseTo(1, 3);
  expect(shown(host(root, "deckSearchCircle")!).opacity).toBeCloseTo(0, 3);
  expect(host(root, "deckSearchCircle")!.props.pointerEvents).toBe("none");
  act(() => field(root).props.onChangeText("site1"));
  act(() => field(root).props.onBlur());
  settle();
  expect(shown(host(root, "deckSearchGrow")!).marginLeft).toBeCloseTo(0, 3);
  act(() => field(root).props.onChangeText(""));
  settle();
  expect(shown(host(root, "deckSearchGrow")!).marginLeft).toBeCloseTo(352, 3);
  expect(shown(host(root, "deckSearchCircle")!).opacity).toBeCloseTo(1, 3);
  unmount(root);
});

for (const [name, width, hinge, right] of [["closed Duo", 466, "closed", 84], ["phone with no hinge", 402, "none", 0]] as const) {
  test(`on a ${name} the deck keeps its Search Tabs field across the bottom row, with no circle`, () => {
    onScreen(width, 874, hinge, right);
    const root = deck();
    expect(host(root, "deckSearchGrow")).toBeUndefined();
    expect(host(root, "deckSearchCircle")).toBeUndefined();
    expect(host(root, "deckSearchTabs")).toBeDefined();
    expect(shown(host(root, "deckSearchTabsFade")!).opacity ?? 1).toBe(1);
    unmount(root);
  });
}

test("on the open Duo, while typing with the keyboard up the field runs from 24 to the slot's right edge, back to 400 with the keyboard down and a query, and into the circle once cleared", () => {
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
  expect(shown(host(root, "deckSearchGrow")!).marginLeft).toBeCloseTo(-503, 3);
  expect(527 - 503).toBe(24);
  act(() => field(root).props.onChangeText("verge"));
  keyboard(false);
  act(() => field(root).props.onBlur());
  settle();
  expect(shown(host(root, "deckSearchGrow")!).marginLeft).toBeCloseTo(0, 3);
  act(() => field(root).props.onChangeText(""));
  settle();
  expect(shown(host(root, "deckSearchGrow")!).marginLeft).toBeCloseTo(352, 3);
  unmount(root);
});
