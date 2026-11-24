import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { idOf, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { StartScreen } = require("../components/search/StartScreen") as typeof import("../components/search/StartScreen");
const { DesignProvider, FloatingMenu } = require("../components/ui") as typeof import("../components/ui");
const { haptics } = require("../state/app/haptics") as typeof import("../state/app/haptics");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
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


const nativeTest = Platform.OS === "ios" ? test : test.skip;

nativeTest("the start page's plus keeps its tap, and its long press is the system menu of main's PlusButton, a regular tab first while private", () => {
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

test("the start page has only the plus's menu: no space name, no pinned tiles and no menus of them, with one space or several", () => {
  withSpaces([profile("work", "Work", [tile(0), tile(1, [{ key: "f0", title: "Inside", url: "https://inside.example/", icon: null }])], "briefcase"), profile("home", "Home")]);
  const root = start();
  expect(root.root.findAll((node) => node.props.accessibilityRole === "header" && node.props.accessibilityLabel === "Work")).toHaveLength(0);
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Pin 0" || node.props.accessibilityLabel === "Pin 1")).toHaveLength(0);
  expect(root.root.findAll((node) => node.props.testID === "startSpaceGlyph")).toHaveLength(0);
  expect(contextMenus(root).filter((menu) => !menu.findAll((node) => node.props.accessibilityLabel === "New Tab").length)).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === FloatingMenu)).toHaveLength(0);
  unmount(root);
});
