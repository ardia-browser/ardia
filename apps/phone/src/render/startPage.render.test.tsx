import { FlatList, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { StartScreen } from "../components/search/StartScreen";
import { DeckBar } from "../components/tabs/DeckBar";
import { AppIcon, ArdiaLogo, DesignProvider } from "../components/ui";
import { redesignedBarCenterFromBottom } from "../lib/deckGeometry";
import type { Design } from "../lib/design";
import { haptics } from "../state/app/haptics";
import * as browseStore from "../state/browse/store";
import { useBrowse } from "../state/browse/store";
import * as syncActions from "../state/sync/actions";
import { dismissSearch, presentSearch } from "../state/search/store";
import { OFF_STATUS, useSync, type PinnedTile, type SyncedProfile } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useTabs } from "../state/tabs/store";
import { renderSurface, unmount, updateSurface, withTabs } from "../../test/render/harness";
import { StartSpaces } from "../components/search/StartSpaces";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const HEIGHT = 873;
const WIDTH = 393;
const BAR_CENTER_Y = HEIGHT - redesignedBarCenterFromBottom(34, Platform.OS);

const tile = (i: number, folder: PinnedTile["folder"] = null): PinnedTile => ({ key: `k${i}`, title: `Pin ${i}`, url: `https://pin${i}.example/`, icon: null, folder });
const profile = (syncId: string, name: string, tiles: PinnedTile[] = [], theme: SyncedProfile["theme"] = null): SyncedProfile => ({
  syncId,
  name,
  color: null,
  icon: null,
  isDefault: syncId === "work",
  theme,
  deviceTabs: [],
  pinned: { tiles, sections: [] },
  bookmarks: [],
  history: [],
  sendTargets: null,
});

function withSpaces(profiles: SyncedProfile[], selected = profiles[0]?.syncId ?? null) {
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
    view: { devices: [], profiles, search: null, syncedAt: 1, selectedProfileId: selected, shownProfileId: selected, receivers: [] } as never,
  }));
}

let select: jest.SpyInstance;
let tick: jest.SpyInstance;
let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  mockMotion.reduced = false;
  withTabs(2);
  useBrowse.setState({ surface: "start", sheet: null });
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } }));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 47, bottom: 34, left: 0, right: 0 }));
  select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
  tick = jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;


const start = (design: Design = "redesigned") =>
  renderSurface(
    <DesignProvider design={design}>
      <StartScreen />
    </DesignProvider>,
  );

const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const host = (root: Root, testID: string) => hosts(root, testID)[0];
const style = (root: Root, testID: string) => StyleSheet.flatten(host(root, testID)!.props.style);

test("the original start page keeps its logo and its deck bar, and none of the redesign", () => {
  const root = start("original");
  expect(root.root.findAll((node) => node.type === ArdiaLogo)).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === DeckBar)).toHaveLength(1);
  expect(host(root, "startPage")).toBeUndefined();
  unmount(root);
});

test("the redesigned start page has no deck bar and only the Ardia mark in the middle; its own bar holds round Tabs and Settings circles and a 77 by 48 plus pill, centred 11 points above the safe bottom on iPhone and where the browsing bar sits on Android, 24 in from the sides", () => {
  const root = start();
  expect(root.root.findAll((node) => node.type === AppIcon && node.props.side === 128)).toHaveLength(1);
  expect(host(root, "appIcon")).toBeDefined();
  expect(root.root.findAll((node) => node.type === ArdiaLogo)).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === DeckBar)).toHaveLength(0);
  const bar = style(root, "startBar");
  expect(bar.top + bar.height / 2).toBe(BAR_CENTER_Y);
  expect(bar).toMatchObject({ height: 48, paddingLeft: 24, paddingRight: 24 });
  expect(style(root, "startBarTabs")).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(style(root, "startBarSettings")).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(style(root, "startBarPlus")).toMatchObject({ width: 77, height: 48, borderRadius: 24 });
  for (const gone of ["startSwitcher", "startTiles", "startPageDots", "startSyncInvitation"]) expect(host(root, gone)).toBeUndefined();
  unmount(root);
});

test("the plus's menu offers a private tab and reopening, and in a private tab a regular one too", () => {
  jest.spyOn(require("../state/tabs/hooks"), "useCanReopen").mockReturnValue(true);
  const root = start();
  const plus = () => root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onLongPress === "function")[0]!;
  act(() => plus().props.onLongPress());
  const labels = root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
  expect(labels).toEqual(["New Incognito Tab", "Reopen Closed Tab"]);
  unmount(root);
  act(() => useTabs.setState({ incognito: true }));
  const privately = start();
  act(() => privately.root.findAll((node) => node.props.accessibilityLabel === "New Incognito Tab" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress());
  expect(privately.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel)).toEqual(["New Tab", "New Incognito Tab", "Reopen Closed Tab"]);
  unmount(privately);
});

test("with spaces the page shows no name, tiles or dots, only the mark over a gradient of the space's colour", () => {
  withSpaces([profile("work", "Work", Array.from({ length: 6 }, (_, i) => tile(i)))]);
  const root = start();
  for (const gone of ["startSwitcher", "startTiles", "startTile", "startPageDots", "startSyncInvitation"]) expect(host(root, gone)).toBeUndefined();
  expect(root.root.findAll((node) => node.props.accessibilityRole === "header" && node.props.accessibilityLabel === "Work")).toHaveLength(0);
  expect(String(style(root, "startGradient").experimental_backgroundImage)).toMatch(/^linear-gradient\(/);
  expect(root.root.findAll((node) => node.type === AppIcon && node.props.side === 128)).toHaveLength(1);
  expect(host(root, "appIcon")).toBeDefined();
  expect(root.root.findAll((node) => node.type === ArdiaLogo)).toHaveLength(0);
  unmount(root);
});

test("with more than one space the gradients swipe sideways, a page per space, and the pager is an adjustable control named for the space", () => {
  withSpaces([profile("work", "Work"), profile("home", "Home"), profile("play", "Play")], "home");
  const root = start();
  expect(host(root, "startPager")).toBeDefined();
  expect(hosts(root, "startGradient").length).toBeGreaterThan(1);
  const spaces = host(root, "startSpaces")!;
  expect(spaces.props.accessibilityRole).toBe("adjustable");
  expect(spaces.props.accessibilityLabel).toBe("Space 2 of 3");
  expect(spaces.props.accessibilityValue).toEqual({ text: "Home" });
  unmount(root);
});

test("each space's gradient takes that space's colour", () => {
  withSpaces([{ ...profile("work", "Work"), color: "blue" }, { ...profile("home", "Home"), color: "orange" }]);
  const root = start();
  const [work, home] = hosts(root, "startGradient").map((node) => String(StyleSheet.flatten(node.props.style).experimental_backgroundImage));
  expect(work).not.toBe(home);
  unmount(root);
});

test("a swipe that lands on another space switches to it with a tick and counts it; landing on the same page does nothing", () => {
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  const root = start();
  const pager = () => root.root.findAll((node) => node.props.testID === "startPager" && typeof node.props.onMomentumScrollEnd === "function")[0]!;
  act(() => pager().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: WIDTH, y: 0 } } }));
  expect(select).toHaveBeenCalledWith("home");
  expect(tick).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("spaces_swiped");
  act(() => pager().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: WIDTH, y: 0 } } }));
  expect(select).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("in a private tab a swipe still switches space but is never counted", () => {
  act(() => useTabs.setState({ incognito: true }));
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  const root = start();
  act(() => root.root.findAll((node) => node.props.testID === "startPager" && typeof node.props.onMomentumScrollEnd === "function")[0]!.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: WIDTH, y: 0 } } }));
  expect(select).toHaveBeenCalledWith("home");
  expect(counted).not.toHaveBeenCalled();
  unmount(root);
});

test("adjusting the spaces with a screen reader switches space, counted as a pick and not a swipe, and never while private", () => {
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  const root = start();
  const spaces = host(root, "startSpaces")!;
  act(() => spaces.props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } }));
  expect(select).not.toHaveBeenCalled();
  act(() => spaces.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
  expect(select).toHaveBeenCalledWith("home");
  expect(counted.mock.calls).toEqual([["spaces_picked"]]);
  unmount(root);
  counted.mockClear();
  act(() => useTabs.setState({ incognito: true }));
  const privately = start();
  act(() => host(privately, "startSpaces")!.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
  expect(counted).not.toHaveBeenCalled();
  unmount(privately);
});

test("tapping the mark opens Search through New Tab with a bar tick on the press; it is announced as a Search button and counted only on Android, never while private", () => {
  const opened = jest.spyOn(browseStore, "newTab").mockImplementation(() => undefined);
  const pressTick = jest.spyOn(haptics, "barPress").mockImplementation(() => undefined);
  const root = start();
  const button = host(root, "startLogoButton")!;
  expect(button.props.accessibilityRole).toBe("button");
  expect(button.props.accessibilityLabel).toBe("Search");
  const logo = root.root.findAll((node) => node.props.testID === "startLogoButton" && typeof node.props.onPress === "function")[0]!;
  act(() => logo.props.onPressIn());
  expect(pressTick).toHaveBeenCalledTimes(1);
  expect(opened).not.toHaveBeenCalled();
  act(() => logo.props.onPressOut());
  act(() => logo.props.onPress());
  expect(opened).toHaveBeenCalledTimes(1);
  expect(counted.mock.calls.filter((call) => call[0] === "start_logo_taps")).toHaveLength(Platform.OS === "android" ? 1 : 0);
  unmount(root);
});

const content = (root: Root) => getAnimatedStyle(host(root, "startContent")!) as { opacity: number; transform: { scale: number }[] };

test("while the search tray is up the mark fades out and shrinks to 0.96, the bar fades, and neither takes touches", () => {
  withSpaces([profile("work", "Work", [tile(0)])]);
  const root = start();
  expect(content(root).opacity).toBe(1);
  act(() => presentSearch("home", ""));
  act(() => jest.advanceTimersByTime(600));
  expect(content(root).opacity).toBe(0);
  expect(content(root).transform[0]!.scale).toBeCloseTo(0.96, 5);
  expect((getAnimatedStyle(host(root, "startBar")!) as { opacity: number }).opacity).toBe(0);
  expect(host(root, "startContent")!.props.pointerEvents).toBe("none");
  expect(host(root, "startBar")!.props.pointerEvents).toBe("none");
  expect(host(root, "startContent")!.props.accessibilityElementsHidden).toBe(true);
  act(() => dismissSearch());
  act(() => jest.advanceTimersByTime(600));
  expect(content(root).opacity).toBe(1);
  expect(content(root).transform[0]!.scale).toBe(1);
  expect(host(root, "startContent")!.props.pointerEvents).toBe("box-none");
  unmount(root);
});

test("on the original start page Android's bar stays in place under the rising tray, as the page's bar does, so no frame has no bar; iPhone fades it", () => {
  const root = start("original");
  act(() => presentSearch("home", ""));
  act(() => jest.advanceTimersByTime(600));
  const bar = host(root, "startDeckBar")!;
  expect((getAnimatedStyle(bar) as { opacity: number }).opacity).toBe(Platform.OS === "android" ? 1 : 0);
  expect(bar.props.pointerEvents).toBe("none");
  expect(bar.props.accessibilityElementsHidden).toBe(true);
  act(() => dismissSearch());
  act(() => jest.advanceTimersByTime(600));
  expect((getAnimatedStyle(host(root, "startDeckBar")!) as { opacity: number }).opacity).toBe(1);
  unmount(root);
});

test("with Reduce Motion the mark only fades behind the tray, without shrinking", () => {
  mockMotion.reduced = true;
  withSpaces([profile("work", "Work")]);
  const root = start();
  act(() => presentSearch("home", ""));
  act(() => jest.advanceTimersByTime(600));
  expect(content(root).opacity).toBe(0);
  expect(content(root).transform[0]!.scale).toBe(1);
  unmount(root);
});

test("when the page width changes with the same space selected, the pager moves to that space at the new width", () => {
  withSpaces([profile("work", "Work"), profile("home", "Home")], "home");
  const scrolled = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => {});
  const spaces = (width: number) => <StartSpaces geometry={{ width, height: 678, safeSide: 0, barCenterY: 620 }} dark={false} incognito={false} />;
  const root = renderSurface(spaces(466));
  scrolled.mockClear();
  updateSurface(root, spaces(951));
  expect(scrolled).toHaveBeenCalledWith({ offset: 951, animated: false });
  scrolled.mockRestore();
  unmount(root);
});

test("with no tabs open the bar's Tabs button becomes Archive, or Synced Tabs when sync is on, so Start never leads to an empty tab view", () => {
  withTabs(0);
  const deck = jest.spyOn(browseStore, "showDeck").mockImplementation(async () => undefined);
  const archive = jest.spyOn(browseStore, "openArchive").mockImplementation(() => undefined);
  const spaces = jest.spyOn(browseStore, "openSpaces").mockImplementation(() => undefined);
  const press = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
  const offline = start();
  expect(host(offline, "startBarTabs")).toBeUndefined();
  expect(style(offline, "startBarArchive")).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  press(offline, "Archive");
  expect(archive).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("start_no_tabs_button_taps");
  unmount(offline);
  withSpaces([profile("work", "Work")]);
  const synced = start();
  expect(host(synced, "startBarArchive")).toBeUndefined();
  press(synced, "Synced Tabs");
  expect(spaces).toHaveBeenCalledTimes(1);
  unmount(synced);
  act(() => withTabs(1));
  const browsing = start();
  expect(host(browsing, "startBarSynced")).toBeUndefined();
  press(browsing, "Tabs");
  expect(deck).toHaveBeenCalledTimes(1);
  expect(archive).toHaveBeenCalledTimes(1);
  unmount(browsing);
});
