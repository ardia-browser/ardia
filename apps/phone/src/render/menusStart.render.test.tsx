import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { idOf, mockNative, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { StartScreen } = require("../components/search/StartScreen") as typeof import("../components/search/StartScreen");
const { DesignProvider } = require("../components/ui") as typeof import("../components/ui");
const { haptics } = require("../state/app/haptics") as typeof import("../state/app/haptics");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const tabMenus = require("../state/browse/tabMenus") as typeof import("../state/browse/tabMenus");
const syncActions = require("../state/sync/actions") as typeof import("../state/sync/actions");
const { dismissSearch } = require("../state/search/store") as typeof import("../state/search/store");
const { OFF_STATUS, useSync } = require("../state/sync/store") as typeof import("../state/sync/store");
const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
const tabHooks = require("../state/tabs/hooks") as typeof import("../state/tabs/hooks");

type Root = ReturnType<typeof renderSurface>;
type SyncedProfile = import("../state/sync/store").SyncedProfile;
type PinnedTile = import("../state/sync/store").PinnedTile;

const tile = (i: number, folder: PinnedTile["folder"] = null, url = `https://pin${i}.example/`): PinnedTile => ({ key: `k${i}`, title: `Pin ${i}`, url, icon: null, folder });
const profile = (syncId: string, name: string, tiles: PinnedTile[] = [], icon: string | null = null): SyncedProfile => ({
  syncId,
  name,
  color: null,
  icon,
  isDefault: syncId === "work",
  theme: null,
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

beforeEach(() => {
  jest.useFakeTimers();
  resetNativeMenus(true);
  withTabs(2);
  act(() => {
    browse.useBrowse.setState({ surface: "start", sheet: null });
    useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } }));
  });
  jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  resetNativeMenus();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const start = () =>
  renderSurface(
    <DesignProvider design="redesigned">
      <StartScreen />
    </DesignProvider>,
  );

const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const menuAround = (root: Root, label: string) => contextMenus(root).find((menu) => menu.findAll((node) => node.props.accessibilityLabel === label).length > 0);
const items = (menu: ReactTestInstance): NativeItem[] => menu.props.items;
const choose = (menu: ReactTestInstance, title: string) => act(() => menu.props.onSelect(idOf(menu.props.items, title)));

test("the start page's plus keeps its tap, and its long press is the system menu of main's PlusButton, a regular tab first while private", () => {
  jest.spyOn(tabHooks, "useCanReopen").mockReturnValue(true);
  const opened = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const regular = jest.spyOn(browse, "newRegularTab").mockImplementation(() => undefined);
  const root = start();
  const plus = menuAround(root, "New Tab")!;
  expect(plus.props.trigger).toBe("longPress");
  expect(titles(items(plus))).toEqual(["New Incognito Tab", "Reopen Closed Tab"]);
  act(() => plus.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(opened).toHaveBeenCalledTimes(1);
  unmount(root);
  act(() => browse.useBrowse.setState({ surface: "start" }));
  const { useTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
  act(() => useTabs.setState({ incognito: true }));
  const privately = start();
  const privatePlus = menuAround(privately, "New Incognito Tab")!;
  expect(titles(items(privatePlus))).toEqual(["New Tab", "New Incognito Tab", "Reopen Closed Tab"]);
  choose(privatePlus, "New Tab");
  expect(regular).toHaveBeenCalledTimes(1);
  unmount(privately);
});

test("the space switcher is a tap menu of the spaces in fixed order, checked and with main's symbols, and picking one switches", () => {
  withSpaces([profile("work", "Work", [], "briefcase"), profile("home", "Home")]);
  const select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
  const root = start();
  const switcher = menuAround(root, "Space, Work")!;
  expect(switcher.props.trigger).toBe("tap");
  expect(switcher.props.fixedOrder).toBe(true);
  expect(items(switcher)).toEqual([
    { id: "0", title: "Work", systemImage: "briefcase", checked: true },
    { id: "1", title: "Home", systemImage: "h.circle.fill" },
  ]);
  choose(switcher, "Home");
  expect(select).toHaveBeenCalledWith("home");
  unmount(root);
});

test("a folder tile's tap opens a menu of its tabs, a link tile's long press offers Copy Link and Share, and a tile that isn't a web link has none", () => {
  withSpaces([profile("work", "Work", [tile(0), tile(1, [{ key: "f0", title: "Inside", url: "https://inside.example/", icon: null }]), tile(2, null, "file:///notes.txt")])]);
  const open = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  const copied = jest.spyOn(tabMenus, "copyLink").mockImplementation(() => undefined);
  const shared = jest.spyOn(tabMenus, "shareUrl").mockImplementation(() => undefined);
  const root = start();
  const link = menuAround(root, "Pin 0")!;
  expect(link.props.trigger).toBe("longPress");
  expect(titles(items(link))).toEqual(["Copy Link", "Share"]);
  choose(link, "Copy Link");
  choose(link, "Share");
  expect(copied).toHaveBeenCalledWith("https://pin0.example/");
  expect(shared).toHaveBeenCalledWith("https://pin0.example/", "Pin 0");
  const folder = menuAround(root, "Pin 1")!;
  expect(folder.props.trigger).toBe("tap");
  expect(titles(items(folder))).toEqual(["Inside"]);
  choose(folder, "Inside");
  expect(open).toHaveBeenCalledWith("https://inside.example/", "Inside", "work", "f0");
  expect(menuAround(root, "Pin 2")).toBeUndefined();
  expect(mockNative.sheets).toHaveLength(0);
  unmount(root);
});
