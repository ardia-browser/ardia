import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { idOf, itemOf, mockNative, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { ArchiveView } = require("../components/tabs/ArchiveView") as typeof import("../components/tabs/ArchiveView");
const { PickerRow } = require("../components/settings/SettingsKit") as typeof import("../components/settings/SettingsKit");
const { ConfirmDialog, FloatingMenu } = require("../components/ui") as typeof import("../components/ui");
type MenuItem = import("../components/ui").MenuItem;
const tabStore = require("../state/tabs/store") as typeof import("../state/tabs/store");

type Root = ReturnType<typeof renderSurface>;

beforeEach(() => {
  jest.useFakeTimers();
  resetNativeMenus();
  withTabs(2);
  jest.spyOn(tabStore, "loadArchive").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  resetNativeMenus();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const items = (menu: ReactTestInstance): NativeItem[] => menu.props.items;
const pressOptions = (root: Root) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Options" && typeof node.props.onPress === "function")[0]!.props.onPress());
const drawnMenu = (root: Root): MenuItem[] => root.root.findAll((node) => node.type === FloatingMenu)[0]!.props.items;

test("the Archive's Options menu is main's: an Archive Inactive Tabs submenu of the intervals, then Delete All…, off while the Archive is empty", () => {
  resetNativeMenus(true);
  const root = renderSurface(<ArchiveView />);
  const options = contextMenus(root).find((menu) => menu.findAll((node) => node.props.accessibilityLabel === "Options").length > 0)!;
  expect(options.props.trigger).toBe("tap");
  const shown = titles(items(options));
  expect(shown).toHaveLength(2);
  expect(Object.keys(shown[0] as object)).toEqual(["Archive Inactive Tabs"]);
  expect(itemOf(items(options), "Archive Inactive Tabs")!.systemImage).toBe("archivebox");
  expect(itemOf(items(options), "Delete All…")).toMatchObject({ systemImage: "trash", destructive: true, disabled: true });
  const set = jest.spyOn(tabStore, "setAutoArchiveInterval").mockImplementation(() => undefined);
  const first = itemOf(items(options), "Archive Inactive Tabs")!.children![0]!;
  act(() => options.props.onSelect(first.id));
  expect(set).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("without the system's menus the Options menu is the drawn one with the same items, and Delete All… asks in the drawn dialog", () => {
  act(() => tabStore.useTabs.setState((state) => ({ ...state, archivedCount: 2 })));
  const root = renderSurface(<ArchiveView />);
  expect(contextMenus(root)).toHaveLength(0);
  pressOptions(root);
  const drawn = drawnMenu(root);
  expect(drawn.map((item) => (item === "divider" ? item : "label" in item ? item.label : item.heading))).toEqual(["Archive Inactive Tabs", "divider", "Delete All…"]);
  const submenu = drawn[0] as { children: MenuItem[] };
  expect(submenu.children.every((item) => typeof item === "object" && "label" in item)).toBe(true);
  const clear = jest.spyOn(tabStore, "clearArchivedTabs").mockImplementation(() => undefined);
  act(() => (drawn[2] as { onPress: () => void }).onPress());
  const dialog = root.root.findAll((node) => node.type === ConfirmDialog)[0]!;
  expect(dialog.props.confirmation).toMatchObject({ title: "Delete All Archived Tabs?", action: "Delete All" });
  act(() => dialog.props.confirmation.run());
  expect(clear).toHaveBeenCalledTimes(1);
  expect(mockNative.sheets).toHaveLength(0);
  unmount(root);
});

test("a settings picker row is a tap menu of its options with the chosen one checked, drawn or native", () => {
  const chosen: string[] = [];
  const row = () => <PickerRow title="Time Range" options={[{ id: "hour", title: "Last Hour" }, { id: "all", title: "All Time" }]} selected="hour" onSelect={(id) => chosen.push(id)} />;
  const drawn = renderSurface(row());
  act(() => drawn.root.findAll((node) => node.props.accessibilityLabel === "Time Range" && typeof node.props.onPress === "function")[0]!.props.onPress());
  const options = drawnMenu(drawn) as { label: string; checked?: boolean; onPress: () => void }[];
  expect(options.map((item) => [item.label, Boolean(item.checked)])).toEqual([
    ["Last Hour", true],
    ["All Time", false],
  ]);
  act(() => options[1]!.onPress());
  unmount(drawn);
  resetNativeMenus(true);
  const native = renderSurface(row());
  const menu = contextMenus(native)[0]!;
  expect(menu.props.trigger).toBe("tap");
  expect(items(menu)).toEqual([
    { id: "0", title: "Last Hour", checked: true },
    { id: "1", title: "All Time" },
  ]);
  act(() => menu.props.onSelect(idOf(items(menu), "Last Hour")));
  expect(chosen).toEqual(["all", "hour"]);
  unmount(native);
});
