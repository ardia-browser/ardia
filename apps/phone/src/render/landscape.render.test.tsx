import { Dimensions, Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { FloatingBar } from "../components/browsing/FloatingBar";
import { SearchTray } from "../components/search/SearchTray";
import { StartScreen } from "../components/search/StartScreen";
import { TabDeck } from "../components/tabs/TabDeck";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { DesignProvider, floatingPanelLayout } from "../components/ui";
import { deckGeometry, deckLeading } from "../lib/deckGeometry";
import { forgetLandscapeCount, noteScreenLayout, noteWindowShape } from "../state/app/landscapeCount";
import * as deckGrid from "../state/browse/deckGrid";
import { writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { setRootSize } from "../state/app/rootSize";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
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
  act(() => useScreenLayout.setState({ hinge: "none" }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const hosts = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
const redesigned = (node: React.ReactNode) => renderSurface(<DesignProvider design="redesigned">{node}</DesignProvider>);

test("an iPhone 17 Pro on its side gets Arc's stack, its card as tall as the band between header and bar allows, the card behind clear of the side inset, the bar at 361", () => {
  const g = deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", deckHeaderBottom(), 55, "arc");
  expect(g.cardHeight).toBeCloseTo(393 - (21 + 11) + 11 - 67 + 24 - (48 + 21 + 20), 6);
  expect(g.cardWidth).toBeCloseTo(g.cardHeight * (852 / 393), 6);
  expect(g.cardCenterY - g.cardHeight / 2).toBeCloseTo(48 + 21 + 20, 6);
  expect(deckLeading(g, -1)).toBeGreaterThanOrEqual(59);
  expect(g.barCenterY).toBe(361);
  expect(g.safeSide).toBe(59);
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  const root = redesigned(<TabDeck />);
  const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")[0]!;
  const shown = deckGeometry(852, 393, 0, 21, 59, Platform.OS, "redesigned", deckHeaderBottom(), 55, "arc");
  expect(flat(card).width).toBeCloseTo(shown.cardWidth, 1);
  expect(flat(card).height).toBeCloseTo(shown.cardHeight, 1);
  unmount(root);
});

test("in landscape the deck's header and its bottom bar pad by the wider side inset plus the bars' 24 on both sides, and on iPhone the grid by it plus 16", () => {
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  const root = redesigned(<TabDeck />);
  expect(flat(hosts(root, "deckBottomBar")[0]!)).toMatchObject({ paddingLeft: 59 + 24, paddingRight: 59 + 24 });
  const header = root.root.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string" && node.props.testID.startsWith("deckHeader"));
  expect(header.length).toBeGreaterThan(0);
  const sides = header.map(flat).flatMap((style) => [style.paddingHorizontal, style.left, style.right, style.paddingLeft, style.paddingRight]).filter((value) => typeof value === "number");
  expect(sides).toContain(59 + 24);
  expect(sides).not.toContain(59 + 12);
  if (Platform.OS !== "ios") return unmount(root);
  act(() => deckGrid.setDeckGrid(true));
  act(() => jest.advanceTimersByTime(1000));
  const scroll = hosts(root, "tabGridScroll")[0]!;
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle).paddingHorizontal).toBe(59 + 16);
  unmount(root);
});

test("in landscape the page bar stays one centred row: the wider side inset on both sides, then the bars' own 24, leaving a 574-point address capsule on an 852 screen", () => {
  act(() => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null }));
  const root = redesigned(<BrowsingScreen tabId={currentTabs().open[0]!.id} />);
  const bar = root.root.findAll((node) => node.type === FloatingBar)[0]!;
  let controls: ReactTestInstance | null = bar.parent;
  while (controls && (typeof controls.type !== "string" || flat(controls).bottom === undefined)) controls = controls.parent;
  expect(flat(controls!)).toMatchObject({ left: 59, right: 59 });
  const row = bar.findAll((node) => typeof node.type === "string" && flat(node).flexDirection === "row" && flat(node).paddingHorizontal === 24)[0]!;
  const { gap, height } = flat(row) as { gap: number; height: number };
  expect(LANDSCAPE.width - 2 * (59 + 24) - 2 * height - 2 * gap).toBe(574);
  unmount(root);
});

const DUO_POSES = [
  { name: "closed", width: 466, height: 678, insets: { top: 0, bottom: 34, left: 0, right: 84 }, hinge: "closed", span: { left: 24, right: 96 }, stripX: 418, plusY: -55, tabsY: 0, deckPlusY: 0, ends: false },
  { name: "open", width: 951, height: 669, insets: { top: 0, bottom: 34, left: 0, right: 84 }, hinge: "fullyOpen", span: { left: 527, right: 24 }, stripX: 903, plusY: -110, tabsY: -55, deckPlusY: -110, ends: true },
] as const satisfies readonly { name: string; width: number; height: number; insets: typeof INSETS; hinge: ScreenHinge; span: { left: number; right: number }; stripX: number; plusY: number; tabsY: number; deckPlusY: number; ends: boolean }[];

function onDuo(pose: (typeof DUO_POSES)[number]) {
  Dimensions.set({ window: { ...PORTRAIT, width: pose.width, height: pose.height }, screen: { ...PORTRAIT, width: pose.width, height: pose.height } });
  act(() => setRootSize(pose.width, pose.height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => pose.insets);
  act(() => useScreenLayout.setState({ hinge: pose.hinge }));
}

const holds = (node: ReactTestInstance, id: string) => node.findAll((inner) => inner.props.testID === id).length > 0;

for (const pose of DUO_POSES) {
  test(`on the ${pose.name} Duo the page bar holds only the address capsule, ${pose.span.left} from the left to ${pose.span.right} from the right, with + at ${pose.plusY} and Tabs at ${pose.tabsY} from the bar's line in the strip, ${pose.stripX} across`, () => {
    onDuo(pose);
    act(() => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null }));
    const page = redesigned(<BrowsingScreen tabId={currentTabs().open[0]!.id} />);
    const bar = page.root.findAll((node) => node.type === FloatingBar)[0]!;
    let controls: ReactTestInstance | null = bar.parent;
    while (controls && (typeof controls.type !== "string" || flat(controls).bottom === undefined)) controls = controls.parent;
    const { left } = flat(controls!) as { left: number };
    expect(flat(controls!)).toMatchObject({ left: pose.span.left - 24, right: pose.span.right - 24 });
    const row = hosts(page, "floatingBar")[0]!;
    expect(flat(row).paddingHorizontal).toBe(24);
    expect(holds(row, "floatingBarAddress")).toBe(true);
    expect(holds(row, "floatingBarTabs")).toBe(false);
    expect(holds(row, "floatingBarPlus")).toBe(false);
    const strip = hosts(page, "floatingBarStrip")[0]!;
    const { left: stripLeft, top: stripTop, width: stripWidth, gap } = flat(strip) as { left: number; top: number; width: number; gap: number };
    expect(left + stripLeft + stripWidth / 2).toBe(pose.stripX);
    expect(stripTop).toBe(pose.plusY);
    expect(stripWidth + gap).toBe(55);
    const order = strip.findAll((node) => node.props.testID === "floatingBarPlus" || node.props.testID === "floatingBarTabs").map((node) => node.props.testID as string);
    expect([...new Set(order)]).toEqual(["floatingBarPlus", "floatingBarTabs"]);
    if (pose.ends) expect(pose.width - (flat(controls!).right as number) - 24).toBe(pose.stripX + 24);
    unmount(page);
  });

  test(`on the ${pose.name} Duo the deck's + and the start page's + and Tabs take the page's strip slots, so nothing jumps between screens`, () => {
    onDuo(pose);
    act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
    const deck = redesigned(<TabDeck />);
    const deckBar = hosts(deck, "deckBottomBar")[0]!;
    expect(flat(deckBar)).toMatchObject({ paddingLeft: pose.span.left, paddingRight: pose.span.right });
    expect(holds(deckBar, "deckBarIncognito")).toBe(!pose.ends);
    expect(holds(deckBar, "deckBarPlus")).toBe(false);
    const stripPlus = hosts(deck, "deckStripPlus")[0]!;
    expect(flat(stripPlus)).toMatchObject({ top: pose.deckPlusY, left: pose.stripX - 24, width: 48 });
    const stripIncognito = hosts(deck, "deckStripIncognito")[0];
    if (pose.ends) expect(flat(stripIncognito!)).toMatchObject({ top: pose.tabsY, left: pose.stripX - 24, width: 48 });
    else expect(stripIncognito).toBeUndefined();
    if (pose.ends) expect(holds(stripIncognito!, "deckBarIncognito")).toBe(true);
    const plus = deck.root.findAll((node) => node.props.testID === "deckBarPlus" && node.props.place)[0]!;
    expect(plus.props.place).toMatchObject({ right: pose.width - pose.stripX + 32 });
    unmount(deck);
    act(() => browse.useBrowse.setState({ surface: "start", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
    const start = redesigned(<StartScreen />);
    const startBar = hosts(start, "startBar")[0]!;
    const { top } = flat(startBar) as { top: number };
    expect(flat(startBar)).toMatchObject({ paddingLeft: pose.span.left, paddingRight: pose.span.right });
    expect(holds(startBar, "startBarSettings")).toBe(true);
    expect(holds(startBar, "startBarTabs")).toBe(false);
    expect(holds(startBar, "startBarPlus")).toBe(false);
    expect(flat(hosts(start, "startStripTabs")[0]!)).toMatchObject({ left: pose.stripX - 24, top: top + pose.tabsY, width: 48 });
    expect(flat(hosts(start, "startStripPlus")[0]!)).toMatchObject({ left: pose.stripX - 24, top: top + pose.plusY, width: 48 });
    expect(flat(startBar).justifyContent).toBe(pose.ends ? "flex-end" : "space-between");
    expect(holds(hosts(start, "startStripPlus")[0]!, "startBarPlus")).toBe(true);
    expect(holds(hosts(start, "startStripTabs")[0]!, "startBarTabs")).toBe(true);
    unmount(start);
  });
}

test("with no hinge the page bar keeps Tabs and + in its row", () => {
  act(() => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null }));
  const page = redesigned(<BrowsingScreen tabId={currentTabs().open[0]!.id} />);
  const row = hosts(page, "floatingBar")[0]!;
  expect(holds(row, "floatingBarTabs")).toBe(true);
  expect(holds(row, "floatingBarPlus")).toBe(true);
  unmount(page);
});

test("in landscape the search panel sits 8 points inside the safe width, so it clears the island", () => {
  act(() => presentSearch("page"));
  const root = redesigned(<SearchTray />);
  expect(flat(hosts(root, "trayPanel")[0]!)).toMatchObject({ left: 59 + floatingPanelLayout.inset, right: 59 + floatingPanelLayout.inset });
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

test("a launch on a Duo in any pose, or in the wide or split layout, is counted once, and a plain iPhone never counts", () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  forgetLandscapeCount();
  noteScreenLayout("phone", "none");
  expect(counted.mock.calls).toEqual([]);
  noteScreenLayout("phone", "closed");
  noteScreenLayout("phone", "fullyOpen");
  noteScreenLayout("split", "partiallyOpen");
  expect(counted.mock.calls).toEqual([["duo_layout_shown"]]);
  for (const [name, hinge] of [["phone", "fullyOpen"], ["wide", "none"], ["split", "partiallyOpen"]] as const) {
    counted.mockClear();
    forgetLandscapeCount();
    noteScreenLayout(name, hinge);
    expect(counted.mock.calls).toEqual([["duo_layout_shown"]]);
  }
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
  expect(after.maxHeight).toBe(LANDSCAPE.height - INSETS.top - (Platform.OS === "ios" ? 10 : 24));
  expect(after.maxHeight as number).toBeLessThan(before.maxHeight as number);
  unmount(root);
});

test("in landscape the original design's deck bar pads by the wider side inset, so Android's Settings button clears a side navigation bar", () => {
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  const root = renderSurface(<DesignProvider design="original"><TabDeck /></DesignProvider>);
  const settings = root.root.findAll((node) => node.props.accessibilityLabel === "Settings" && typeof node.props.onPress === "function")[0]!;
  let bar: ReactTestInstance | null = settings.parent;
  while (bar && (typeof bar.type !== "string" || flat(bar).paddingLeft === undefined)) bar = bar.parent;
  expect(flat(bar!).paddingLeft).toBeGreaterThanOrEqual(59);
  expect(flat(bar!).paddingRight).toBeGreaterThanOrEqual(59);
  unmount(root);
});
