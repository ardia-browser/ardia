import { Dimensions, Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { FloatingBar } from "../components/browsing/FloatingBar";
import { SearchTray } from "../components/search/SearchTray";
import { TabDeck } from "../components/tabs/TabDeck";
import { deckArchiveBottom, deckHeaderBottom } from "../components/tabs/DeckHeader";
import { DesignProvider } from "../components/ui";
import { deckGeometry } from "../lib/deckGeometry";
import { forgetLandscapeCount, noteScreenLayoutName, noteWindowShape } from "../state/app/landscapeCount";
import { useArchiveCard } from "../state/browse/archiveCard";
import * as deckGrid from "../state/browse/deckGrid";
import { writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { setRootSize } from "../state/app/rootSize";
import * as browse from "../state/browse/store";
import { presentSearch } from "../state/search/store";
import { currentTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const LANDSCAPE = { width: 852, height: 393 };
const INSETS = { top: 0, bottom: 21, left: 59, right: 59 };
const PORTRAIT = Dimensions.get("window");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  Dimensions.set({ window: { ...PORTRAIT, ...LANDSCAPE }, screen: { ...PORTRAIT, ...LANDSCAPE } });
  act(() => setRootSize(LANDSCAPE.width, LANDSCAPE.height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => INSETS);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  act(() => setRootSize(0, 0));
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  Dimensions.set({ window: PORTRAIT, screen: PORTRAIT });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const hosts = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
const redesigned = (node: React.ReactNode) => renderSurface(<DesignProvider design="redesigned">{node}</DesignProvider>);

test("an iPhone 17 Pro on its side gets main's landscape deck: a 520.3 by 240 card centred at 209, leading 127.8, spacing 422.1, the bar at 361", () => {
  const g = deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", deckHeaderBottom());
  expect(g.cardWidth).toBeCloseTo(520.3, 1);
  expect(g.cardHeight).toBeCloseTo(240, 1);
  expect(g.cardCenterY).toBeCloseTo(209, 1);
  expect(g.focusLeading).toBeCloseTo(127.8, 1);
  expect(g.spacing).toBeCloseTo(422.1, 1);
  expect(g.barCenterY).toBe(361);
  expect(g.safeSide).toBe(59);
});

test("in landscape the deck's header and bottom bar pad by the wider side inset plus 12 on both sides, and on iPhone the grid by it plus 16", () => {
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  const root = redesigned(<TabDeck />);
  expect(flat(hosts(root, "deckBottomBar")[0]!).paddingHorizontal).toBe(59 + 12);
  const header = root.root.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string" && node.props.testID.startsWith("deckHeader"));
  expect(header.length).toBeGreaterThan(0);
  const sides = header.map(flat).flatMap((style) => [style.paddingHorizontal, style.left, style.right, style.paddingLeft, style.paddingRight]).filter((value) => typeof value === "number");
  expect(sides).toContain(59 + 12);
  if (Platform.OS !== "ios") return unmount(root);
  const grid = root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel === "Show as Grid" && typeof node.props.onPress === "function")[0]!;
  act(() => grid.props.onPress());
  act(() => jest.advanceTimersByTime(1000));
  const scroll = hosts(root, "tabGridScroll")[0]!;
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle).paddingHorizontal).toBe(59 + 16);
  unmount(root);
});

test("in landscape the page bar stays one centred row: the wider side inset on both sides, then the bar's own 12, leaving main's 598-point address capsule on an 852 screen", () => {
  act(() => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null }));
  const root = redesigned(<BrowsingScreen tab={currentTabs().open[0]!} />);
  const bar = root.root.findAll((node) => node.type === FloatingBar)[0]!;
  let controls: ReactTestInstance | null = bar.parent;
  while (controls && (typeof controls.type !== "string" || flat(controls).bottom === undefined)) controls = controls.parent;
  expect(flat(controls!).paddingHorizontal).toBe(59);
  const row = bar.findAll((node) => typeof node.type === "string" && flat(node).flexDirection === "row" && flat(node).paddingHorizontal === 12)[0]!;
  const { gap, height } = flat(row) as { gap: number; height: number };
  expect(LANDSCAPE.width - 2 * (59 + 12) - 2 * height - 2 * gap).toBe(598);
  unmount(root);
});

test("in landscape the search panel spans the safe width less 8 on each side, so it clears the island", () => {
  act(() => presentSearch("page"));
  const root = redesigned(<SearchTray />);
  expect(flat(hosts(root, "trayPanel")[0]!)).toMatchObject({ left: 59 + 8, right: 59 + 8 });
  unmount(root);
});

test("turning to landscape is counted once a launch, and a portrait window never counts", () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  forgetLandscapeCount();
  noteWindowShape(393, 852);
  expect(counted).not.toHaveBeenCalled();
  noteWindowShape(852, 393);
  noteWindowShape(393, 852);
  noteWindowShape(852, 393);
  expect(counted.mock.calls).toEqual([["landscape_shown"]]);
  forgetLandscapeCount();
});

test("in landscape the archive capsule shrinks the deck's cards to main's 407.6 by 188, as main's geometry takes the capsule's bottom as the chrome; in portrait on a 402 by 874 iPhone they go from 279.6 to 273.2", () => {
  const archive = deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", deckArchiveBottom());
  expect(archive.cardWidth).toBeCloseTo(407.6, 1);
  expect(archive.cardHeight).toBeCloseTo(188, 1);
  expect(deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", deckHeaderBottom()).cardWidth).toBeCloseTo(279.6, 1);
  expect(deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", deckArchiveBottom()).cardWidth).toBeCloseTo(273.2, 1);
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  act(() => useArchiveCard.setState({ showing: true }));
  const root = redesigned(<TabDeck />);
  const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")[0]!;
  expect(flat(card).width).toBeCloseTo(407.6, 1);
  expect(flat(card).height).toBeCloseTo(188, 1);
  unmount(root);
  act(() => useArchiveCard.setState({ showing: false }));
});

test("a Duo layout is counted once a launch, and the phone layout never counts", () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  forgetLandscapeCount();
  noteScreenLayoutName("phone");
  noteScreenLayoutName("column");
  noteScreenLayoutName("wide");
  noteScreenLayoutName("split");
  expect(counted.mock.calls).toEqual([["duo_layout_shown"]]);
  forgetLandscapeCount();
});

test("in landscape a sheet stops at the side insets and fits the shorter window, and a sheet opened upright refits after a turn, so its top rows stay on screen", () => {
  const { Sheet } = require("../components/ui") as typeof import("../components/ui");
  const panel = (root: Root) => root.root.findAll((node) => node.props.accessibilityViewIsModal === true && typeof node.type === "string")[0]!;
  Dimensions.set({ window: { ...PORTRAIT, width: 393, height: 852 }, screen: { ...PORTRAIT, width: 393, height: 852 } });
  const upright = { top: 47, bottom: 34, left: 0, right: 0 };
  const insets = jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => upright);
  const root = renderSurface(<Sheet open onDismiss={() => undefined} onHidden={() => undefined}>{null}</Sheet>);
  const before = flat(panel(root));
  expect(before).toMatchObject({ left: 0, right: 0 });
  insets.mockImplementation(() => INSETS);
  act(() => Dimensions.set({ window: { ...PORTRAIT, ...LANDSCAPE }, screen: { ...PORTRAIT, ...LANDSCAPE } }));
  const after = flat(panel(root));
  expect(after).toMatchObject({ left: 59, right: 59, paddingBottom: 21 });
  expect(after.maxHeight).toBe(LANDSCAPE.height - INSETS.top - (Platform.OS === "ios" ? 0 : 24));
  expect(after.maxHeight as number).toBeLessThan(before.maxHeight as number);
  unmount(root);
});

test("in landscape the original design's deck bar pads by the wider side inset, so Android's Settings button clears a side navigation bar", () => {
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  const root = renderSurface(<DesignProvider design="original"><TabDeck /></DesignProvider>);
  const settings = root.root.findAll((node) => node.props.accessibilityLabel === "Settings" && typeof node.props.onPress === "function")[0]!;
  let bar: ReactTestInstance | null = settings.parent;
  while (bar && (typeof bar.type !== "string" || flat(bar).paddingHorizontal === undefined)) bar = bar.parent;
  expect(flat(bar!).paddingHorizontal).toBeGreaterThanOrEqual(59);
  unmount(root);
});
