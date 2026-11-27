import { Dimensions, Keyboard, Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider, FloatingMenu } from "../components/ui";
import * as browse from "../state/browse/store";
import { history } from "../state/history/store";
import { dismissSearch, presentSearch, searchState, setSearchText, typeSearch } from "../state/search/store";
import { useStageBar } from "../state/search/stageBar";
import { useTrayCovers } from "../state/search/trayBack";
import * as syncActions from "../state/sync/actions";
import { OFF_STATUS, useSync, type PinnedTile, type SyncedProfile } from "../state/sync/store";
import { currentTabs, updateTabById, useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import * as focusReturn from "../components/ui/focusReturn";
import * as tabMenus from "../state/browse/tabMenus";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { tilesHeight } from "../components/sync/SpacesParts";

const mockFaceTaken = { then: (taken: () => void) => taken() };
const mockStage = { present: jest.fn(() => mockFaceTaken), holdLift: jest.fn(), releaseLift: jest.fn(), close: jest.fn(), finish: jest.fn() };
const mockSeen: { props: Record<string, unknown> | null } = { props: null };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  const React = jest.requireActual<typeof import("react")>("react");
  const native = jest.requireActual<typeof import("react-native")>("react-native");
  const onIPhone = () => native.Platform.OS === "ios";
  const SearchStage = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => mockStage, []);
    mockSeen.props = props;
    const { onLift, onReveal, onSettled, morphLook, anchorNativeId, faceNativeId, commandTop, fieldCenter, shown, ...rest } = props;
    return React.createElement(native.View, rest);
  });
  const CompletingField = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: () => undefined, blur: () => undefined, setText: () => undefined }), []);
    return React.createElement(native.View, { testID: "completingField", style: props.style, fieldNativeID: props.nativeID } as object);
  });
  return { ...actual, searchStageIsNative: onIPhone, SearchStage, SearchStagePanel: (props: object) => React.createElement(native.View, props), completingFieldIsNative: onIPhone, CompletingField };
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;
let revision = 12000;

const tile = (i: number, folder: PinnedTile["folder"] = null): PinnedTile => ({ key: `k${i}`, title: `Pin ${i}`, url: `https://pin${i}.example/`, icon: null, folder });
const profile = (syncId: string, tiles: PinnedTile[]): SyncedProfile => ({
  syncId,
  name: syncId,
  color: null,
  icon: null,
  isDefault: true,
  theme: null,
  deviceTabs: [],
  pinned: { tiles, sections: [] },
  bookmarks: [],
  history: [],
  sendTargets: null,
});

function withSpace(tiles: PinnedTile[]) {
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
    view: { devices: [], profiles: [profile("work", tiles)], search: null, syncedAt: 1, selectedProfileId: "work", shownProfileId: "work", receivers: [] } as never,
  }));
}

beforeEach(() => {
  jest.useFakeTimers();
  revision += 1;
  jest.spyOn(history(), "summary").mockImplementation(() => Array.from({ length: 6 }, (_unused, index) => ({ url: `https://site${index}.example/`, title: `Site ${index}`, favicon: null, visits: 6 - index, lastVisit: index })));
  jest.spyOn(history(), "revision").mockImplementation(() => revision);
  withTabs(2);
  withSpace([tile(0), tile(1), tile(2, [{ key: "f0", title: "Folder Tab", url: "https://folder.example/", icon: null }])]);
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  Object.values(mockStage).forEach((call) => call.mockClear());
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  useSync.setState((state) => ({ ...state, status: OFF_STATUS }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const pins = (root: Root) => root.root.findAll((node) => node.props.testID === "newTabPins" && typeof node.type === "string")[0];
const tileLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.accessibilityLabel === "string" && /^Pin \d$/.test(node.props.accessibilityLabel) && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const tap = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
const tray = (design: "redesigned" | "material" = "redesigned") => renderSurface(<DesignProvider design={design}><SearchTray /></DesignProvider>);
const editPage = () => act(() => presentSearch("page", "site0.example", null, { currentUrl: "https://site0.example/", currentTabId: currentTabs().open[0]!.id }));

test("+ opens the search panel with the space's pinned tiles above the field, and tapping the address doesn't", () => {
  act(() => browse.newTab());
  const root = tray();
  expect(pins(root)).toBeDefined();
  expect(tileLabels(root)).toEqual(["Pin 0", "Pin 1", "Pin 2"]);
  unmount(root);
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => browse.useBrowse.setState({ surface: "browsing" }));
  editPage();
  const edit = tray();
  expect(pins(edit)).toBeUndefined();
  unmount(edit);
});

test("typing hides the tiles and clearing the field brings them back", () => {
  act(() => browse.newTab());
  const root = tray();
  expect(pins(root)).toBeDefined();
  act(() => setSearchText("pin"));
  act(() => jest.advanceTimersByTime(400));
  expect(pins(root)).toBeUndefined();
  act(() => setSearchText(""));
  act(() => jest.advanceTimersByTime(400));
  expect(pins(root)).toBeDefined();
  unmount(root);
});

test("no tiles in Incognito, with sync off, or when the space has no pins", () => {
  act(() => useTabs.setState({ incognito: true }));
  act(() => browse.newTab());
  const privately = tray();
  expect(pins(privately)).toBeUndefined();
  unmount(privately);
  act(() => dismissSearch());
  act(() => useTabs.setState({ incognito: false }));
  withSpace([]);
  act(() => browse.newTab());
  const bare = tray();
  expect(pins(bare)).toBeUndefined();
  unmount(bare);
  act(() => dismissSearch());
  useSync.setState((state) => ({ ...state, status: OFF_STATUS }));
  withSpace([tile(0)]);
  useSync.setState((state) => ({ ...state, status: { ...state.status, isEnabled: false } }));
  act(() => browse.newTab());
  const off = tray();
  expect(pins(off)).toBeUndefined();
  unmount(off);
});

test("a tile opens through the start page's pinned path, so an open pinned tab is switched to, and counts new_tab_pins_opened", () => {
  const opened = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => browse.newTab());
  const root = tray();
  tap(root, "Pin 1");
  expect(opened).toHaveBeenCalledWith("https://pin1.example/", "Pin 1", "work", "k1");
  expect(counted).toHaveBeenCalledWith("new_tab_pins_opened");
  unmount(root);
});

test("the Material search sheet shows the same tiles above its rows, and none when editing the page", () => {
  act(() => browse.newTab());
  const root = tray("material");
  expect(pins(root)).toBeDefined();
  unmount(root);
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => browse.useBrowse.setState({ surface: "browsing" }));
  editPage();
  const edit = tray("material");
  expect(pins(edit)).toBeUndefined();
  unmount(edit);
});

const menus = (root: Root) => root.root.findAll((node) => node.type === FloatingMenu);

test("a tile's long-press Open keeps its pinned key, so a pinned site opened from its menu is still found again later", () => {
  const opened = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => browse.newTab());
  const root = tray();
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Pin 1" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 120, pageY: 300 } }));
  const items = menus(root)[0]!.props.items as { label: string; onPress: () => void }[];
  act(() => items.find((item) => item.label === "Open")!.onPress());
  expect(opened).toHaveBeenCalledWith("https://pin1.example/", "Pin 1", "work", "k1");
  expect(counted).toHaveBeenCalledWith("new_tab_pins_opened");
  unmount(root);
});

test("a folder menu open when sync takes the pins away is dropped and lets the tray go, and doesn't come back with the pins", () => {
  act(() => useTrayCovers.setState({ covers: 0 }));
  act(() => browse.newTab());
  const root = tray();
  tap(root, "Pin 2");
  expect(menus(root)).toHaveLength(1);
  expect(useTrayCovers.getState().covers).toBe(1);
  act(() => withSpace([]));
  expect(menus(root)).toHaveLength(0);
  expect(useTrayCovers.getState().covers).toBe(0);
  act(() => withSpace([tile(0), tile(1), tile(2, [{ key: "f0", title: "Folder Tab", url: "https://folder.example/", icon: null }])]));
  expect(pins(root)).toBeDefined();
  expect(menus(root)).toHaveLength(0);
  expect(useTrayCovers.getState().covers).toBe(0);
  unmount(root);
});

const pressOf = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress as () => void;
const FOLDER = [{ key: "f0", title: "Folder Tab", url: "https://folder.example/", icon: null }];

test("a pin menu belongs to its panel, space and pin: a space change or the panel closing drops it and lets the tray go", () => {
  act(() => useTrayCovers.setState({ covers: 0 }));
  act(() => browse.newTab());
  const root = tray();
  tap(root, "Pin 2");
  expect(menus(root)).toHaveLength(1);
  act(() =>
    useSync.setState((state) => ({
      ...state,
      view: { ...(state.view as object), profiles: [...state.view.profiles, profile("home", [tile(0), tile(1), tile(2, FOLDER)])], selectedProfileId: "home", shownProfileId: "home" } as never,
    })),
  );
  expect(menus(root)).toHaveLength(0);
  expect(useTrayCovers.getState().covers).toBe(0);
  act(() => withSpace([tile(0), tile(1), tile(2, FOLDER)]));
  tap(root, "Pin 2");
  expect(useTrayCovers.getState().covers).toBe(1);
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  expect(menus(root)).toHaveLength(0);
  expect(useTrayCovers.getState().covers).toBe(0);
  unmount(root);
});

test("once the tiles stop being offered they leave at once, and a tap or menu choice still in flight opens nothing", () => {
  const opened = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => browse.newTab());
  const root = tray();
  const staleTap = pressOf(root, "Pin 1");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Pin 0" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 300 } }));
  const staleOpen = (menus(root)[0]!.props.items as { label: string; onPress: () => void }[]).find((item) => item.label === "Open")!.onPress;
  act(() => setSearchText("p"));
  expect(pins(root)).toBeUndefined();
  act(() => staleTap());
  act(() => staleOpen());
  act(() => setSearchText(""));
  act(() => useTabs.setState({ incognito: true }));
  expect(pins(root)).toBeUndefined();
  act(() => staleTap());
  expect(opened).not.toHaveBeenCalled();
  expect(counted).not.toHaveBeenCalledWith("new_tab_pins_opened");
  unmount(root);
});

test("with the keyboard up, the folder and long-press menus are bounded by its top, so every row can scroll into view", () => {
  jest.spyOn(Keyboard, "metrics").mockReturnValue({ height: 336, screenX: 0, screenY: Dimensions.get("window").height - 336, width: 393 } as never);
  act(() => browse.newTab());
  const root = tray();
  tap(root, "Pin 2");
  const floor = menus(root)[0]!.props.floor as number;
  expect(floor).toBeGreaterThan(0);
  expect(floor).toBeLessThanOrEqual(Dimensions.get("window").height - 336);
  act(() => menus(root)[0]!.props.onDismiss());
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Pin 0" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 300 } }));
  expect(menus(root)[0]!.props.floor).toBe(floor);
  unmount(root);
});

test("a pin opened from its menu keeps its key, so after its page moves on the tile switches back to that tab instead of opening a second one", () => {
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => browse.newTab());
  const first = tray();
  act(() => first.root.findAll((node) => node.props.accessibilityLabel === "Pin 1" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 300 } }));
  act(() => (menus(first)[0]!.props.items as { label: string; onPress: () => void }[]).find((item) => item.label === "Open")!.onPress());
  unmount(first);
  act(() => jest.runOnlyPendingTimers());
  const pinned = currentTabs().open.filter((tab) => tab.pinnedKey === "k1");
  expect(pinned).toHaveLength(1);
  act(() => updateTabById(pinned[0]!.id, { url: "https://pin1.example/elsewhere" }));
  const before = currentTabs().open.length;
  act(() => browse.newTab());
  const second = tray();
  tap(second, "Pin 1");
  expect(currentTabs().open.length).toBe(before);
  expect(currentTabs().selectedId).toBe(pinned[0]!.id);
  expect(counted).toHaveBeenCalledWith("pinned_tabs_refound");
  unmount(second);
});

test("a tap held from an earlier panel opens nothing in the next one, even with the same space and pin", () => {
  const opened = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  act(() => browse.newTab());
  const root = tray();
  const staleTap = pressOf(root, "Pin 1");
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => browse.newTab());
  act(() => staleTap());
  expect(opened).not.toHaveBeenCalled();
  act(() => pressOf(root, "Pin 1")());
  expect(opened).toHaveBeenCalledWith("https://pin1.example/", "Pin 1", "work", "k1");
  unmount(root);
});

const itemsOf = (root: Root) => menus(root)[0]!.props.items as { label: string; onPress: () => void }[];
const longPress = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 300 } }));
const pinsWith = (changes: (tiles: PinnedTile[]) => PinnedTile[]) => act(() => withSpace(changes([tile(0), tile(1), tile(2, FOLDER)])));

onIPhone("on iPhone a folder menu measures its tile where the stage has lifted it, not where its layout left it", () => {
  act(() => browse.newTab());
  const root = tray();
  act(() => (mockSeen.props!.onLift as (lift: { lift: number; up: boolean }) => void)({ lift: 336, up: true }));
  tap(root, "Pin 2");
  expect(menus(root)[0]!.props.anchorShift).toBe(-336);
  unmount(root);
});

test("a pin menu reads the pin as it is now: a changed address opens the new one, and a folder row the Mac removed is gone from the open menu", () => {
  const opened = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  act(() => browse.newTab());
  const root = tray();
  longPress(root, "Pin 1");
  pinsWith((tiles) => tiles.map((pin) => (pin.key === "k1" ? { ...pin, url: "https://moved.example/", title: "Moved" } : pin)));
  act(() => itemsOf(root).find((item) => item.label === "Open")!.onPress());
  expect(opened).toHaveBeenCalledWith("https://moved.example/", "Moved", "work", "k1");
  opened.mockClear();
  act(() => menus(root)[0]?.props.onDismiss(true));
  const twoRows = [{ key: "f0", title: "Folder Tab", url: "https://folder.example/", icon: null }, { key: "f1", title: "Second Tab", url: "https://second.example/", icon: null }];
  pinsWith((tiles) => tiles.map((pin) => (pin.key === "k2" ? { ...pin, folder: twoRows } : pin)));
  tap(root, "Pin 2");
  expect(itemsOf(root).map((item) => item.label)).toEqual(["Folder Tab", "Second Tab"]);
  const staleRow = itemsOf(root)[1]!.onPress;
  pinsWith((tiles) => tiles.map((pin) => (pin.key === "k2" ? { ...pin, folder: [twoRows[0]!] } : pin)));
  expect(itemsOf(root).map((item) => item.label)).toEqual(["Folder Tab"]);
  act(() => staleRow());
  expect(opened).not.toHaveBeenCalled();
  unmount(root);
});

test("a pin tapped after typing has started but before the field's text has landed opens nothing", () => {
  const opened = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  act(() => browse.newTab());
  const root = tray();
  const press = pressOf(root, "Pin 1");
  typeSearch("a");
  press();
  expect(opened).not.toHaveBeenCalled();
  unmount(root);
});

test("a pin opens with the submitted exit, like a row, and a pin menu closed without a choice hands focus back to its tile", () => {
  const handBack = jest.fn(() => () => undefined);
  jest.spyOn(focusReturn, "useFocusReturn").mockReturnValue(handBack);
  act(() => browse.newTab());
  const root = tray();
  tap(root, "Pin 2");
  act(() => menus(root)[0]!.props.onDismiss());
  expect(handBack).toHaveBeenCalledTimes(1);
  const target = (handBack.mock.calls[0] as unknown as [() => unknown])[0];
  expect(target()).toBeTruthy();
  tap(root, "Pin 2");
  act(() => menus(root)[0]!.props.onDismiss(true));
  expect(handBack).toHaveBeenCalledTimes(1);
  tap(root, "Pin 1");
  expect(searchState().open).toBe(false);
  expect(searchState().ending).toBe("submitted");
  unmount(root);
});

test("a pin menu's Copy Link and Share read the pin when chosen: a moved pin copies its new address, a removed one shares nothing", () => {
  const copied = jest.spyOn(tabMenus, "copyLink").mockImplementation((() => undefined) as never);
  const shared = jest.spyOn(tabMenus, "shareUrl").mockImplementation((() => undefined) as never);
  act(() => browse.newTab());
  const root = tray();
  longPress(root, "Pin 1");
  const copy = itemsOf(root).find((item) => item.label === "Copy Link")!.onPress;
  const share = itemsOf(root).find((item) => item.label === "Share")!.onPress;
  pinsWith((tiles) => tiles.map((pin) => (pin.key === "k1" ? { ...pin, url: "https://moved.example/" } : pin)));
  act(() => copy());
  expect(copied).toHaveBeenCalledWith("https://moved.example/");
  pinsWith((tiles) => tiles.filter((pin) => pin.key !== "k1"));
  act(() => share());
  expect(shared).not.toHaveBeenCalled();
  unmount(root);
});

test("a pin whose address Ardia can't open, such as chrome://, opens nothing, counts nothing and leaves search open", () => {
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => withSpace([tile(0), { key: "kc", title: "Flags", url: "chrome://flags", icon: null, folder: null }]));
  act(() => browse.newTab());
  const root = tray();
  const tabs = currentTabs().open.length;
  tap(root, "Flags");
  expect(counted).not.toHaveBeenCalledWith("new_tab_pins_opened");
  expect(searchState().open).toBe(true);
  expect(searchState().ending).not.toBe("submitted");
  expect(currentTabs().open.length).toBe(tabs);
  unmount(root);
});

test("Copy Link and Share kept from a panel do nothing once Incognito is on or a newer panel has opened, as Open does", () => {
  const copied = jest.spyOn(tabMenus, "copyLink").mockImplementation((() => undefined) as never);
  const shared = jest.spyOn(tabMenus, "shareUrl").mockImplementation((() => undefined) as never);
  act(() => browse.newTab());
  const root = tray();
  longPress(root, "Pin 1");
  const copy = itemsOf(root).find((item) => item.label === "Copy Link")!.onPress;
  const share = itemsOf(root).find((item) => item.label === "Share")!.onPress;
  act(() => useTabs.setState({ incognito: true }));
  act(() => copy());
  act(() => share());
  act(() => useTabs.setState({ incognito: false }));
  act(() => presentSearch("start", ""));
  act(() => copy());
  act(() => share());
  expect(copied).not.toHaveBeenCalled();
  expect(shared).not.toHaveBeenCalled();
  unmount(root);
});

test("a newer search session over the same open panel remounts the tiles, so a press held from the old one can't finish on the new one's handler", () => {
  act(() => browse.newTab());
  const root = tray();
  const before = root.root.findAll((node) => node.props.accessibilityLabel === "Pin 1" && typeof node.props.onPress === "function")[0]!;
  act(() => presentSearch("start", ""));
  expect(pins(root)).toBeDefined();
  const after = root.root.findAll((node) => node.props.accessibilityLabel === "Pin 1" && typeof node.props.onPress === "function")[0]!;
  expect(after).not.toBe(before);
  unmount(root);
});

const surfaceOf = (root: Root) => {
  const hosts = root.root.findAll((node) => typeof node.type === "string" && (node.props.testID === "traySurface" || node.props.testID === "trayPanel"));
  return hosts.find((node) => node.props.testID === "traySurface") ?? hosts.find((node) => StyleSheet.flatten(node.props.style)?.height !== undefined)!;
};
const insideSurface = (root: Root) => {
  let parent = pins(root)!.parent;
  while (parent && parent !== surfaceOf(root)) parent = parent.parent;
  return parent === surfaceOf(root);
};
const heightOf = (root: Root) => StyleSheet.flatten(surfaceOf(root).props.style).height as number;

test("the tiles sit inside the search panel, above its field, on the panel's own surface with no card of their own, and the panel grows by their height", () => {
  act(() => browse.newTab());
  const root = tray();
  expect(pins(root)).toBeDefined();
  expect(insideSurface(root)).toBe(true);
  expect(root.root.findAll((node) => node.props.testID === "newTabPinsPlate")).toHaveLength(0);
  const order = root.root.findAll((node) => typeof node.type === "string" && (node.props.testID === "newTabPins" || node.props.testID === "trayFieldCapsule")).map((node) => node.props.testID);
  expect(order).toEqual(["newTabPins", "trayFieldCapsule"]);
  const withPins = heightOf(root);
  act(() => setSearchText("pin"));
  act(() => jest.advanceTimersByTime(400));
  expect(pins(root)).toBeUndefined();
  expect(heightOf(root)).toBeLessThan(withPins);
  unmount(root);
});

onIPhone("on iPhone the stage is told the field sits below the tiles, so the morph and the pill line up with the field, not the panel's top", () => {
  act(() => browse.newTab());
  const root = tray();
  const block = StyleSheet.flatten(pins(root)!.props.style).height as number;
  expect(block).toBeGreaterThan(0);
  expect(mockSeen.props!.fieldTop).toBeCloseTo(16 + block, 3);
  act(() => setSearchText("pin"));
  act(() => jest.advanceTimersByTime(400));
  expect(mockSeen.props!.fieldTop).toBe(16);
  unmount(root);
});

test("many pins with the keyboard up stay within the room above it: the tile block is capped and scrolls, and the field and rows keep their place", () => {
  jest.spyOn(Keyboard, "metrics").mockReturnValue({ height: 400, screenX: 0, screenY: Dimensions.get("window").height - 400, width: 393 } as never);
  act(() => withSpace(Array.from({ length: 24 }, (_, i) => tile(i))));
  act(() => browse.newTab());
  const root = tray();
  const block = StyleSheet.flatten(pins(root)!.props.style).height as number;
  expect(block).toBeGreaterThan(0);
  expect(block).toBeLessThan(tilesHeight(24, Dimensions.get("window").width, Dimensions.get("window").fontScale));
  const scroll = root.root.findAll((node) => node.props.testID === "newTabPinsScroll" && node.props.scrollEnabled !== undefined)[0]!;
  expect(scroll.props.scrollEnabled).toBe(true);
  unmount(root);
});
