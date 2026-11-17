import { Dimensions, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { PageSurface } from "../components/browsing/PageSurface";
import { StartScreen } from "../components/search/StartScreen";
import { TabDeck } from "../components/tabs/TabDeck";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { DesignProvider, Symbol } from "../components/ui";
import { deckGeometry } from "../lib/deckGeometry";
import { setRootSize } from "../state/app/rootSize";
import { columnCenterX, columnContentWidth, SCREEN_COLUMN, useScreenLayout, type ScreenColumn } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { dismissSearch } from "../state/search/store";
import { OFF_STATUS, useSync, type SyncedProfile } from "../state/sync/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const DUO = { width: 466, height: 678 };
const PORTRAIT = Dimensions.get("window");
const TRAILING: ScreenColumn = { edge: "trailing", inset: 84 };
const LEADING: ScreenColumn = { edge: "leading", inset: 84 };
const insetsFor = (column: ScreenColumn) => ({ top: 0, bottom: 0, left: column.edge === "leading" ? column.inset : 0, right: column.edge === "trailing" ? column.inset : 0 });

function useColumnLayout(column: ScreenColumn) {
  act(() => useScreenLayout.setState({ layout: { name: "column", column } }));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => insetsFor(column));
}

beforeEach(() => {
  jest.useFakeTimers();
  act(() => withTabs(3));
  act(() => Dimensions.set({ window: { ...PORTRAIT, ...DUO }, screen: { ...PORTRAIT, ...DUO } }));
  act(() => setRootSize(DUO.width, DUO.height));
  useColumnLayout(TRAILING);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => usePageUi.setState({ findOpen: false, findQuery: "" }));
  act(() => jest.runOnlyPendingTimers());
  act(() => useScreenLayout.setState({ layout: { name: "phone" } }));
  act(() => setRootSize(0, 0));
  act(() => useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } })));
  act(() => Dimensions.set({ window: PORTRAIT, screen: PORTRAIT }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const hosts = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const host = (root: Root, id: string) => hosts(root, id)[0]!;
const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
const redesigned = (node: React.ReactNode) => renderSurface(<DesignProvider design="redesigned">{node}</DesignProvider>);
const showBrowsing = () => act(() => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null }));
const showDeck = () => act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
const inOrder = (root: Root, stack: string, ids: string[]) => host(root, stack).findAll((node) => typeof node.type === "string" && ids.includes(node.props.testID)).map((node) => node.props.testID as string);
const siteSymbols = (root: Root) => host(root, "columnSiteMark").findAll((node) => node.type === Symbol).map((node) => node.props.name as string);

const profile = (syncId: string, name: string): SyncedProfile => ({ syncId, name, color: null, icon: null, isDefault: syncId === "work", theme: null, deviceTabs: [], pinned: { tiles: [], sections: [] }, bookmarks: [], history: [], sendTargets: null });

function withSpaces(profiles: SyncedProfile[]) {
  const selected = profiles[0]!.syncId;
  act(() =>
    useSync.setState((state) => ({
      ...state,
      status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
      view: { devices: [], profiles, search: null, syncedAt: 1, selectedProfileId: selected, shownProfileId: selected, receivers: [] } as never,
    })),
  );
}

test("the contract's numbers on a closed Duo: content 382 wide and the column centred 48 in from the trailing edge, at 418", () => {
  expect(columnContentWidth(TRAILING, DUO.width)).toBe(382);
  expect(columnCenterX(TRAILING, DUO.width)).toBe(418);
  expect(columnCenterX(LEADING, DUO.width)).toBe(48);
  expect(SCREEN_COLUMN).toMatchObject({ top: 166, button: 48, spacing: 7 });
});

test("browsing in a trailing column: the page padded 84 on the right over the system background, unobscured, and no row bar or pill", () => {
  showBrowsing();
  const root = redesigned(<BrowsingScreen tab={currentTabs().open[0]!} />);
  let screen: ReactTestInstance | null = host(root, "columnPageStack").parent;
  while (screen && (typeof screen.type !== "string" || typeof screen.props.onLayout !== "function")) screen = screen.parent;
  expect(flat(screen!).backgroundColor).toBe("#FFFFFF");
  expect(flat(host(root, "columnPageStack"))).toMatchObject({ position: "absolute", top: 0, bottom: 0, left: 0, right: 84 });
  expect(host(root, "columnPageStack").findAll((node) => node.props.testID === "pageArea" && typeof node.type === "string")).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === PageSurface)[0]!.props.obscured).toEqual({ top: 0, bottom: 0 });
  expect(hosts(root, "pageBar")).toHaveLength(0);
  expect(hosts(root, "floatingBar")).toHaveLength(0);
  expect(hosts(root, "hostPillFold")).toHaveLength(0);
  unmount(root);
});

test("the browsing column: Tabs, the site button, the page menu and Plus, 48 round, 7 apart, from 166, centred at 418", () => {
  showBrowsing();
  const root = redesigned(<BrowsingScreen tab={currentTabs().open[0]!} />);
  const stack = flat(host(root, "browsingColumnStack"));
  expect(stack).toMatchObject({ position: "absolute", top: 166, width: 48, gap: 7 });
  expect((stack.left as number) + 24).toBe(418);
  expect(inOrder(root, "browsingColumnStack", ["columnTabs", "columnSite", "columnMenu", "columnPlus"])).toEqual(["columnTabs", "columnSite", "columnMenu", "columnPlus"]);
  for (const id of ["columnTabs", "columnSite", "columnMenu", "columnPlus"]) expect(flat(host(root, id))).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")).not.toHaveLength(0);
  unmount(root);
});

test("the column's site button shows a magnifying glass with no page, the glasses for a private tab and the red open lock for an http page", () => {
  showBrowsing();
  const blank = { ...currentTabs().open[0]!, url: "" };
  const root = redesigned(<BrowsingScreen tab={blank} />);
  expect(siteSymbols(root)).toEqual(["magnifyingglass"]);
  unmount(root);
  const secret = redesigned(<BrowsingScreen tab={{ ...currentTabs().open[0]!, isPrivate: true }} />);
  expect(siteSymbols(secret)).toEqual(["eyeglassesThin"]);
  unmount(secret);
  const http = redesigned(<BrowsingScreen tab={{ ...currentTabs().open[0]!, url: "http://plain.example/" }} />);
  expect(hosts(http, "columnSiteNotSecure")).toHaveLength(1);
  unmount(http);
});

test("the browsing column never collapses, and it fades out while the find bar is open", () => {
  showBrowsing();
  const root = redesigned(<BrowsingScreen tab={currentTabs().open[0]!} />);
  expect(host(root, "browsingColumn").props.pointerEvents).toBe("box-none");
  act(() => usePageUi.setState({ findOpen: true, findQuery: "" }));
  act(() => jest.advanceTimersByTime(1000));
  expect(host(root, "browsingColumn").props.pointerEvents).toBe("none");
  expect((getAnimatedStyle(host(root, "browsingColumn")) as { opacity: number }).opacity).toBeCloseTo(0, 2);
  unmount(root);
});

test("the deck in a trailing column lays out in the 382-wide content with no side padding, and its header drops the ···", () => {
  showDeck();
  const root = redesigned(<TabDeck />);
  const g = deckGeometry(382, 678, 0, 0, 0, Platform.OS, "redesigned", deckHeaderBottom());
  const card = flat(hosts(root, "deckCard")[0]!);
  expect(card.width).toBeCloseTo(g.cardWidth, 5);
  expect(card.width).not.toBeCloseTo(deckGeometry(466, 678, 0, 0, 84, Platform.OS, "redesigned", deckHeaderBottom()).cardWidth, 1);
  const content = hosts(root, "columnContent").map(flat);
  expect(content.length).toBeGreaterThan(0);
  for (const frame of content) expect(frame).toMatchObject({ left: 0, right: 84, width: 382 });
  expect(content.filter((frame) => frame.overflow === "hidden")).toHaveLength(1);
  expect(hosts(root, "columnContent").find((node) => flat(node).overflow === "hidden")!.findAll((node) => node.props.testID === "deckCard").length).toBeGreaterThan(0);
  expect(flat(host(root, "deckHeader")).paddingHorizontal).toBe(12);
  expect(hosts(root, "deckHeaderMore")).toHaveLength(0);
  expect(hosts(root, "deckBottomBar")).toHaveLength(0);
  unmount(root);
});

test("the deck column holds grid, Search Tabs, ··· and Plus, and its Search Tabs field floats 358 wide centred at 191, 245", () => {
  showDeck();
  const root = redesigned(<TabDeck />);
  const stack = flat(host(root, "deckColumn"));
  expect(stack).toMatchObject({ top: 166, width: 48, gap: 7 });
  expect((stack.left as number) + 24).toBe(418);
  const buttons = inOrder(root, "deckColumn", ["deckColumnGrid", "deckColumnSearch", "deckColumnMore", "deckColumnPlus"]);
  expect(buttons).toEqual(Platform.OS === "ios" ? ["deckColumnGrid", "deckColumnSearch", "deckColumnMore", "deckColumnPlus"] : ["deckColumnSearch", "deckColumnMore", "deckColumnPlus"]);
  for (const id of buttons) expect(flat(host(root, id))).toMatchObject({ width: 48, height: 48 });
  const field = flat(host(root, "deckColumnField"));
  expect(field.width).toBe(358);
  expect((field.left as number) + (field.width as number) / 2).toBe(191);
  expect((field.top as number) + (field.height as number) / 2).toBe(245);
  expect(host(root, "deckColumnField").props.pointerEvents).toBe("none");
  expect((getAnimatedStyle(host(root, "deckColumnField")) as { opacity: number }).opacity).toBe(0);
  act(() => host(root, "deckSearchField").props.onFocus());
  act(() => jest.advanceTimersByTime(250));
  expect(host(root, "deckColumnField").props.pointerEvents).toBe("box-none");
  expect((getAnimatedStyle(host(root, "deckColumnField")) as { opacity: number }).opacity).toBeCloseTo(1, 2);
  unmount(root);
});

test("the start page in a trailing column: spaces 382 wide on the left, the dots on the bar's centre line, and a column of Tabs, Plus and Settings", () => {
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  const root = redesigned(<StartScreen />);
  expect(flat(host(root, "startContent"))).toMatchObject({ left: 0, right: 84, width: 382 });
  const dots = flat(host(root, "startPageDots"));
  expect((dots.top as number) + (dots.height as number) / 2).toBe(678 - 20 - 11);
  const stack = flat(host(root, "startColumn"));
  expect(stack).toMatchObject({ top: 166, width: 48, gap: 7 });
  expect((stack.left as number) + 24).toBe(418);
  const order = inOrder(root, "startColumn", ["startBarTabs", "startBarPlus", "startBarSettings"]);
  expect(order).toEqual(["startBarTabs", "startBarPlus", "startBarSettings"]);
  for (const id of order) expect(flat(host(root, id))).toMatchObject({ width: 48, height: 48 });
  unmount(root);
});

test("a leading column mirrors it all: the column centred at 48, the page padded 84 on the left, the deck content and its field from 84", () => {
  useColumnLayout(LEADING);
  showBrowsing();
  const page = redesigned(<BrowsingScreen tab={currentTabs().open[0]!} />);
  expect(flat(host(page, "columnPageStack"))).toMatchObject({ left: 84, right: 0 });
  expect((flat(host(page, "browsingColumnStack")).left as number) + 24).toBe(48);
  unmount(page);
  showDeck();
  const deck = redesigned(<TabDeck />);
  for (const frame of hosts(deck, "columnContent").map(flat)) expect(frame).toMatchObject({ left: 84, right: 0, width: 382 });
  expect((flat(host(deck, "deckColumn")).left as number) + 24).toBe(48);
  const field = flat(host(deck, "deckColumnField"));
  expect((field.left as number) + (field.width as number) / 2).toBe(84 + 191);
  unmount(deck);
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  const start = redesigned(<StartScreen />);
  expect(flat(host(start, "startContent"))).toMatchObject({ left: 84, right: 0, width: 382 });
  expect((flat(host(start, "startColumn")).left as number) + 24).toBe(48);
  unmount(start);
});

test("back on the phone layout nothing of the column renders", () => {
  act(() => useScreenLayout.setState({ layout: { name: "phone" } }));
  showBrowsing();
  const root = redesigned(<BrowsingScreen tab={currentTabs().open[0]!} />);
  expect(hosts(root, "browsingColumn")).toHaveLength(0);
  expect(hosts(root, "columnPageStack")).toHaveLength(0);
  expect(hosts(root, "pageBar")).toHaveLength(1);
  unmount(root);
});
