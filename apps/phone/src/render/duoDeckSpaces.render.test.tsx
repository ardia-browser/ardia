import { Dimensions, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { DesignProvider } from "../components/ui";
import { deckGeometry } from "../lib/deckGeometry";
import { haptics } from "../state/app/haptics";
import { setRootSize } from "../state/app/rootSize";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import * as syncActions from "../state/sync/actions";
import { OFF_STATUS, useSync, type SyncedProfile } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const PORTRAIT = Dimensions.get("window");

const POSES = [
  { name: "closed", width: 466, height: 678, hinge: "closed", inRow: true },
  { name: "open", width: 951, height: 669, hinge: "fullyOpen", inRow: false },
] as const satisfies readonly { name: string; width: number; height: number; hinge: ScreenHinge; inRow: boolean }[];

const profile = (syncId: string, name: string): SyncedProfile => ({ syncId, name, color: null, icon: null, isDefault: syncId === "work", theme: null, deviceTabs: [], pinned: { tiles: [], sections: [] }, bookmarks: [], history: [], sendTargets: null });

function withSpaces(profiles: SyncedProfile[], enabled = true) {
  const selected = profiles[0]?.syncId ?? null;
  act(() =>
    useSync.setState((state) => ({
      ...state,
      status: { ...OFF_STATUS, isEnabled: enabled, phase: "updated" },
      view: { devices: [], profiles, search: null, syncedAt: 1, selectedProfileId: selected, shownProfileId: selected, receivers: [] } as never,
    })),
  );
}

function onScreen(width: number, height: number, hinge: ScreenHinge, right: number) {
  Dimensions.set({ window: { ...PORTRAIT, width, height }, screen: { ...PORTRAIT, width, height } });
  act(() => setRootSize(width, height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 0, bottom: 34, left: 0, right }));
  act(() => useScreenLayout.setState({ hinge }));
}

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  withSpaces([profile("work", "Work"), profile("home", "Home")]);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  act(() => setRootSize(0, 0));
  act(() => useScreenLayout.setState({ hinge: "none" }));
  withSpaces([], false);
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
const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
const shown = (node: ReactTestInstance) => ({ ...flat(node), ...(node.props.style ? getAnimatedStyle(node) : {}) }) as { opacity?: number; maxWidth?: number; minWidth?: number; marginLeft?: number; marginRight?: number };
const holds = (node: ReactTestInstance, id: string) => node.findAll((inner) => inner.props.testID === id).length > 0;
const barTop = (bar: ReactTestInstance) => {
  let place: ReactTestInstance | null = bar.parent;
  while (place && (typeof place.type !== "string" || (flat(place).top === undefined && flat(place).bottom === undefined))) place = place.parent;
  const { top, bottom } = flat(place!) as { top?: number; bottom?: number };
  return top ?? Dimensions.get("window").height - (bottom as number) - 48;
};
const switcher = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Space, Work" && typeof node.props.onPress === "function")[0];
const spacesMenu = (root: Root) => root.root.findAll((node) => Array.isArray(node.props.items) && node.props.place && node.props.items.some((item: { label?: string }) => item?.label === "Home"))[0]!;
const field = (root: Root) => root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onFocus === "function")[0]!;
const menuLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const pickMenu = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());

for (const pose of POSES) {
  test(`on the ${pose.name} Duo the space switcher is a 48-high capsule in the bottom bar, not in a header, with its label, hint and its deck-pull hit target, and its menu drawn above it, clear of the strip`, () => {
    onScreen(pose.width, pose.height, pose.hinge, 84);
    const root = deck();
    expect(host(root, "deckHeader")).toBeUndefined();
    const bar = host(root, "deckBottomBar")!;
    expect(holds(bar, "deckSwitcherGlass")).toBe(pose.inRow);
    expect(hosts(root, "deckSwitcherGlass").length).toBeGreaterThan(0);
    expect(flat(host(root, "deckSwitcherGlass")!)).toMatchObject({ borderRadius: 24 });
    const hit = hosts(root, "deckHit-spaces");
    expect(hit).toHaveLength(1);
    if (pose.inRow) {
      expect(flat(bar)).toMatchObject({ paddingLeft: 24, paddingRight: 96, gap: 0 });
      expect(bar.findAll((node) => typeof node.type === "string" && (node.props.testID === "deckHit-spaces" || node.props.testID === "deckSearchTabs")).map((node) => node.props.testID)).toEqual(["deckHit-spaces", "deckSearchTabs"]);
      expect(flat(hit[0]!)).toMatchObject({ flexShrink: 1, height: 48, maxWidth: 169 + 8 });
      expect(shown(host(root, "deckSwitcherFold")!)).toMatchObject({ opacity: 1, marginRight: 8 });
    } else {
      expect(flat(bar)).toMatchObject({ paddingLeft: 527, paddingRight: 24 });
      expect(flat(hit[0]!)).toMatchObject({ position: "absolute", top: 0, right: 951 - 871, height: 48, maxWidth: 200 });
      expect(951 - 24 - 48).toBe(871 + 8);
    }
    const press = switcher(root)!;
    expect(press.props.accessibilityHint).toBe("Shows your Mac’s spaces.");
    const menu = spacesMenu(root);
    expect(menu.props.drawn).toBe(true);
    expect(menu.props.place.top).toBeUndefined();
    expect(menu.props.place.bottom).toBe(pose.height - barTop(bar) + 8);
    expect(menu.props.place).toMatchObject(pose.inRow ? { left: 24, width: 250 } : { left: 871 - 250, width: 250 });
    expect(menu.props.place.left + menu.props.place.width).toBeLessThanOrEqual(pose.inRow ? 370 : 871);
    unmount(root);
  });

  test(`on the ${pose.name} Duo picking a space from the bottom bar's switcher switches to it and counts spaces_picked`, () => {
    onScreen(pose.width, pose.height, pose.hinge, 84);
    const select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
    const root = deck();
    act(() => switcher(root)!.props.onPress());
    expect(menuLabels(root)).toEqual(["Work", "Home"]);
    pickMenu(root, "Home");
    expect(select).toHaveBeenCalledWith("home");
    expect(counted.mock.calls.filter(([name]) => name === "spaces_picked")).toHaveLength(1);
    unmount(root);
  });

  test(`on the ${pose.name} Duo the switcher folds away while Search Tabs is focused or holds text, and comes back once it is empty and unfocused`, () => {
    onScreen(pose.width, pose.height, pose.hinge, 84);
    const root = deck();
    act(() => host(root, "deckSwitcherLock")!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 110, height: 48 } } }));
    act(() => field(root).props.onFocus());
    settle();
    const fold = () => shown(host(root, "deckSwitcherFold")!);
    expect(fold().opacity).toBeCloseTo(0, 3);
    expect(fold().maxWidth).toBeCloseTo(0, 3);
    if (pose.inRow) expect(fold().marginRight).toBeCloseTo(0, 3);
    expect(shown(host(root, "deckSwitcherLock")!).minWidth).toBe(110);
    expect(host(root, "deckSwitcherFold")!.props.pointerEvents).toBe("none");
    expect(host(root, "deckSwitcherFold")!.props.accessibilityElementsHidden).toBe(true);
    expect(spacesMenu(root).props.disabled).toBe(true);
    act(() => field(root).props.onChangeText("site1"));
    act(() => field(root).props.onBlur());
    settle();
    expect(fold().opacity).toBeCloseTo(0, 3);
    act(() => field(root).props.onChangeText(""));
    settle();
    expect(fold().opacity).toBeCloseTo(1, 3);
    expect(fold().maxWidth).toBe(pose.inRow ? 169 : 200);
    expect(shown(host(root, "deckSwitcherLock")!).minWidth).toBe(0);
    if (pose.inRow) expect(fold().marginRight).toBeCloseTo(8, 3);
    expect(host(root, "deckSwitcherFold")!.props.pointerEvents).toBe("box-none");
    expect(spacesMenu(root).props.disabled).toBe(false);
    unmount(root);
  });

  test(`on the ${pose.name} Duo with one space, or with sync off, there is no switcher and Search Tabs keeps the whole row`, () => {
    for (const [profiles, enabled] of [[[profile("work", "Work")], true], [[profile("work", "Work"), profile("home", "Home")], false]] as const) {
      withSpaces([...profiles], enabled);
      onScreen(pose.width, pose.height, pose.hinge, 84);
      const root = deck();
      expect(host(root, "deckHit-spaces")).toBeUndefined();
      expect(host(root, "deckSwitcherGlass")).toBeUndefined();
      expect(host(root, "deckHeader")).toBeUndefined();
      expect(flat(host(root, "deckBottomBar")!)).toMatchObject({ gap: 8 });
      expect(flat(host(root, "deckBottomBar")!)).toMatchObject(pose.inRow ? { paddingLeft: 24, paddingRight: 96 } : { paddingLeft: 527, paddingRight: 24 });
      unmount(root);
    }
  });
}

test("on the open Duo the strip holds four slots: ··· 165, + 110 and Incognito 55 above the magnifier on the bar's line", () => {
  onScreen(951, 669, "fullyOpen", 84);
  const root = deck();
  expect(flat(host(root, "deckStripMore")!)).toMatchObject({ top: -165, left: 879 });
  expect(flat(host(root, "deckStripPlus")!)).toMatchObject({ top: -110, left: 879 });
  expect(flat(host(root, "deckStripIncognito")!)).toMatchObject({ top: -55, left: 879 });
  expect(flat(host(root, "deckSearchCircle")!)).toMatchObject({ right: 0, width: 48 });
  unmount(root);
});

test("on a Duo the deck gives its geometry no header height, so the card band's floor is 41 below the safe top, while a plain iPhone keeps its header, its menu and its band", () => {
  onScreen(466, 678, "closed", 84);
  const duo = deck();
  const raised = deckGeometry(466, 678, 0, 34, 84, Platform.OS, "redesigned", 0, 55, "arc", { side: "right", inset: 84 });
  const card = hosts(duo, "deckCard")[0]!;
  expect(flat(card).width).toBeCloseTo(raised.cardWidth, 1);
  expect(raised.cardCenterY - raised.cardHeight / 2).toBeGreaterThanOrEqual(41);
  unmount(duo);
  onScreen(402, 874, "none", 0);
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 62, bottom: 34, left: 0, right: 0 }));
  const phone = deck();
  const header = host(phone, "deckHeader")!;
  expect(holds(header, "deckSwitcherGlass")).toBe(true);
  expect(flat(header)).toMatchObject({ paddingHorizontal: 24 });
  expect((flat(header).top as number) + (flat(header).height as number) / 2).toBe(62 + 26);
  expect(holds(host(phone, "deckBottomBar")!, "deckSwitcherGlass")).toBe(false);
  expect(flat(host(phone, "deckSwitcherGlass")!)).toMatchObject({ borderRadius: 22 });
  expect(spacesMenu(phone).props.place).toEqual({ top: 62 + deckHeaderBottom() + 8, left: 24, width: 250 });
  expect(spacesMenu(phone).props.drawn).toBe(false);
  const phoneGeometry = deckGeometry(402, 874, 62, 34, 0, Platform.OS, "redesigned", deckHeaderBottom(), 55, "arc");
  expect(flat(hosts(phone, "deckCard")[0]!).width).toBeCloseTo(phoneGeometry.cardWidth, 1);
  unmount(phone);
});
