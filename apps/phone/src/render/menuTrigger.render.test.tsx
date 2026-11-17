import { Platform, Pressable, Text } from "react-native";
import { act } from "react-test-renderer";
import { renderSurface, unmount } from "../../test/render/harness";
import { mockNative, resetNativeMenus } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { MenuTrigger, confirmInSheet, nativeMenu } = require("../components/ui/MenuTrigger") as typeof import("../components/ui/MenuTrigger");
type MenuItem = import("../components/ui").MenuItem;

type Root = ReturnType<typeof renderSurface>;

const ran: string[] = [];
const run = (name: string) => () => void ran.push(name);

const ITEMS: MenuItem[] = [
  { label: "Copy Link", icon: "link", onPress: run("copy") },
  { label: "Send to Device", children: [{ label: "Studio", icon: "laptop", systemImage: "desktopcomputer", onPress: run("studio") }, { label: "Pixel", icon: "iphone", onPress: run("pixel") }] },
  "divider",
  { heading: "Theme" },
  { label: "Light", checked: true, onPress: run("light") },
  { label: "Dark", disabled: true, onPress: run("dark") },
  "divider",
  { label: "Close Tab", destructive: true, onPress: run("close") },
];

const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const menuLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const pickMenu = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());

function trigger(trigger: "tap" | "longPress") {
  return renderSurface(
    <MenuTrigger items={ITEMS} trigger={trigger} fixedOrder place={{ top: 100, left: 20, width: 250 }}>
      {({ onPress, onLongPress }) => (
        <Pressable accessibilityLabel="Trigger" onPress={onPress ?? (() => undefined)} onLongPress={onLongPress}>
          <Text>Trigger</Text>
        </Pressable>
      )}
    </MenuTrigger>,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  ran.length = 0;
  resetNativeMenus();
});

afterEach(() => {
  jest.useRealTimers();
});

test("menu items become UIKit's: dividers split inline groups, a heading titles its group, submenus nest, icons become SF Symbols and flags carry over", () => {
  const { items, actions } = nativeMenu(ITEMS);
  expect(items).toEqual([
    { id: "0", title: "Copy Link", systemImage: "link" },
    {
      id: "1",
      title: "Send to Device",
      children: [
        { id: "1.0", title: "Studio", systemImage: "desktopcomputer" },
        { id: "1.1", title: "Pixel", systemImage: "iphone" },
      ],
    },
    { id: "g1", title: "Theme", inline: true, children: [{ id: "4", title: "Light", checked: true }, { id: "5", title: "Dark", disabled: true }] },
    { id: "g2", title: "", inline: true, children: [{ id: "7", title: "Close Tab", destructive: true }] },
  ]);
  for (const id of ["0", "1.0", "1.1", "4", "7"]) actions.get(id)!();
  expect(ran).toEqual(["copy", "studio", "pixel", "light", "close"]);
});

test("a menu with no dividers stays flat", () => {
  expect(nativeMenu([{ label: "One", onPress: run("one") }, { label: "Two", onPress: run("two") }]).items).toEqual([
    { id: "0", title: "One" },
    { id: "1", title: "Two" },
  ]);
});

test("with the system's menus the trigger is a native context menu, by tap or long press, and choosing an item runs it", () => {
  mockNative.contextMenu = true;
  for (const kind of ["tap", "longPress"] as const) {
    const root = trigger(kind);
    const menu = contextMenus(root)[0]!;
    expect(menu.props.trigger).toBe(kind);
    expect(menu.props.fixedOrder).toBe(true);
    expect(menu.props.items.map((item: { title: string }) => item.title)).toEqual(["Copy Link", "Send to Device", "Theme", ""]);
    const pressable = root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && "onPress" in node.props)[0]!;
    if (Platform.OS === "android") {
      act(() => (kind === "tap" ? pressable.props.onPress() : pressable.props.onLongPress()));
      expect(mockNative.shown).toBe(1);
      mockNative.shown = 0;
    } else {
      expect(pressable.props.onLongPress).toBeUndefined();
    }
    act(() => menu.props.onSelect("1.1"));
    expect(ran).toEqual(["pixel"]);
    ran.length = 0;
    unmount(root);
  }
});

test("on Android a long press opens the system's menu at the press through the gesture system, where a pan that takes the touch fails it", () => {
  if (Platform.OS !== "android") return;
  const { State } = require("react-native-gesture-handler") as typeof import("react-native-gesture-handler");
  const { fireGestureHandler, getByGestureTestId } = require("react-native-gesture-handler/jest-utils") as typeof import("react-native-gesture-handler/jest-utils");
  mockNative.contextMenu = true;
  const root = trigger("longPress");
  act(() => fireGestureHandler(getByGestureTestId("menuLongPress"), [{ state: State.BEGAN, x: 40, y: 12 }, { state: State.ACTIVE, x: 40, y: 12 }, { state: State.END, x: 40, y: 12 }]));
  act(() => jest.runOnlyPendingTimers());
  expect(mockNative.shownAt).toEqual([[40, 12]]);
  unmount(root);
});

test("without them the trigger opens the drawn menu on tap or long press, and a submenu opens as its own page", () => {
  const tapped = trigger("tap");
  expect(contextMenus(tapped)).toHaveLength(0);
  act(() => tapped.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(menuLabels(tapped)).toEqual(["Copy Link", "Send to Device", "Light", "Dark", "Close Tab"]);
  pickMenu(tapped, "Send to Device");
  expect(menuLabels(tapped)).toEqual(["Studio", "Pixel"]);
  pickMenu(tapped, "Studio");
  expect(ran).toEqual(["studio"]);
  expect(menuLabels(tapped)).toEqual([]);
  unmount(tapped);
  const held = trigger("longPress");
  act(() => held.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress());
  pickMenu(held, "Close Tab");
  expect(ran).toEqual(["studio", "close"]);
  unmount(held);
});

test("a confirmation is the system's action sheet when there is one, and runs only when its action is chosen", async () => {
  const drawn = jest.fn();
  const confirmed = jest.fn();
  const confirmation = { title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: confirmed };
  confirmInSheet(confirmation, drawn);
  expect(drawn).toHaveBeenCalledTimes(1);
  expect(mockNative.sheets).toHaveLength(0);
  mockNative.actionSheet = true;
  confirmInSheet(confirmation, drawn);
  await act(async () => undefined);
  expect(mockNative.sheets[0]).toEqual({
    title: "Close 3 Tabs?",
    message: "They’ll stay in your Archive.",
    actions: [
      { id: "confirm", title: "Close All Tabs", destructive: true },
      { id: "cancel", title: "Cancel", cancel: true },
    ],
  });
  expect(confirmed).not.toHaveBeenCalled();
  mockNative.answer = "confirm";
  confirmInSheet(confirmation, drawn);
  await act(async () => undefined);
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(drawn).toHaveBeenCalledTimes(1);
});
