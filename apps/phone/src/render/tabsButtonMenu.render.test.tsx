import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { idOf, resetNativeMenus, titles, type NativeItem } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { BottomBar } = require("../components/browsing/BottomBar") as typeof import("../components/browsing/BottomBar");
const { FloatingBar } = require("../components/browsing/FloatingBar") as typeof import("../components/browsing/FloatingBar");
const { tabsMenuItems } = require("../components/browsing/tabsMenu") as typeof import("../components/browsing/tabsMenu");
const { FloatingMenu, rolesFor } = require("../components/ui") as typeof import("../components/ui");
type MenuItem = import("../components/ui").MenuItem;
const tabMenus = require("../state/browse/tabMenus") as typeof import("../state/browse/tabMenus");
const { currentTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
const { deckOrder } = require("../state/tabs/tabsState") as typeof import("../state/tabs/tabsState");

type Root = ReturnType<typeof renderSurface>;

const onIos = Platform.OS === "ios" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  resetNativeMenus();
  withTabs(4);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const order = () => deckOrder(currentTabs());
const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const tabsButton = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onAccessibilityAction === "function")[0]!;

function floatingBar(calls: string[]) {
  const tabs = order();
  return renderSurface(
    <FloatingBar tab={tabs[tabs.length - 1]!} order={tabs} roles={rolesFor(false)} dark={false} showsPlus onTabs={() => calls.push("tabs")} onTabsMenu={() => calls.push("menu")} onStep={() => undefined} onAddress={() => undefined} onPlus={() => undefined} onMore={() => undefined} />,
  );
}

test("the tabs menu is main's: the other tabs newest first, a divider, then Close Tab with its xmark, destructive", () => {
  const tabs = order();
  const items = tabsMenuItems(tabs);
  const others = tabs.slice(0, -1).reverse();
  expect(items.map((item) => (item === "divider" ? "divider" : "label" in item ? item.label : item.heading))).toEqual([...others.map((tab) => tab.title), "divider", "Close Tab"]);
  expect(items[items.length - 1]).toEqual(expect.objectContaining({ systemImage: "xmark", destructive: true }));
  expect(tabsMenuItems(tabs.slice(-1)).map((item) => (item === "divider" ? "divider" : "label" in item ? item.label : ""))).toEqual(["Close Tab"]);
});

onIos("with the system's menus, the floating bar's tabs button is a long-press UIKit menu with main's items, choosing a tab opens it, and VoiceOver keeps Recent Tabs through the drawn menu", () => {
  resetNativeMenus(true);
  const switched = jest.spyOn(tabMenus, "switchToTab").mockImplementation(() => undefined);
  const closed = jest.spyOn(tabMenus, "closeFrontTab").mockImplementation(() => undefined);
  const calls: string[] = [];
  const root = floatingBar(calls);
  const menu = contextMenus(root).find((node) => node.props.testID === "tabsButtonMenu")!;
  expect(menu.props.trigger).toBe("longPress");
  const tabs = order();
  const others = tabs.slice(0, -1).reverse();
  expect(titles(menu.props.items as NativeItem[])).toEqual([...others.map((tab) => tab.title), { "": ["Close Tab"] }]);
  act(() => menu.props.onSelect(idOf(menu.props.items, others[1]!.title)));
  expect(switched).toHaveBeenCalledWith(others[1]!.id);
  act(() => menu.props.onSelect(idOf(menu.props.items, "Close Tab")));
  expect(closed).toHaveBeenCalledTimes(1);
  expect(tabsButton(root).props.onLongPress).toBeUndefined();
  expect(tabsButton(root).props.accessibilityActions).toEqual([{ name: "Recent Tabs" }, { name: "Previous Tab" }, { name: "Next Tab" }]);
  act(() => tabsButton(root).props.onAccessibilityTap());
  act(() => tabsButton(root).props.onAccessibilityAction({ nativeEvent: { actionName: "Recent Tabs" } }));
  expect(calls).toEqual(["tabs", "menu"]);
  unmount(root);
});

onIos("the classic bar's tabs button gets the same native menu", () => {
  resetNativeMenus(true);
  const root = renderSurface(<BottomBar order={order()} roles={rolesFor(false)} showsPlus onTabs={() => undefined} onTabsMenu={() => undefined} onStep={() => undefined} onPlus={() => undefined} onMore={() => undefined} />);
  expect(contextMenus(root).filter((node) => node.props.testID === "tabsButtonMenu")).toHaveLength(1);
  unmount(root);
});

test("without the system's menus, as on Android, the tabs button's long press opens the drawn menu of the same items at the finger, dimmed", () => {
  const calls: string[] = [];
  const root = floatingBar(calls);
  expect(contextMenus(root)).toHaveLength(0);
  const button: ReactTestInstance = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onLongPress === "function")[0]!;
  act(() => button.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 800 } }));
  const menu = root.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(menu.props.at).toEqual({ x: 40, y: 800 });
  expect(menu.props.dimmed).toBe(true);
  const labels = (items: MenuItem[]) => items.map((item) => (item === "divider" ? item : "label" in item ? item.label : item.heading));
  expect(labels(menu.props.items)).toEqual(labels(tabsMenuItems(order())));
  expect(calls).toEqual([]);
  unmount(root);
});
