import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { StartScreen } from "../components/search/StartScreen";
import { DeckBar } from "../components/tabs/DeckBar";
import { ArdiaLogo, DesignProvider, FloatingMenu } from "../components/ui";
import { redesignedBarCenterFromBottom } from "../lib/deckGeometry";
import type { Design } from "../lib/design";
import { haptics } from "../state/app/haptics";
import { useBrowse } from "../state/browse/store";
import * as settingsNav from "../state/settings/nav";
import * as syncActions from "../state/sync/actions";
import { dismissSearch, presentSearch } from "../state/search/store";
import { OFF_STATUS, useSync, type PinnedTile, type SyncedProfile } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };
const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

const HEIGHT = 873;
const WIDTH = 393;
const SWITCHER_Y = HEIGHT * 0.44;
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

test("the redesigned start page has no logo and no deck bar; its own bar holds Tabs, a 77 by 48 plus and Settings, centred 11 points above the safe bottom on iPhone and where the browsing bar sits on Android (8 above its 3-button bar), 24 in from the sides", () => {
  const root = start();
  expect(root.root.findAll((node) => node.type === ArdiaLogo)).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === DeckBar)).toHaveLength(0);
  const bar = style(root, "startBar");
  expect(bar.top + bar.height / 2).toBe(BAR_CENTER_Y);
  expect(bar).toMatchObject({ height: 48, paddingHorizontal: 24 });
  expect(style(root, "startBarTabs")).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(style(root, "startBarSettings")).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(style(root, "startBarPlus")).toMatchObject({ width: 77, height: 48, borderRadius: 24 });
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

test("the space's switcher is centred at 0.44 of the screen's height, a plain header without a chevron when there is one space", () => {
  withSpaces([profile("work", "Work")]);
  const root = start();
  const switcher = style(root, "startSwitcher");
  expect(switcher.top + switcher.height / 2).toBeCloseTo(SWITCHER_Y, 5);
  expect(root.root.findAll((node) => node.props.accessibilityRole === "header" && node.props.accessibilityLabel === "Work")).not.toHaveLength(0);
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Space, Work")).toHaveLength(0);
  expect(host(root, "startPageDots")).toBeUndefined();
  expect(host(root, "startPager")).toBeUndefined();
  unmount(root);
});

test("pinned tiles sit 45 points under the switcher, four to a row, 52 tall with 14-point corners, 8 apart and 20 in from the sides, icon only", () => {
  withSpaces([profile("work", "Work", Array.from({ length: 6 }, (_, i) => tile(i)))]);
  const root = start();
  expect(style(root, "startTiles").top).toBeCloseTo(SWITCHER_Y + 45, 5);
  expect(style(root, "startTiles")).toMatchObject({ paddingHorizontal: 20, gap: 8 });
  expect(hosts(root, "startTileRow").map((row) => row.findAll((node) => node.props.testID === "startTile" && typeof node.type === "string").length)).toEqual([4, 2]);
  const width = (WIDTH - 40 - 3 * 8) / 4;
  for (const face of hosts(root, "startTile")) expect(StyleSheet.flatten(face.props.style)).toMatchObject({ width, height: 52, borderRadius: 14 });
  expect(hosts(root, "startTiles")[0]!.findAll((node) => node.type === "Text")).toHaveLength(0);
  unmount(root);
});

test("with fewer than four tiles the row splits between them, as SwiftUI's grid does", () => {
  withSpaces([profile("work", "Work", [tile(0), tile(1)])]);
  const root = start();
  for (const face of hosts(root, "startTile")) expect(StyleSheet.flatten(face.props.style).width).toBe((WIDTH - 40 - 8) / 2);
  unmount(root);
});

test("a tile opens its page in the space, and a folder tile opens a menu of its tabs", () => {
  const open = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  withSpaces([profile("work", "Work", [tile(0), tile(1, [{ key: "f0", title: "Inside", url: "https://inside.example/", icon: null }])])]);
  const root = start();
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Pin 0" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(open).toHaveBeenCalledWith("https://pin0.example/", "Pin 0", "work", "k0");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Pin 1" && typeof node.props.onPress === "function")[0]!.props.onPress());
  const menu = root.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(menu.props.items.map((item: { label: string }) => item.label)).toEqual(["Inside"]);
  act(() => menu.props.items[0].onPress());
  expect(open).toHaveBeenLastCalledWith("https://inside.example/", "Inside", "work", "f0");
  unmount(root);
});

test("with more than one space the pages swipe sideways, and the dots sit 60 points above the bar's centre with the current one lit", () => {
  withSpaces([profile("work", "Work"), profile("home", "Home"), profile("play", "Play")], "home");
  const root = start();
  expect(host(root, "startPager")).toBeDefined();
  const dots = style(root, "startPageDots");
  expect(dots.top + dots.height / 2).toBe(BAR_CENTER_Y - 60);
  expect(dots).toMatchObject({ gap: 21 });
  expect(hosts(root, "startPageDot")).toHaveLength(3);
  for (const dot of hosts(root, "startPageDot")) expect(StyleSheet.flatten(dot.props.style)).toMatchObject({ width: 7, height: 7 });
  expect(host(root, "startPageDots")!.props.accessibilityLabel).toBe("Space 2 of 3");
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

test("with more than one space the name is still a plain header with no chevron and no menu, and adjusting the dots switches space, counted as a pick and not a swipe", () => {
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  const root = start();
  expect(root.root.findAll((node) => node.props.accessibilityRole === "header" && node.props.accessibilityLabel === "Work")).not.toHaveLength(0);
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Space, Work")).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === FloatingMenu && node.props.items.some((item: { label: string }) => item.label === "Home"))).toHaveLength(0);
  const dots = host(root, "startPageDots")!;
  expect(dots.props.accessibilityRole).toBe("adjustable");
  expect(dots.props.accessibilityValue).toEqual({ text: "Work" });
  act(() => dots.props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } }));
  expect(select).not.toHaveBeenCalled();
  act(() => dots.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
  expect(select).toHaveBeenCalledWith("home");
  expect(tick).toHaveBeenCalledTimes(1);
  expect(counted.mock.calls).toEqual([["spaces_picked"]]);
  unmount(root);
});

test("in a private tab adjusting the dots still switches space but is never counted", () => {
  act(() => useTabs.setState({ incognito: true }));
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  const root = start();
  act(() => host(root, "startPageDots")!.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
  expect(select).toHaveBeenCalledWith("home");
  expect(counted).not.toHaveBeenCalled();
  unmount(root);
});

test("with no spaces and sync off, a Sync With Your Mac capsule sits where the switcher would, and opens sync setup", () => {
  const openSettings = jest.spyOn(settingsNav, "openSettings").mockImplementation(() => undefined);
  const root = start();
  const invitation = style(root, "startSyncInvitation");
  expect(invitation.top + invitation.minHeight / 2).toBeCloseTo(SWITCHER_Y, 5);
  const capsule = root.root.findAll((node) => node.props.accessibilityLabel === "Sync With Your Mac" && typeof node.props.onPress === "function")[0]!;
  act(() => capsule.props.onPress());
  expect(openSettings).toHaveBeenCalledWith({ page: "syncConnect" });
  expect(host(root, "startSwitcher")).toBeUndefined();
  unmount(root);
});

test("with sync on but no spaces yet, the page shows neither the switcher nor the invitation", () => {
  withSpaces([]);
  const root = start();
  expect(host(root, "startSyncInvitation")).toBeUndefined();
  expect(host(root, "startSwitcher")).toBeUndefined();
  unmount(root);
});

const content = (root: Root) => getAnimatedStyle(host(root, "startContent")!) as { opacity: number; transform: { scale: number }[] };

test("while the search tray is up the spaces fade out and shrink to 0.96, the bar fades, and neither takes touches", () => {
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

test("with Reduce Motion the spaces only fade behind the tray, without shrinking", () => {
  mockMotion.reduced = true;
  withSpaces([profile("work", "Work")]);
  const root = start();
  act(() => presentSearch("home", ""));
  act(() => jest.advanceTimersByTime(600));
  expect(content(root).opacity).toBe(0);
  expect(content(root).transform[0]!.scale).toBe(1);
  unmount(root);
});

const THEMED = { colors: ["#FF5A5F", "#5856D6"], darkColors: null };

test("over a themed space in light mode the backdrop wears a 34% white veil; in dark mode and in a private tab it doesn't", () => {
  withSpaces([profile("work", "Work", [], THEMED)]);
  const light = start();
  expect(style(light, "themeVeil").backgroundColor).toBe("rgba(255,255,255,0.34)");
  unmount(light);
  const scheme = jest.spyOn(require("react-native"), "useColorScheme").mockReturnValue("dark");
  const dark = start();
  expect(host(dark, "themeVeil")).toBeUndefined();
  unmount(dark);
  scheme.mockRestore();
  act(() => useTabs.setState({ incognito: true }));
  const privately = start();
  expect(host(privately, "themeVeil")).toBeUndefined();
  unmount(privately);
});

test("the original start page has no veil, and the native backdrop is asked for the themed look, which draws its own veil", () => {
  withSpaces([profile("work", "Work", [], THEMED)]);
  const original = start("original");
  expect(host(original, "themeVeil")).toBeUndefined();
  unmount(original);
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  const native = start();
  expect(host(native, "themeVeil")).toBeUndefined();
  expect(native.root.findAll((node) => node.type === lookModule.ProfileBackdrop).map((node) => node.props.themed)).toEqual([true]);
  unmount(native);
});
