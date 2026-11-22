import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, someTabs, unmount } from "../../test/render/harness";
import { idOf, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { TabDeck } = require("../components/tabs/TabDeck") as typeof import("../components/tabs/TabDeck");
const { DesignProvider, deckChromeLayout, FloatingMenu, PROFILE_COLORS, rolesFor } = require("../components/ui") as typeof import("../components/ui");
type MenuItem = import("../components/ui").MenuItem;
const { centredGridOffset, tabGridColumns, tabGridInsets, tabGridLayout, tabGridStartOffset, tabGridRowHeight } = require("../components/tabs/tabGridLayout") as typeof import("../components/tabs/tabGridLayout");
const { deckHeaderBottom } = require("../components/tabs/DeckHeader") as typeof import("../components/tabs/DeckHeader");
const { haptics } = require("../state/app/haptics") as typeof import("../state/app/haptics");
const { useArchiveCard } = require("../state/browse/archiveCard") as typeof import("../state/browse/archiveCard");
const deckGrid = require("../state/browse/deckGrid") as typeof import("../state/browse/deckGrid");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const { setRootSize } = require("../state/app/rootSize") as typeof import("../state/app/rootSize");
const { readPreferences, writePreference } = require("../state/store/browserDatabase") as typeof import("../state/store/browserDatabase");
const { browserDatabase } = require("../state/store/database") as typeof import("../state/store/database");
const { OFF_STATUS, useSync } = require("../state/sync/store") as typeof import("../state/sync/store");
const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
const tabStore = require("../state/tabs/store") as typeof import("../state/tabs/store");
const { launchTabs } = require("../state/tabs/tabsState") as typeof import("../state/tabs/tabsState");

type Root = ReturnType<typeof renderSurface>;

const onIPhone = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

let counted: jest.SpyInstance;

const SCREEN = { width: 402, height: 874 };

beforeEach(() => {
  jest.useFakeTimers();
  resetNativeMenus(true);
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  act(() => {
    tabStore.useTabs.setState({ ...launchTabs(someTabs(5), 2), incognito: false, listing: 0 });
    useArchiveCard.setState({ showing: false });
    setRootSize(SCREEN.width, SCREEN.height);
    browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null });
    useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } }));
  });
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => useArchiveCard.setState({ showing: false }));
  act(() => jest.runOnlyPendingTimers());
  act(() => setRootSize(0, 0));
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  resetNativeMenus();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const deck = () =>
  renderSurface(
    <DesignProvider design="redesigned">
      <TabDeck />
    </DesignProvider>,
  );

const byTestId = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type !== "string");
const hosts = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const gridButton = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && /Show as (Grid|Stack)/.test(node.props.accessibilityLabel ?? ""))[0];
const settle = () => act(() => jest.advanceTimersByTime(1000));
const pick = (grid: boolean) => act(() => deckGrid.setDeckGrid(grid));
const toggle = () => {
  pick(!deckGrid.deckIsGrid());
  settle();
};
const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
const cards = (root: Root) => hosts(root, "tabGridCard");
const cardLabels = (root: Root) => cards(root).map((card) => card.props.accessibilityLabel);
const deckCards = (root: Root) => hosts(root, "deckCard");
const pressOf = (node: ReactTestInstance): (() => void) => {
  let at: ReactTestInstance | null = node;
  while (at && typeof at.props.onPress !== "function") at = at.parent;
  return at!.props.onPress;
};
const motion = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type !== "string" && node.props.to !== undefined)[0]!;
const target = (root: Root, id: string) => motion(root, id).props.to.opacity;

test("the deck is the stack by default and its bars have no grid button; picking Grid in Settings switches the open deck to main's grid and back, cross-fading the two and remembering the choice", () => {
  const root = deck();
  expect(deckGrid.deckIsGrid()).toBe(false);
  expect(gridButton(root)).toBeUndefined();
  expect(byTestId(root, "deckBarGrid")).toHaveLength(0);
  expect(hosts(root, "tabGrid")).toHaveLength(0);
  expect(deckCards(root).length).toBeGreaterThan(0);

  pick(true);
  expect(gridButton(root)).toBeUndefined();
  expect(hosts(root, "tabGridLayer")).toHaveLength(1);
  expect(motion(root, "tabGridLayer").props.from).toEqual({ opacity: 0 });
  expect(target(root, "tabGridLayer")).toBe(1);
  expect(target(root, "deckStackLayer")).toBe(0);
  expect(motion(root, "tabGridLayer").props.motion).toEqual({ type: "spring", response: 0.18, dampingFraction: 1 });
  expect(motion(root, "deckStackLayer").props.motion).toEqual({ type: "spring", response: 0.18, dampingFraction: 1 });
  expect(deckCards(root).length).toBeGreaterThan(0);
  settle();
  expect(hosts(root, "deckStackLayer")[0]!.props.pointerEvents).toBe("none");
  expect(deckCards(root)).toHaveLength(0);
  expect(cards(root)).toHaveLength(5);
  expect(readPreferences(browserDatabase())[deckGrid.DECK_GRID_KEY]).toBe("true");
  expect(counted).toHaveBeenCalledWith("deck_grid_shown");

  toggle();
  expect(deckGrid.deckIsGrid()).toBe(false);
  expect(hosts(root, "tabGridLayer")).toHaveLength(0);
  expect(target(root, "deckStackLayer")).toBe(1);
  expect(deckCards(root).length).toBeGreaterThan(0);
  expect(readPreferences(browserDatabase())[deckGrid.DECK_GRID_KEY]).toBe("false");
  expect(counted.mock.calls.filter(([name]) => name === "deck_grid_shown")).toHaveLength(1);
  unmount(root);
});

test("the grid lists the deck's tabs in the deck's order, so a search filters it the same way", () => {
  const root = deck();
  const stackOrder = root.root.findAll((node) => node.props.testID === "deckHeaderTitle" && typeof node.type === "string").map((node) => node.props.children);
  toggle();
  expect(cardLabels(root)).toEqual(stackOrder);
  unmount(root);
});

test("a remembered grid opens straight in the grid, and a deck opened from a page skips the card's shrink", () => {
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, "true");
  act(() => deckGrid.forgetDeckGrid());
  const selected = tabStore.currentTabs().selectedId!;
  act(() => browse.useBrowse.setState({ surface: "deck", deckEntrance: selected, leaving: selected }));
  const root = deck();
  expect(deckGrid.deckIsGrid()).toBe(true);
  expect(motion(root, "tabGridLayer").props.from).toBeUndefined();
  expect(target(root, "tabGridLayer")).toBe(1);
  expect(deckCards(root)).toHaveLength(0);
  expect(browse.useBrowse.getState().leaving).toBeNull();
  expect(counted).not.toHaveBeenCalledWith("deck_grid_shown");
  unmount(root);
});

test("main's grid layout: adaptive columns of 150 to 260 pt, 14 pt apart, rows 18 pt apart, cards in the screen's aspect with 13 pt corners, a title row over each card", () => {
  expect(tabGridColumns(402 - 32)).toEqual({ count: 2, width: 178 });
  expect(tabGridColumns(440 - 32)).toEqual({ count: 2, width: 197 });
  expect(tabGridColumns(700)).toEqual({ count: 4, width: (700 - 42) / 4 });
  expect(tabGridColumns(120)).toEqual({ count: 1, width: 120 });
  expect(tabGridColumns(560)).toEqual({ count: 3, width: (560 - 28) / 3 });
  expect(tabGridColumns(300).width).toBeLessThanOrEqual(260);
  expect(tabGridInsets(62, deckHeaderBottom(), 874, 800, 48, 12)).toEqual({ top: 62 + 48 + 8, bottom: 874 - 800 + 48, side: 16 });

  const root = deck();
  toggle();
  const scroll = hosts(root, "tabGridScroll")[0]!;
  const content = StyleSheet.flatten(scroll.props.contentContainerStyle);
  expect(content).toMatchObject({ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 18, paddingTop: 14, paddingHorizontal: 16 });
  expect(scroll.props.showsVerticalScrollIndicator).toBe(false);
  const fade = root.root.findAll((node) => node.props.testID === "tabGrid" && node.props.top !== undefined && typeof node.props.top === "object")[0]!;
  expect(fade.props.top).toEqual({ length: 14 });
  const cell = flat(hosts(root, "tabGridCell")[0]!);
  const face = flat(hosts(root, "tabGridFace")[0]!);
  const width = cell.width as number;
  expect(width).toBe(178);
  expect(face.width).toBe(178);
  expect(face.height).toBeCloseTo((178 * SCREEN.height) / SCREEN.width);
  expect(face).toMatchObject({ borderRadius: 13, overflow: "hidden", boxShadow: "0px 3px 20px rgba(0,0,0,0.108)" });
  const header = flat(hosts(root, "tabGridHeader")[0]!);
  expect(header).toMatchObject({ flexDirection: "row", gap: 6, height: 30 });
  const close = hosts(root, "tabGridClose")[0]!;
  expect(flat(close)).toMatchObject({ width: 36, height: 30 });
  expect(close.props.accessibilityLabel).toBe("Close Tab");
  const title = hosts(root, "tabGridTitle")[0]!;
  expect(title.props.numberOfLines).toBe(1);
  expect(flat(title)).toMatchObject({ fontWeight: "500" });
  unmount(root);
});

test("the selected tab's card carries a 2.5 pt edge in the space's accent and the selected trait; the rest keep the 0.5 pt card edge", () => {
  const root = deck();
  toggle();
  const selected = tabStore.currentTabs().open.find((tab) => tab.id === tabStore.currentTabs().selectedId)!;
  const roles = rolesFor(false);
  const at = cardLabels(root).indexOf(selected.title);
  const edges = hosts(root, "tabGridEdge").map(flat);
  expect(edges[at]).toMatchObject({ borderWidth: 2.5, borderColor: PROFILE_COLORS.plum.tint });
  edges.filter((_, index) => index !== at).forEach((edge) => expect(edge).toMatchObject({ borderWidth: 0.5, borderColor: roles.cardEdge }));
  expect(cards(root)[at]!.props.accessibilityState).toEqual({ selected: true });
  expect(cards(root).filter((card) => card.props.accessibilityState.selected)).toHaveLength(1);
  unmount(root);
});

test("the grid starts scrolled so the selected tab's row sits in the middle, as main's scrollTo(anchor: .center), held inside the content", () => {
  act(() => tabStore.useTabs.setState({ ...launchTabs(someTabs(20), 3), incognito: false, listing: 0 }));
  const root = deck();
  toggle();
  const scroll = hosts(root, "tabGridScroll")[0]!;
  const selectedId = tabStore.currentTabs().selectedId;
  const at = cardLabels(root).indexOf(tabStore.currentTabs().open.find((tab) => tab.id === selectedId)!.title);
  const width = flat(hosts(root, "tabGridCell")[0]!).width as number;
  const viewportTop = flat(hosts(root, "tabGrid")[0]!).top as number;
  const face = flat(hosts(root, "tabGridFace")[0]!);
  const rowHeight = tabGridRowHeight(width, width / (face.height as number));
  expect(rowHeight).toBeCloseTo(30 + 8 + (face.height as number));
  const bottom = StyleSheet.flatten(scroll.props.contentContainerStyle).paddingBottom as number;
  const viewport = SCREEN.height - viewportTop;
  const offset = scroll.props.contentOffset.y as number;
  expect(at).toBeGreaterThanOrEqual(4);
  expect(offset).toBeGreaterThan(0);
  expect(offset).toBeCloseTo(tabGridStartOffset(at, 20, 2, rowHeight, viewport, bottom));
  const rowTop = 14 + Math.floor(at / 2) * (rowHeight + 18);
  expect(rowTop - offset).toBeGreaterThanOrEqual(0);
  expect(rowTop + rowHeight - offset).toBeLessThanOrEqual(viewport);
  expect(tabGridStartOffset(10, 40, 2, 100, 500, 50)).toBe(14 + 5 * 118 + 50 - 250);
  expect(tabGridStartOffset(39, 40, 2, 100, 500, 50)).toBe(14 + 20 * 100 + 19 * 18 + 50 - 500);
  expect(tabGridStartOffset(0, 40, 2, 100, 500, 50)).toBe(0);
  unmount(root);
});

test("once the selected cell, the viewport and the content are measured, the grid scrolls once to centre the cell as laid out, not as estimated", () => {
  act(() => tabStore.useTabs.setState({ ...launchTabs(someTabs(20), 3), incognito: false, listing: 0 }));
  const root = deck();
  toggle();
  const scroll = hosts(root, "tabGridScroll")[0]!;
  const scrollTo = jest.fn();
  const withInstance = (node: ReactTestInstance) => (node as ReactTestInstance & { instance?: unknown }).instance;
  const instance = withInstance(root.root.findAll((node) => node.props.testID === "tabGridScroll" && typeof withInstance(node) === "object" && withInstance(node) !== null)[0]!) as { scrollTo?: unknown } | undefined;
  expect(instance).toBeDefined();
  instance!.scrollTo = scrollTo;
  const selectedId = tabStore.currentTabs().selectedId;
  const at = cardLabels(root).indexOf(tabStore.currentTabs().open.find((tab) => tab.id === selectedId)!.title);
  const cell = hosts(root, "tabGridCell")[at]!;
  act(() => cell.props.onLayout({ nativeEvent: { layout: { x: 0, y: 1400, width: 180, height: 420 } } }));
  act(() => scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 700 } } }));
  expect(scrollTo).not.toHaveBeenCalled();
  act(() => scroll.props.onContentSizeChange(393, 4000));
  act(() => scroll.props.onContentSizeChange(393, 4100));
  const other = hosts(root, "tabGridCell")[at === 0 ? 1 : 0]!;
  act(() => other.props.onLayout({ nativeEvent: { layout: { x: 0, y: 14, width: 180, height: 420 } } }));
  expect(scrollTo.mock.calls).toEqual([[{ x: 0, y: 1400 + 210 - 350, animated: false }]]);
  expect(centredGridOffset(1400, 420, 700, 4000)).toBe(1260);
  expect(centredGridOffset(100, 420, 700, 4000)).toBe(0);
  expect(centredGridOffset(3800, 200, 700, 4000)).toBe(3300);
  unmount(root);
});

test("a tap on a grid card opens its tab plainly, as main's grid does: no growing card", () => {
  const opened = jest.spyOn(browse, "openTab").mockImplementation(() => undefined);
  const root = deck();
  toggle();
  const target = cards(root)[1]!;
  const id = tabStore.currentTabs().open.find((tab) => tab.title === target.props.accessibilityLabel)!.id;
  act(() => pressOf(target)());
  expect(opened).toHaveBeenCalledWith(id);
  expect(hosts(root, "openingCard")).toHaveLength(0);
  unmount(root);
});

test("the close button closes the tab without the deck's fly-away, and the grid closes up", () => {
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation((id) => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.id !== id) })));
  const root = deck();
  toggle();
  const label = cards(root)[0]!.props.accessibilityLabel;
  const id = tabStore.currentTabs().open.find((tab) => tab.title === label)!.id;
  act(() => pressOf(hosts(root, "tabGridClose")[0]!)());
  expect(closed).toHaveBeenCalledWith(id);
  expect(hosts(root, "deckCard")).toHaveLength(0);
  settle();
  expect(cards(root)).toHaveLength(4);
  expect(cardLabels(root)).not.toContain(label);
  unmount(root);
});

onIPhone("each grid card is main's CardMenu on a long press, through the system menu, and its Close Tab closes the tab", () => {
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
  const root = deck();
  toggle();
  const menus = root.root.findAll((node) => node.type === ("ContextMenuView" as never) && node.props.testID === "tabGridCardMenu");
  expect(menus).toHaveLength(5);
  expect(menus[0]!.props.trigger).toBe("longPress");
  const items: NativeItem[] = menus[0]!.props.items;
  expect(titles(items)).toEqual(["Copy Link", "Share", { "": ["Close Tab"] }]);
  const label = cards(root)[0]!.props.accessibilityLabel;
  const id = tabStore.currentTabs().open.find((tab) => tab.title === label)!.id;
  act(() => menus[0]!.props.onSelect(idOf(items, "Close Tab")));
  expect(closed).toHaveBeenCalledWith(id);
  unmount(root);
});

test("a screen reader reads each card as main's: the title, the host as its value, and a Close Tab action, in each system's own action form", () => {
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
  const opened = jest.spyOn(browse, "openTab").mockImplementation(() => undefined);
  const root = deck();
  toggle();
  const card = cards(root)[0]!;
  const tab = tabStore.currentTabs().open.find((one) => one.title === card.props.accessibilityLabel)!;
  expect(card.props.accessibilityRole).toBe("button");
  expect(card.props.accessibilityValue).toEqual({ text: new URL(tab.url).host });
  const ios = Platform.OS === "ios";
  expect(card.props.accessibilityActions).toEqual(ios ? [{ name: "Close Tab" }] : [{ name: "activate" }, { name: "close", label: "Close Tab" }, { name: "menu", label: "Tab Options" }]);
  act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: ios ? "Close Tab" : "close" } }));
  expect(closed).toHaveBeenCalledWith(tab.id);
  if (ios) act(() => card.props.onAccessibilityTap());
  else act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }));
  expect(opened).toHaveBeenCalledWith(tab.id);
  expect(hosts(root, "deckStackLayer")[0]!.props.accessibilityElementsHidden).toBe(true);
  expect(hosts(root, "tabGridLayer")[0]!.props.accessibilityElementsHidden).toBe(false);
  unmount(root);
});

onIPhone("an Incognito tab's cell is titled Incognito, and its card reads Incognito with the host", () => {
  act(() => tabStore.useTabs.setState((state) => ({ ...state, privates: someTabs(1, true), incognito: true })));
  const root = deck();
  toggle();
  const at = hosts(root, "tabGridTitle").findIndex((node) => node.props.children === "Incognito");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(cards(root)[at]!.props.accessibilityValue).toEqual({ text: "Incognito, site0.example" });
  unmount(root);
});

onAndroid("a grid card's Tab Options action gives TalkBack the same drawn CardMenu, placed from the card as a long press with no touch point", () => {
  const root = deck();
  toggle();
  const card = cards(root)[0]!;
  expect(card.props.accessibilityActions).toContainEqual({ name: "menu", label: "Tab Options" });
  act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  const menu = root.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(menu.props.at).toBeNull();
  expect(menu.props.dimmed).toBe(true);
  unmount(root);
});

onAndroid("after a grid card's Tab Options menu is dismissed, TalkBack goes back to the card itself, not to the menu's wrapper", () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const root = deck();
  toggle();
  const card = cards(root)[1]!;
  const cardView = byTestId(root, "tabGridCard").map((node) => node.instance).filter(Boolean)[1];
  const wrapper = byTestId(root, "tabGridCardMenu").map((node) => node.instance).filter(Boolean)[1];
  act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  asked.mockClear();
  act(() => root.root.findAll((node) => node.type === FloatingMenu)[0]!.props.onDismiss());
  act(() => jest.advanceTimersByTime(1000));
  act(() => jest.advanceTimersByTime(32));
  expect(cardView).toBeTruthy();
  const targets = asked.mock.calls.map(([target]) => target());
  expect(targets.length).toBe(1);
  expect(targets[0] === cardView).toBe(true);
  expect(targets[0] === wrapper).toBe(false);
  unmount(root);
});

onAndroid("a grid card's Tab Options stays with its own tab when an earlier tab closes while the card is measured", async () => {
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  let measured!: (rect: { x: number; y: number; width: number; height: number }) => void;
  jest.spyOn(overlay, "measureAnchor").mockImplementation(() => new Promise((resolve) => (measured = resolve)));
  const tabMenus = require("../state/browse/tabMenus") as typeof import("../state/browse/tabMenus");
  const copied = jest.spyOn(tabMenus, "copyTabLink").mockImplementation(() => undefined);
  const root = deck();
  toggle();
  const asked = cards(root)[1]!;
  const askedTab = tabStore.currentTabs().open.find((tab) => tab.title === asked.props.accessibilityLabel)!;
  const earlier = tabStore.currentTabs().open.find((tab) => tab.title === cards(root)[0]!.props.accessibilityLabel)!;
  act(() => asked.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  act(() => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.id !== earlier.id) })));
  await act(async () => measured({ x: 20, y: 200, width: 170, height: 300 }));
  const items = root.root.findAll((node) => node.type === FloatingMenu)[0]!.props.items as MenuItem[];
  act(() => (items.find((item) => typeof item === "object" && "label" in item && item.label === "Copy Link") as { onPress: () => void }).onPress());
  expect(copied).toHaveBeenCalledWith(expect.objectContaining({ id: askedTab.id }));
  unmount(root);
});

onAndroid("each grid card's long press opens the drawn CardMenu at the finger, dimmed, and its Close Tab closes the tab", () => {
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
  const root = deck();
  toggle();
  expect(root.root.findAll((node) => node.type === ("ContextMenuView" as never))).toHaveLength(0);
  const card = cards(root)[0]!;
  const id = tabStore.currentTabs().open.find((tab) => tab.title === card.props.accessibilityLabel)!.id;
  const held = root.root.findAll((node) => node.props.testID === "tabGridCardMenu")[0]!.findAll((node) => typeof node.props.onLongPress === "function")[0]!;
  act(() => held.props.onLongPress({ nativeEvent: { pageX: 90, pageY: 260 } }));
  const menu = root.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(menu.props.at).toEqual({ x: 90, y: 260 });
  expect(menu.props.dimmed).toBe(true);
  const items = menu.props.items as MenuItem[];
  expect(items.map((item) => (item === "divider" ? item : "label" in item ? item.label : item.heading))).toEqual(["Copy Link", "Share", "divider", "Close Tab"]);
  act(() => (items.find((item) => typeof item === "object" && "label" in item && item.label === "Close Tab") as { onPress: () => void }).onPress());
  act(() => jest.advanceTimersByTime(1000));
  expect(closed).toHaveBeenCalledWith(id);
  unmount(root);
});

test("the grid's choice is stored under main's key", () => {
  expect(deckGrid.DECK_GRID_KEY).toBe("tabs.deckGrid");
  expect(tabGridLayout).toMatchObject({ columnMin: 150, columnMax: 260, columnSpacing: 14, rowSpacing: 18, topFade: 14 });
  expect(deckChromeLayout.barCircle).toBe(48);
});
