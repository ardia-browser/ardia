import { Platform, StyleSheet } from "react-native";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, someTabs, unmount } from "../../test/render/harness";
import type { Design } from "../lib/design";
import { idOf, itemOf, mockNative, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { TabDeck } = require("../components/tabs/TabDeck") as typeof import("../components/tabs/TabDeck");
const { DesignProvider, menuLook, onDrawnMenuActionChosen } = require("../components/ui") as typeof import("../components/ui");
const { haptics } = require("../state/app/haptics") as typeof import("../state/app/haptics");
const { useArchiveCard } = require("../state/browse/archiveCard") as typeof import("../state/browse/archiveCard");
const { countDrawnMenuAction } = require("../state/browse/menuCounts") as typeof import("../state/browse/menuCounts");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const settingsNav = require("../state/settings/nav") as typeof import("../state/settings/nav");
const syncActions = require("../state/sync/actions") as typeof import("../state/sync/actions");
const syncHooks = require("../state/sync/hooks") as typeof import("../state/sync/hooks");
const { OFF_STATUS, useSync } = require("../state/sync/store") as typeof import("../state/sync/store");
const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
const tabHooks = require("../state/tabs/hooks") as typeof import("../state/tabs/hooks");
const tabSpaces = require("../state/tabs/spaces") as typeof import("../state/tabs/spaces");
const tabStore = require("../state/tabs/store") as typeof import("../state/tabs/store");
const { launchTabs } = require("../state/tabs/tabsState") as typeof import("../state/tabs/tabsState");

type Root = ReturnType<typeof renderSurface>;
type SyncedProfile = import("../state/sync/store").SyncedProfile;

const profile = (syncId: string, name: string, icon: string | null = null): SyncedProfile => ({
  syncId,
  name,
  color: null,
  icon,
  isDefault: syncId === "work",
  theme: null,
  deviceTabs: [],
  pinned: { tiles: [], sections: [] },
  bookmarks: [],
  history: [],
  sendTargets: null,
});

const WORK = profile("work", "Work", "briefcase");
const HOME = profile("home", "Home");

function withSpaces(profiles: SyncedProfile[], selected = profiles[0]?.syncId ?? null) {
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
    view: { devices: [], profiles, search: null, syncedAt: 1, selectedProfileId: selected, shownProfileId: selected, receivers: [] } as never,
  }));
}

const STUDIO = { id: "studio", name: "Studio", kind: "mac", lastSeen: 1, isCurrent: false, canReceiveTabs: true };
const BOOK = { id: "book", name: "Shivam’s MacBook Pro", kind: "mac", lastSeen: 1, isCurrent: false, canReceiveTabs: true };
const PIXEL = { id: "pixel", name: "Pixel", kind: "phone", lastSeen: 1, isCurrent: false, canReceiveTabs: true };

beforeEach(() => {
  jest.useFakeTimers();
  resetNativeMenus(true);
  act(() => {
    tabStore.useTabs.setState({ ...launchTabs(someTabs(3), 0), incognito: false, listing: 0 });
    useArchiveCard.setState({ showing: false });
    browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
    useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } }));
  });
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => useArchiveCard.setState({ showing: false }));
  act(() => jest.runOnlyPendingTimers());
  resetNativeMenus();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const deck = (design: Design = "redesigned") =>
  renderSurface(
    <DesignProvider design={design}>
      <TabDeck />
    </DesignProvider>,
  );

const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const menuAround = (root: Root, label: string) => contextMenus(root).find((menu) => menu.findAll((node) => node.props.accessibilityLabel === label).length > 0)!;
const cardMenus = (root: Root) => contextMenus(root).filter((menu) => menu.props.testID === "deckCardMenu");
const items = (menu: ReactTestInstance): NativeItem[] => menu.props.items;
const choose = (menu: ReactTestInstance, title: string) => act(() => menu.props.onSelect(idOf(menu.props.items, title)));


const nativeTest = Platform.OS === "ios" ? test : test.skip;

nativeTest("each deck card is a system context menu on a long press with main's CardMenu, and our own long-press gesture steps aside", () => {
  withSpaces([WORK, HOME]);
  jest.spyOn(syncHooks, "useSendTargets").mockReturnValue([STUDIO, BOOK, PIXEL] as never);
  jest.spyOn(syncHooks, "useIsPinned").mockReturnValue(false);
  jest.spyOn(tabSpaces, "moveTargets").mockReturnValue([HOME] as never);
  const root = deck();
  const menus = cardMenus(root);
  expect(menus).toHaveLength(3);
  expect(menus[0]!.props.trigger).toBe("longPress");
  expect(titles(items(menus[0]!))).toEqual(["Copy Link", "Share", { "Send to Device": ["Studio", "Shivam’s MacBook Pro", "Pixel"] }, "Pin to Mac", { "Move to Space": ["Home"] }, { "": ["Close Tab"] }]);
  expect(itemOf(items(menus[0]!), "Studio")!.systemImage).toBe("desktopcomputer");
  expect(itemOf(items(menus[0]!), "Shivam’s MacBook Pro")!.systemImage).toBe("laptopcomputer");
  expect(itemOf(items(menus[0]!), "Pixel")!.systemImage).toBe("iphone");
  expect(itemOf(items(menus[0]!), "Home")!.systemImage).toBe("h.square.fill");
  expect(itemOf(items(menus[0]!), "Close Tab")!.destructive).toBe(true);
  expect(getByGestureTestId("deckLongPress").config.enabled).toBe(false);
  unmount(root);
});

nativeTest("a card menu's items do what they say: Send, Pin, Move to Space and Close Tab", () => {
  withSpaces([WORK, HOME]);
  jest.spyOn(syncHooks, "useSendTargets").mockReturnValue([PIXEL] as never);
  jest.spyOn(syncHooks, "useIsPinned").mockReturnValue(false);
  jest.spyOn(tabSpaces, "moveTargets").mockReturnValue([HOME] as never);
  const send = jest.spyOn(syncActions, "sendTab").mockResolvedValue(undefined);
  const pin = jest.spyOn(syncActions, "pinToMac").mockResolvedValue(undefined);
  const move = jest.spyOn(tabStore, "moveTabToSpace").mockImplementation(() => undefined);
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
  const root = deck();
  const menu = cardMenus(root)[1]!;
  const tab = tabStore.currentTabs().open[1]!;
  expect(titles(items(menu))).toEqual(["Copy Link", "Share", "Send to Pixel", "Pin to Mac", { "Move to Space": ["Home"] }, { "": ["Close Tab"] }]);
  expect(itemOf(items(menu), "Send to Pixel")!.systemImage).toBe("iphone");
  choose(menu, "Send to Pixel");
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: tab.id }), PIXEL);
  choose(menu, "Pin to Mac");
  expect(pin).toHaveBeenCalledWith(expect.objectContaining({ id: tab.id }), expect.any(Function));
  choose(menu, "Home");
  expect(move).toHaveBeenCalledWith(tab.id, "home");
  choose(menu, "Close Tab");
  act(() => jest.advanceTimersByTime(1000));
  expect(closed).toHaveBeenCalledWith(tab.id);
  unmount(root);
});

nativeTest("a pinned tab reads Pinned to Mac, disabled, and a tab that can't be shared offers only Close Tab", () => {
  withSpaces([WORK]);
  jest.spyOn(syncHooks, "useIsPinned").mockReturnValue(true);
  act(() => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.map((tab, at) => (at === 2 ? { ...tab, url: "about:blank" } : tab)) })));
  const root = deck();
  const menus = cardMenus(root);
  expect(itemOf(items(menus[0]!), "Pinned to Mac")).toMatchObject({ disabled: true });
  expect(itemOf(items(menus[0]!), "Pin to Mac")).toBeUndefined();
  expect(titles(items(menus[2]!))).toEqual(["Close Tab"]);
  unmount(root);
});

nativeTest("the ··· menu is main's DeckMoreMenu on a tap, in fixed order, and Close All asks with the system's action sheet", async () => {
  withSpaces([WORK]);
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const settings = jest.spyOn(settingsNav, "openSettings").mockImplementation(() => undefined);
  const closeAll = jest.spyOn(browse, "closeAllFromDeck").mockImplementation(() => undefined);
  const root = deck();
  const more = menuAround(root, "More");
  expect(more.props.trigger).toBe("tap");
  expect(more.props.fixedOrder).toBe(true);
  expect(titles(items(more))).toEqual(["Spaces", { "": ["New Incognito Tab", "Reopen Closed Tab", "Close All Tabs"] }, { "": ["Settings"] }]);
  expect(itemOf(items(more), "Close All Tabs")!.destructive).toBe(true);
  choose(more, "Settings");
  expect(settings).toHaveBeenCalledTimes(1);
  mockNative.answer = "confirm";
  choose(more, "Close All Tabs");
  await act(async () => undefined);
  expect(mockNative.sheets[0]).toMatchObject({ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", actions: [{ id: "confirm", title: "Close All Tabs", destructive: true }, { cancel: true }] });
  expect(closeAll).toHaveBeenCalledTimes(1);
  unmount(root);
});

nativeTest("the space switcher lists the spaces with a check on the current one and their symbols, and picking one switches", () => {
  withSpaces([WORK, HOME]);
  const select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
  const root = deck();
  const switcher = menuAround(root, "Space, Work");
  expect(switcher.props.trigger).toBe("tap");
  expect(items(switcher)).toEqual([
    { id: "0", title: "Work", systemImage: "briefcase", checked: true },
    { id: "1", title: "Home", systemImage: "h.square.fill" },
  ]);
  choose(switcher, "Home");
  expect(select).toHaveBeenCalledWith("home");
  unmount(root);
});

nativeTest("the deck header shows a space's name alone when it has no icon of its own, with no initial in a circle, and the space's icon beside its name when it has one", () => {
  withSpaces([HOME, WORK]);
  const plain = deck();
  const title = menuAround(plain, "Space, Home");
  expect(title.findAll((node) => node.props.testID === "startSpaceGlyph")).toHaveLength(0);
  const words = title.findAll((node) => typeof node.type === "string" && node.type === "Text").map((node) => node.children.join(""));
  expect(words).toEqual(["Home"]);
  unmount(plain);
  withSpaces([profile("garden", "Garden", "🌱"), HOME]);
  const marked = deck();
  expect(menuAround(marked, "Space, Garden").findAll((node) => node.props.testID === "startSpaceGlyph" && typeof node.type === "string")).toHaveLength(1);
  unmount(marked);
});

nativeTest("holding the Incognito switch offers Close Incognito Tabs, which asks with an action sheet first", async () => {
  act(() => tabStore.useTabs.setState((state) => ({ ...state, privates: someTabs(2, true) })));
  const leave = jest.spyOn(browse, "leaveIncognito").mockImplementation(() => undefined);
  const root = deck();
  const pill = menuAround(root, "Incognito");
  expect(pill.props.trigger).toBe("longPress");
  expect(items(pill)).toEqual([{ id: "0", title: "Close Incognito Tabs", destructive: true }]);
  choose(pill, "Close Incognito Tabs");
  await act(async () => undefined);
  expect(mockNative.sheets[0]).toMatchObject({ title: "Close Incognito Tabs?", message: "Their pages, cookies and history are cleared." });
  expect(leave).not.toHaveBeenCalled();
  mockNative.answer = "confirm";
  choose(pill, "Close Incognito Tabs");
  await act(async () => undefined);
  expect(leave).toHaveBeenCalledTimes(1);
  unmount(root);
});

nativeTest("the plus keeps its tap and its long press is main's PlusButton menu", () => {
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const opened = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const incognito = jest.spyOn(browse, "newIncognitoTab").mockImplementation(() => undefined);
  const reopen = jest.spyOn(browse, "reopenLastClosed").mockImplementation(() => undefined);
  const root = deck();
  const plus = menuAround(root, "New Tab");
  expect(plus.props.trigger).toBe("longPress");
  expect(titles(items(plus))).toEqual(["New Incognito Tab", "Reopen Closed Tab"]);
  act(() => plus.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(opened).toHaveBeenCalledTimes(1);
  choose(plus, "New Incognito Tab");
  choose(plus, "Reopen Closed Tab");
  expect(incognito).toHaveBeenCalledTimes(1);
  expect(reopen).toHaveBeenCalledTimes(1);
  unmount(root);
});

const drawnTest = Platform.OS === "android" ? test : test.skip;
const menuitems = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const pick = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
const press = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
const menuRowHeight = (row: ReactTestInstance) => {
  const style = typeof row.props.style === "function" ? row.props.style({ pressed: false }) : row.props.style;
  return StyleSheet.flatten(style).minHeight;
};
function expectEvenRows(root: Root) {
  const rows = root.root.findAll((node) => node.props.testID === "drawnMenuRows" && typeof node.type !== "string")[0]!;
  expect(rows.findAll((node) => node.props.testID === "drawnMenuGap" && typeof node.type === "string")).toHaveLength(0);
  const heights = rows.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.props.onPress === "function" && typeof node.type !== "string").map(menuRowHeight);
  expect(new Set(heights)).toEqual(new Set([menuLook.row]));
}

drawnTest("on Android the ··· menu's rows sit one after another at one row height, with no blank band between its groups, whichever optional rows it holds", () => {
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(false);
  const root = deck();
  press(root, "More");
  expect(menuitems(root)).toEqual(["New Incognito Tab", "Close All Tabs", "Settings"]);
  expectEvenRows(root);
  unmount(root);
});

drawnTest("on Android a deck card's long press opens main's CardMenu drawn at the finger, dimmed, where the system's menu would have been", () => {
  withSpaces([WORK]);
  const root = deck();
  expect(contextMenus(root)).toHaveLength(0);
  const { State } = require("react-native-gesture-handler") as typeof import("react-native-gesture-handler");
  const { fireGestureHandler } = require("react-native-gesture-handler/jest-utils") as typeof import("react-native-gesture-handler/jest-utils");
  const { deckCardAt, deckGeometry, initialDeckScroll } = require("../lib/deckGeometry") as typeof import("../lib/deckGeometry");
  const { deckHeaderBottom } = require("../components/tabs/DeckHeader") as typeof import("../components/tabs/DeckHeader");
  const g = deckGeometry(393, 873, 40, 24, 0, Platform.OS, "redesigned", deckHeaderBottom(), 55, "arc");
  const y = g.cardCenterY;
  let x = 0;
  while (x < 393 && deckCardAt(g, 3, initialDeckScroll(3), x, y) < 0) x += 2;
  expect(getByGestureTestId("deckLongPress").config.enabled).toBe(true);
  act(() => fireGestureHandler(getByGestureTestId("deckLongPress"), [{ state: State.BEGAN, x, y, absoluteX: x, absoluteY: y }, { state: State.ACTIVE, x, y, absoluteX: x, absoluteY: y }, { state: State.END, x, y, absoluteX: x, absoluteY: y }]));
  act(() => jest.advanceTimersByTime(16));
  expect(menuitems(root)).toEqual(["Copy Link", "Share", "Pin to Mac", "Close Tab"]);
  const { Menu } = require("../components/ui") as typeof import("../components/ui");
  const menu = root.root.findAll((node) => node.type === Menu)[0]!;
  expect(menu.props.dimmed).toBe(true);
  const { width, height } = require("react-native").Dimensions.get("window");
  const { pointPlacer } = require("../components/ui") as typeof import("../components/ui");
  expect(menu.props.privately).toBe(false);
  expect(menu.props.placer(240)).toEqual(pointPlacer({ x, y }, { width, height }, { top: 40, bottom: 24, left: 0, right: 0 }, 250)(240));
  expect(menu.props.placer(240).place.top).toBeGreaterThanOrEqual(40);
  unmount(root);
});

drawnTest("on Android the ··· menu is drawn with main's items, and Close All asks in the drawn action sheet before it closes anything", () => {
  withSpaces([WORK]);
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const closeAll = jest.spyOn(browse, "closeAllFromDeck").mockImplementation(() => undefined);
  const root = deck();
  press(root, "More");
  expect(menuitems(root)).toEqual(["Spaces", "New Incognito Tab", "Reopen Closed Tab", "Close All Tabs", "Settings"]);
  expectEvenRows(root);
  pick(root, "Close All Tabs");
  expect(mockNative.sheets).toHaveLength(0);
  expect(closeAll).not.toHaveBeenCalled();
  expect(root.root.findAll((node) => node.props.testID === "drawnActionSheet" && typeof node.type === "string")).toHaveLength(1);
  press(root, "Close All Tabs");
  expect(closeAll).toHaveBeenCalledTimes(1);
  unmount(root);
});

drawnTest("on Android Settings chosen from the drawn ··· menu opens Settings, with no native menu view mounted to lose the choice", async () => {
  withSpaces([WORK]);
  const settings = jest.spyOn(settingsNav, "openSettings").mockImplementation(() => undefined);
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  jest.spyOn(overlay, "measureAnchor").mockResolvedValue({ x: 337, y: 52, width: 44, height: 44 });
  jest.spyOn(overlay, "useOverlayFrame").mockReturnValue(() => Promise.resolve({ x: 0, y: 0, width: 393, height: 873 }));
  const root = deck();
  expect(contextMenus(root)).toHaveLength(0);
  press(root, "More");
  expect(contextMenus(root)).toHaveLength(0);
  for (let step = 0; step < 3; step++) await act(async () => undefined);
  act(() => root.root.findAll((node) => node.props.testID === "drawnMenuRows" && typeof node.props.onContentSizeChange === "function")[0]!.props.onContentSizeChange(250, 320));
  const row = root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === "Settings" && typeof node.type === "string")[0]!;
  expect(row.props.accessibilityState?.disabled).toBeFalsy();
  const blockers: string[] = [];
  for (let at = row.parent; at; at = at.parent) if (typeof at.type === "string" && (at.props.pointerEvents === "none" || at.props.pointerEvents === "box-only")) blockers.push(`${at.props.testID ?? at.type}:${at.props.pointerEvents}`);
  expect(blockers).toEqual([]);
  pick(root, "Settings");
  expect(settings).toHaveBeenCalledTimes(1);
  unmount(root);
});

drawnTest("on Android the space switcher and holding the Incognito switch are drawn menus, and leaving Incognito asks in the drawn action sheet", () => {
  withSpaces([WORK, HOME]);
  act(() => tabStore.useTabs.setState((state) => ({ ...state, privates: someTabs(2, true) })));
  const select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
  const leave = jest.spyOn(browse, "leaveIncognito").mockImplementation(() => undefined);
  const root = deck();
  press(root, "Space, Work");
  expect(menuitems(root)).toEqual(["Work", "Home"]);
  pick(root, "Home");
  expect(select).toHaveBeenCalledWith("home");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Incognito" && node.props.accessibilityRole === "switch" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress());
  pick(root, "Close Incognito Tabs");
  expect(leave).not.toHaveBeenCalled();
  act(() => root.root.findAll((node) => node.props.testID === "drawnConfirmationOutside" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(leave).not.toHaveBeenCalled();
  unmount(root);
});

drawnTest.each(["original", "redesigned", "material"] as const)("the %s deck's Close Incognito Tabs menu keeps the regular overview's look and counts the choice once, as its opens are counted", (design) => {
  act(() => tabStore.useTabs.setState({ privates: someTabs(2, true) }));
  const root = deck(design);
  onDrawnMenuActionChosen(countDrawnMenuAction);
  try {
    if (design === "original") press(root, "Incognito, 2 tabs");
    else act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Incognito" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress());
    if (design === "material") {
      const { materialMenuFill } = require("../components/ui/MaterialSurfaces") as typeof import("../components/ui/MaterialSurfaces");
      const { SEEDED_SCHEMES } = require("../lib/material/schemes") as typeof import("../lib/material/schemes");
      const group = root.root.findAll((node) => node.props.testID === "materialMenuGroup" && typeof node.type === "string")[0]!;
      const { StyleSheet } = require("react-native") as typeof import("react-native");
      expect(StyleSheet.flatten(group.props.style).backgroundColor).toBe(materialMenuFill(SEEDED_SCHEMES.ardia.light, false));
    }
    pick(root, "Close Incognito Tabs");
    expect(root.root.findAll((node) => node.props.testID === "drawnConfirmationOutside" && typeof node.props.onPress === "function")).not.toHaveLength(0);
    expect((telemetry.countUsage as jest.Mock).mock.calls.filter((call) => call[0] === "drawn_menu_actions_chosen")).toHaveLength(1);
  } finally {
    onDrawnMenuActionChosen(() => undefined);
    unmount(root);
  }
});

drawnTest("on Android holding the plus opens main's PlusButton menu at the finger", () => {
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const root = deck();
  const plus = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onLongPress === "function")[0]!;
  act(() => plus.props.onLongPress({ nativeEvent: { pageX: 340, pageY: 820 } }));
  const { FloatingMenu } = require("../components/ui") as typeof import("../components/ui");
  const menu = root.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(menu.props.at).toEqual({ x: 340, y: 820 });
  expect(menu.props.dimmed).toBe(true);
  expect((menu.props.items as { label: string }[]).map((item) => item.label)).toEqual(["New Incognito Tab", "Reopen Closed Tab"]);
  unmount(root);
});

drawnTest("on Android a deck card's long-press menu hides the deck from TalkBack while it is open, as every drawn menu and confirmation does", () => {
  withSpaces([WORK]);
  const root = deck();
  const covered = () => root.root.findAll((node) => node.props.testID === "overlayCovered" && typeof node.type === "string")[0]!.props.importantForAccessibility;
  expect(covered()).toBe("auto");
  const { State } = require("react-native-gesture-handler") as typeof import("react-native-gesture-handler");
  const { fireGestureHandler } = require("react-native-gesture-handler/jest-utils") as typeof import("react-native-gesture-handler/jest-utils");
  const { deckCardAt, deckGeometry, initialDeckScroll } = require("../lib/deckGeometry") as typeof import("../lib/deckGeometry");
  const { deckHeaderBottom } = require("../components/tabs/DeckHeader") as typeof import("../components/tabs/DeckHeader");
  const g = deckGeometry(393, 873, 40, 24, 0, Platform.OS, "redesigned", deckHeaderBottom(), 55, "arc");
  const y = g.cardCenterY;
  let x = 0;
  while (x < 393 && deckCardAt(g, 3, initialDeckScroll(3), x, y) < 0) x += 2;
  act(() => fireGestureHandler(getByGestureTestId("deckLongPress"), [{ state: State.BEGAN, x, y, absoluteX: x, absoluteY: y }, { state: State.ACTIVE, x, y, absoluteX: x, absoluteY: y }, { state: State.END, x, y, absoluteX: x, absoluteY: y }]));
  act(() => jest.advanceTimersByTime(16));
  expect(covered()).toBe("no-hide-descendants");
  expect(root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").length).toBeGreaterThan(0);
  unmount(root);
});

drawnTest("on Android TalkBack reaches a deck card's menu through its Tab Options action, opened from the card's frame like a long press with no touch point", async () => {
  withSpaces([WORK]);
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  jest.spyOn(overlay, "measureAnchor").mockResolvedValue({ x: 60, y: 200, width: 280, height: 520 });
  const root = deck();
  const card = root.root.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions) && node.props.accessibilityActions.some((action: { name: string }) => action.name === "menu"))[0]!;
  expect(card.props.accessibilityActions).toContainEqual({ name: "menu", label: "Tab Options" });
  act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  await act(async () => undefined);
  expect(menuitems(root)).toEqual(["Copy Link", "Share", "Pin to Mac", "Close Tab"]);
  const { Menu } = require("../components/ui") as typeof import("../components/ui");
  const placed = root.root.findAll((node) => node.type === Menu)[0]!.props.placer(240);
  expect(placed.place.top + placed.maxHeight).toBe(720 - 16);
  unmount(root);
});

drawnTest("Tab Options keeps the tab it was asked for while the card is measured: an earlier tab closing meanwhile doesn't move it to the next tab's menu", async () => {
  withSpaces([WORK]);
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  let measured!: (rect: { x: number; y: number; width: number; height: number }) => void;
  jest.spyOn(overlay, "measureAnchor").mockImplementation(() => new Promise((resolve) => (measured = resolve)));
  const tabMenus = require("../state/browse/tabMenus") as typeof import("../state/browse/tabMenus");
  const copied = jest.spyOn(tabMenus, "copyTabLink").mockImplementation(() => undefined);
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
  const root = deck();
  const withMenu = () => root.root.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions) && node.props.accessibilityActions.some((action: { name: string }) => action.name === "menu"));
  const asked = withMenu()[1]!;
  const askedTab = tabStore.currentTabs().open.find((tab) => tab.title === asked.props.accessibilityLabel)!;
  act(() => asked.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  const earlier = tabStore.currentTabs().open.find((tab) => tab.title === withMenu()[0]!.props.accessibilityLabel)!;
  act(() => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.id !== earlier.id) })));
  await act(async () => measured({ x: 60, y: 200, width: 280, height: 520 }));
  pick(root, "Copy Link");
  expect(copied).toHaveBeenCalledWith(expect.objectContaining({ id: askedTab.id }));
  expect(closed).not.toHaveBeenCalled();
  unmount(root);
});

drawnTest("Tab Options is dropped if its tab has gone by the time the card is measured", async () => {
  withSpaces([WORK]);
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  let measured!: (rect: { x: number; y: number; width: number; height: number }) => void;
  jest.spyOn(overlay, "measureAnchor").mockImplementation(() => new Promise((resolve) => (measured = resolve)));
  const root = deck();
  const asked = root.root.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions) && node.props.accessibilityActions.some((action: { name: string }) => action.name === "menu"))[1]!;
  const askedTab = tabStore.currentTabs().open.find((tab) => tab.title === asked.props.accessibilityLabel)!;
  act(() => asked.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  act(() => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.id !== askedTab.id) })));
  await act(async () => measured({ x: 60, y: 200, width: 280, height: 520 }));
  expect(menuitems(root)).toEqual([]);
  unmount(root);
});

drawnTest("a card's menu whose tab goes while it is open lets the deck go: the menu closes and the deck is no longer shaded or hidden; a move of its card keeps it on the same tab", async () => {
  withSpaces([WORK]);
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  jest.spyOn(overlay, "measureAnchor").mockResolvedValue({ x: 60, y: 200, width: 280, height: 520 });
  const { Shade } = require("../components/ui") as typeof import("../components/ui");
  const root = deck();
  const shaded = () => root.root.findAll((node) => node.type === Shade)[0]!.props.shaded;
  const withMenu = () => root.root.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions) && node.props.accessibilityActions.some((action: { name: string }) => action.name === "menu"));
  const asked = withMenu()[1]!;
  const askedTab = tabStore.currentTabs().open.find((tab) => tab.title === asked.props.accessibilityLabel)!;
  act(() => asked.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  await act(async () => undefined);
  expect(menuitems(root).length).toBeGreaterThan(0);
  expect(shaded()).toBe(true);
  const placeOf = () => withMenu().findIndex((node) => node.props.accessibilityLabel === askedTab.title);
  const placeBefore = placeOf();
  const earlier = tabStore.currentTabs().open.find((tab) => tab.title === withMenu()[0]!.props.accessibilityLabel)!;
  act(() => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.id !== earlier.id) })));
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(1000));
  expect(placeOf()).toBe(placeBefore - 1);
  expect(menuitems(root).length).toBeGreaterThan(0);
  expect(shaded()).toBe(true);
  const tabMenus = require("../state/browse/tabMenus") as typeof import("../state/browse/tabMenus");
  const copied = jest.spyOn(tabMenus, "copyTabLink").mockImplementation(() => undefined);
  pick(root, "Copy Link");
  expect(copied).toHaveBeenCalledWith(expect.objectContaining({ id: askedTab.id }));
  act(() => jest.advanceTimersByTime(1000));
  act(() => asked.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  await act(async () => undefined);
  expect(menuitems(root).length).toBeGreaterThan(0);
  act(() => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.id !== askedTab.id) })));
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(1000));
  expect(menuitems(root)).toEqual([]);
  expect(shaded()).toBe(false);
  unmount(root);
});

drawnTest("after a stack card's Tab Options menu closes without a choice, TalkBack goes back to that card once the menu has gone; not after a choice, a newer overlay or the card's tab leaving", async () => {
  withSpaces([WORK]);
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  jest.spyOn(overlay, "measureAnchor").mockResolvedValue({ x: 60, y: 200, width: 280, height: 520 });
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const { Menu } = require("../components/ui") as typeof import("../components/ui");
  const root = deck();
  const withMenu = () => root.root.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions) && node.props.accessibilityActions.some((action: { name: string }) => action.name === "menu"));
  const label = withMenu()[1]!.props.accessibilityLabel;
  const cardTab = tabStore.currentTabs().open.find((tab) => tab.title === label)!;
  const open = async () => {
    act(() => withMenu().find((node) => node.props.accessibilityLabel === label)!.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
    await act(async () => undefined);
    expect(menuitems(root).length).toBeGreaterThan(0);
    asked.mockClear();
  };
  const dismiss = (chosen?: boolean) => act(() => root.root.findAll((node) => node.type === Menu)[0]!.props.onDismiss(chosen));
  const through = () => {
    act(() => jest.advanceTimersByTime(1000));
    act(() => jest.advanceTimersByTime(32));
  };
  const landedOn = () =>
    asked.mock.calls
      .map(([target]) => target())
      .filter(Boolean)
      .map((view) => root.root.findAll((node) => node.instance === view)[0]?.props.accessibilityLabel);
  await open();
  dismiss();
  through();
  expect(landedOn()).toEqual([label]);
  await open();
  dismiss(true);
  through();
  expect(landedOn()).toEqual([]);
  await open();
  dismiss();
  await open();
  through();
  expect(landedOn()).toEqual([]);
  dismiss();
  act(() => tabStore.useTabs.setState((state) => ({ ...state, open: state.open.filter((tab) => tab.id !== cardTab.id) })));
  await act(async () => undefined);
  through();
  expect(landedOn()).toEqual([]);
  unmount(root);
});

for (const order of ["later first", "earlier first"] as const) {
  drawnTest(`two Tab Options asked one after the other: only the later one opens its menu, with the ${order === "later first" ? "later" : "earlier"} measurement back first`, async () => {
    withSpaces([WORK]);
    const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
    const pending: ((rect: { x: number; y: number; width: number; height: number }) => void)[] = [];
    jest.spyOn(overlay, "measureAnchor").mockImplementation(() => new Promise((resolve) => void pending.push(resolve)));
    const tabMenus = require("../state/browse/tabMenus") as typeof import("../state/browse/tabMenus");
    const copied = jest.spyOn(tabMenus, "copyTabLink").mockImplementation(() => undefined);
    const root = deck();
    const withMenu = () => root.root.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions) && node.props.accessibilityActions.some((action: { name: string }) => action.name === "menu"));
    const [first, second] = [withMenu()[0]!, withMenu()[1]!];
    const tabOf = (node: ReactTestInstance) => tabStore.currentTabs().open.find((tab) => tab.title === node.props.accessibilityLabel)!;
    const [firstTab, secondTab] = [tabOf(first), tabOf(second)];
    act(() => first.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
    act(() => second.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
    expect(pending).toHaveLength(2);
    const rect = { x: 60, y: 200, width: 280, height: 520 };
    if (order === "later first") {
      await act(async () => pending[1]!(rect));
      expect(menuitems(root).length).toBeGreaterThan(0);
      await act(async () => pending[0]!(rect));
    } else {
      await act(async () => pending[0]!(rect));
      expect(menuitems(root)).toEqual([]);
      await act(async () => pending[1]!(rect));
      expect(menuitems(root).length).toBeGreaterThan(0);
    }
    pick(root, "Copy Link");
    expect(copied).toHaveBeenCalledTimes(1);
    expect(copied).toHaveBeenCalledWith(expect.objectContaining({ id: secondTab.id }));
    expect(copied).not.toHaveBeenCalledWith(expect.objectContaining({ id: firstTab.id }));
    unmount(root);
  });
}

drawnTest("a Tab Options measurement asked before the deck went away opens nothing when it comes back after the deck has returned, and a later one still works", async () => {
  withSpaces([WORK]);
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  const pending: ((rect: { x: number; y: number; width: number; height: number }) => void)[] = [];
  jest.spyOn(overlay, "measureAnchor").mockImplementation(() => new Promise((resolve) => void pending.push(resolve)));
  const hideDeck = () => act(() => browse.useBrowse.setState({ surface: "browsing" }));
  const showDeck = () => act(() => browse.useBrowse.setState({ surface: "deck" }));
  const root = deck();
  const withMenu = () => root.root.findAll((node) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions) && node.props.accessibilityActions.some((action: { name: string }) => action.name === "menu"));
  act(() => withMenu()[1]!.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  const shownCards = withMenu().length;
  hideDeck();
  act(() => jest.advanceTimersByTime(1000));
  showDeck();
  act(() => jest.advanceTimersByTime(1000));
  expect(withMenu().length).toBe(shownCards);
  await act(async () => pending[0]!({ x: 60, y: 200, width: 280, height: 520 }));
  expect(menuitems(root)).toEqual([]);
  act(() => withMenu()[1]!.props.onAccessibilityAction({ nativeEvent: { actionName: "menu" } }));
  await act(async () => pending[pending.length - 1]!({ x: 60, y: 200, width: 280, height: 520 }));
  expect(menuitems(root).length).toBeGreaterThan(0);
  unmount(root);
});
