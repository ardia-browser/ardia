import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, someTabs, unmount } from "../../test/render/harness";
import { idOf, itemOf, mockNative, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { TabDeck } = require("../components/tabs/TabDeck") as typeof import("../components/tabs/TabDeck");
const { DesignProvider } = require("../components/ui") as typeof import("../components/ui");
const { haptics } = require("../state/app/haptics") as typeof import("../state/app/haptics");
const { useArchiveCard } = require("../state/browse/archiveCard") as typeof import("../state/browse/archiveCard");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const settingsActions = require("../state/settings/actions") as typeof import("../state/settings/actions");
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

const deck = () =>
  renderSurface(
    <DesignProvider design="redesigned">
      <TabDeck />
    </DesignProvider>,
  );

const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const menuAround = (root: Root, label: string) => contextMenus(root).find((menu) => menu.findAll((node) => node.props.accessibilityLabel === label).length > 0)!;
const cardMenus = (root: Root) => contextMenus(root).filter((menu) => menu.props.testID === "deckCardMenu");
const items = (menu: ReactTestInstance): NativeItem[] => menu.props.items;
const choose = (menu: ReactTestInstance, title: string) => act(() => menu.props.onSelect(idOf(menu.props.items, title)));

test("each deck card is a system context menu on a long press with main's CardMenu, and our own long-press gesture steps aside", () => {
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

test("a card menu's items do what they say: Send, Pin, Move to Space and Close Tab", () => {
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

test("a pinned tab reads Pinned to Mac, disabled, and a tab that can't be shared offers only Close Tab", () => {
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

test("the ··· menu is main's DeckMoreMenu on a tap, in fixed order, and Close All asks with the system's action sheet", async () => {
  withSpaces([WORK]);
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const settings = jest.spyOn(settingsNav, "openSettings").mockImplementation(() => undefined);
  const closeAll = jest.spyOn(browse, "closeAllFromDeck").mockImplementation(() => undefined);
  const root = deck();
  const more = menuAround(root, "More");
  expect(more.props.trigger).toBe("tap");
  expect(more.props.fixedOrder).toBe(true);
  expect(titles(items(more))).toEqual(["Archive", "Spaces From Your Mac", { "": ["New Incognito Tab", "Reopen Closed Tab", "Close All Tabs"] }, { "": ["Settings"] }]);
  expect(itemOf(items(more), "Close All Tabs")!.destructive).toBe(true);
  choose(more, "Archive");
  expect(browse.useBrowse.getState().sheet).toBe("archive");
  act(() => browse.useBrowse.setState({ sheet: null }));
  choose(more, "Settings");
  expect(settings).toHaveBeenCalledTimes(1);
  mockNative.answer = "confirm";
  choose(more, "Close All Tabs");
  await act(async () => undefined);
  expect(mockNative.sheets[0]).toMatchObject({ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", actions: [{ id: "confirm", title: "Close All Tabs", destructive: true }, { cancel: true }] });
  expect(closeAll).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("the space switcher lists the spaces with a check on the current one and their symbols, and picking one switches", () => {
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

test("the deck header shows a space's name alone when it has no icon of its own, with no initial in a circle, and the space's icon beside its name when it has one", () => {
  withSpaces([HOME, WORK]);
  const plain = deck();
  const title = menuAround(plain, "Space, Home");
  expect(title.findAll((node) => node.props.testID === "startSpaceGlyph")).toHaveLength(0);
  expect(title.findAll((node) => node.props.testID === "deckSpaceTitle" && typeof node.type === "string")).toHaveLength(1);
  const words = title.findAll((node) => typeof node.type === "string" && node.type === "Text").map((node) => node.children.join(""));
  expect(words).toEqual(["Home"]);
  unmount(plain);
  withSpaces([profile("garden", "Garden", "🌱"), HOME]);
  const marked = deck();
  expect(menuAround(marked, "Space, Garden").findAll((node) => node.props.testID === "startSpaceGlyph" && typeof node.type === "string")).toHaveLength(1);
  unmount(marked);
});

test("the Incognito pill's menu is Close Incognito Tabs, which asks with an action sheet first", async () => {
  act(() => tabStore.useTabs.setState((state) => ({ ...state, privates: someTabs(2, true) })));
  const leave = jest.spyOn(browse, "leaveIncognito").mockImplementation(() => undefined);
  const root = deck();
  const pill = menuAround(root, "Incognito, 2 tabs");
  expect(pill.props.trigger).toBe("tap");
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

test("the plus keeps its tap and its long press is main's PlusButton menu", () => {
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

test("the Archive capsule's interval is a tap menu of main's intervals with the current one checked", () => {
  const set = jest.spyOn(settingsActions, "setArchiveInterval").mockImplementation(() => undefined);
  act(() => useArchiveCard.setState({ showing: true }));
  const root = deck();
  const picker = contextMenus(root).find((menu) => menu.findAll((node) => typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.startsWith("Archive inactive tabs,")).length > 0)!;
  expect(picker.props.trigger).toBe("tap");
  const checked = items(picker).filter((item) => item.checked);
  expect(checked).toHaveLength(1);
  const other = items(picker).find((item) => !item.checked)!;
  act(() => picker.props.onSelect(other.id));
  expect(set).toHaveBeenCalledTimes(1);
  unmount(root);
});
