import { useState } from "react";
import { BackHandler, Platform, Pressable, Text } from "react-native";
import { act } from "react-test-renderer";
import { renderSurface, unmount } from "../../test/render/harness";
import { mockNative, resetNativeMenus } from "./nativeMenusMock";
import { menuMotion } from "../components/ui/motion";
import { menuLook } from "../components/ui/tokens";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { MenuTrigger, confirmInSheet, nativeMenu } = require("../components/ui/MenuTrigger") as typeof import("../components/ui/MenuTrigger");
const { FloatingMenu, Menu, menuExitMs } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");
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
const throughClose = () => {
  act(() => jest.advanceTimersByTime(1000));
  act(() => jest.advanceTimersByTime(32));
};
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

function pressBack() {
  const listening = jest.spyOn(BackHandler, "addEventListener");
  return () =>
    act(() => {
      const backs = listening.mock.calls.filter((call) => call[0] === "hardwareBackPress").map((call) => call[1]);
      for (const back of [...backs].reverse()) if (back({ type: "hardwareBackPress", timeStamp: 0 } as never)) break;
    });
}

beforeEach(() => {
  jest.useFakeTimers();
  ran.length = 0;
  resetNativeMenus();
});

afterEach(() => {
  jest.restoreAllMocks();
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

test("on iPhone, with the system's menus, the trigger is a native context menu, by tap or long press, and choosing an item runs it", () => {
  if (Platform.OS !== "ios") return;
  mockNative.contextMenu = true;
  for (const kind of ["tap", "longPress"] as const) {
    const root = trigger(kind);
    const menu = contextMenus(root)[0]!;
    expect(menu.props.trigger).toBe(kind);
    expect(menu.props.fixedOrder).toBe(true);
    expect(menu.props.items.map((item: { title: string }) => item.title)).toEqual(["Copy Link", "Send to Device", "Theme", ""]);
    const pressable = root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && "onPress" in node.props)[0]!;
    expect(pressable.props.onLongPress).toBeUndefined();
    act(() => menu.props.onSelect("1.1"));
    expect(ran).toEqual(["pixel"]);
    ran.length = 0;
    unmount(root);
  }
});

test("Android never opens a system menu or action sheet, even where a native one would answer", async () => {
  if (Platform.OS !== "android") return;
  mockNative.contextMenu = true;
  mockNative.actionSheet = true;
  const root = trigger("tap");
  expect(contextMenus(root)).toHaveLength(0);
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(menuLabels(root)).toEqual(["Copy Link", "Send to Device", "Light", "Dark", "Close Tab"]);
  unmount(root);
  const drawn = jest.fn();
  confirmInSheet({ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: jest.fn() }, drawn);
  await act(async () => undefined);
  expect(drawn).toHaveBeenCalledTimes(1);
  expect(mockNative.sheets).toHaveLength(0);
});

test("the drawn menu splits its groups by divider: on Android an 8 dp gap with no rule, headings and rows kept in order; on iPhone a 9-point band with a 1-point line across the menu", () => {
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  const flatten = require("react-native").StyleSheet.flatten;
  const gaps = root.root.findAll((node) => node.props.testID === "drawnMenuGap" && typeof node.type === "string");
  const rules = root.root.findAll((node) => node.props.testID === "drawnMenuRule" && typeof node.type === "string");
  expect(gaps).toHaveLength(2);
  expect(gaps.map((gap) => flatten(gap.props.style).height)).toEqual(Platform.OS === "android" ? [8, 8] : [9, 9]);
  if (Platform.OS === "android") expect(rules).toHaveLength(0);
  else expect(rules.map((rule) => flatten(rule.props.style))).toEqual([expect.objectContaining({ height: 1, marginHorizontal: 0 }), expect.objectContaining({ height: 1, marginHorizontal: 0 })]);
  const order = root.root.findAll((node) => typeof node.type === "string" && (node.props.testID === "drawnMenuGap" || node.props.accessibilityRole === "header" || node.props.accessibilityRole === "menuitem")).map((node) => (node.props.testID === "drawnMenuGap" ? "gap" : node.props.accessibilityRole === "header" ? node.props.children : node.props.accessibilityLabel));
  expect(order).toEqual(["Copy Link", "Send to Device", "gap", "Theme", "Light", "Dark", "gap", "Close Tab"]);
  unmount(root);
});

test("a long press opens the drawn menu at the finger, dimmed, and a tap opens it beside its trigger, undimmed", async () => {
  measuredOverlay({ x: 0, y: 80, width: 393, height: 60 });
  const held = trigger("longPress");
  act(() => held.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 120, pageY: 300 } }));
  await act(async () => undefined);
  const floating = held.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(floating.props.at).toEqual({ x: 120, y: 300 });
  expect(floating.props.dimmed).toBe(true);
  const heldMenu = held.root.findAll((node) => node.type === Menu)[0]!;
  expect(heldMenu.props.shown).toBe(true);
  expect(heldMenu.props.placer(200)).toMatchObject({ place: { left: 120, top: 300, width: 250 }, origin: "left top", maxHeight: 200 });
  unmount(held);
  const tapped = renderSurface(
    <MenuTrigger items={ITEMS} trigger="tap" place={{ right: 16, width: 250 }}>
      {({ onPress }) => (
        <Pressable accessibilityLabel="Trigger" onPress={onPress}>
          <Text>Trigger</Text>
        </Pressable>
      )}
    </MenuTrigger>,
  );
  act(() => tapped.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ nativeEvent: { pageX: 300, pageY: 80 } }));
  const beside = tapped.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(beside.props.at).toBeNull();
  expect(beside.props.anchor.current).not.toBeUndefined();
  expect(beside.props.dimmed).toBe(false);
  expect(tapped.root.findAll((node) => node.type === Menu)[0]!.props.shown).toBe(false);
  unmount(tapped);
});

test("Back closes the drawn menu, and on a submenu's page goes back to the menu first", () => {
  const back = pressBack();
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  pickMenu(root, "Send to Device");
  expect(menuLabels(root)).toEqual(["Studio", "Pixel"]);
  back();
  expect(menuLabels(root)).toEqual(["Copy Link", "Send to Device", "Light", "Dark", "Close Tab"]);
  back();
  act(() => jest.advanceTimersByTime(Math.max(menuExitMs(true), menuExitMs(false))));
  expect(menuLabels(root)).toEqual([]);
  expect(ran).toEqual([]);
  unmount(root);
});

test("the drawn menu reads as a menu: rows are menu items with their checked and disabled state, and a submenu's page has a way back", () => {
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(root.root.findAll((node) => node.props.accessibilityRole === "menu" && typeof node.type !== "string")).not.toHaveLength(0);
  const row = (label: string) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.type === "string")[0]!;
  expect(row("Light").props.accessibilityState).toMatchObject({ checked: true });
  expect(row("Dark").props.accessibilityState).toMatchObject({ disabled: true });
  pickMenu(root, "Send to Device");
  const backRow = root.root.findAll((node) => node.props.accessibilityLabel === "Back, Send to Device" && typeof node.props.onPress === "function")[0]!;
  act(() => backRow.props.onPress());
  expect(menuLabels(root)).toContain("Copy Link");
  unmount(root);
});

test("each drawn menu and drawn action sheet counts drawn_menus_opened once as it opens", () => {
  const opened = jest.fn();
  const { onDrawnMenuOpened } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");
  onDrawnMenuOpened(opened);
  const root = trigger("tap");
  const open = () => act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  open();
  expect(opened).toHaveBeenCalledTimes(1);
  pickMenu(root, "Send to Device");
  expect(opened).toHaveBeenCalledTimes(1);
  pickMenu(root, "Pixel");
  open();
  expect(opened).toHaveBeenCalledTimes(2);
  unmount(root);
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: jest.fn() }} onClose={jest.fn()} />);
  expect(opened).toHaveBeenCalledTimes(3);
  unmount(sheet);
  onDrawnMenuOpened(() => undefined);
});

test("the drawn confirmation is a centred card, with one action and no Cancel row on iPhone and Cancel beside the action on Android: its action confirms, and Cancel, a tap outside, which never reaches what is under it, or Back cancels", () => {
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const back = pressBack();
  const confirmation = { title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: jest.fn() };
  const closed = jest.fn();
  const press = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
  const sheet = renderSurface(<ConfirmSheet confirmation={confirmation} onClose={closed} />);
  const text = sheet.root.findAll((node) => typeof node.type === "string" && typeof node.props.children === "string").map((node) => node.props.children).join("\n");
  expect(text).toContain("Close 3 Tabs?");
  expect(text).toContain("They’ll stay in your Archive.");
  const outside = sheet.root.findAll((node) => node.props.testID === "drawnConfirmationOutside" && typeof node.props.onPress === "function")[0]!;
  const cancelLabels = sheet.root.findAll((node) => typeof node.type === "string" && node.props.children === "Cancel");
  if (Platform.OS === "android") {
    expect(cancelLabels).toHaveLength(1);
    expect(outside.props.importantForAccessibility).toBe("no");
    const action = sheet.root.findAll((node) => node.props.accessibilityLabel === "Close All Tabs" && typeof node.props.onAccessibilityAction === "function")[0]!;
    expect(action.props.accessibilityActions).toContainEqual({ name: "cancel", label: "Cancel" });
    act(() => action.props.onAccessibilityAction({ nativeEvent: { actionName: "cancel" } }));
    press(sheet, "Cancel");
    act(() => outside.props.onPress());
  } else {
    expect(cancelLabels).toHaveLength(0);
    expect(outside.props.accessibilityLabel).toBe("Cancel");
    act(() => outside.props.onPress());
  }
  back();
  const cancels = Platform.OS === "android" ? 4 : 2;
  expect(closed).toHaveBeenCalledTimes(cancels);
  expect(confirmation.run).not.toHaveBeenCalled();
  press(sheet, "Close All Tabs");
  expect(closed).toHaveBeenCalledTimes(cancels + 1);
  expect(confirmation.run).toHaveBeenCalledTimes(1);
  unmount(sheet);
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
  act(() => jest.advanceTimersByTime(Math.max(menuExitMs(true), menuExitMs(false))));
  expect(menuLabels(tapped)).toEqual([]);
  unmount(tapped);
  const held = trigger("longPress");
  act(() => held.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress());
  pickMenu(held, "Close Tab");
  expect(ran).toEqual(["studio", "close"]);
  unmount(held);
});

test("on iPhone a confirmation is the system's action sheet when there is one, and runs only when its action is chosen", async () => {
  if (Platform.OS !== "ios") return;
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

const RECENT: MenuItem[] = [...Array.from({ length: 8 }, (_, at): MenuItem => ({ label: `Tab ${at}`, onPress: run(`tab${at}`) })), "divider", { label: "Close Tab", destructive: true, onPress: run("close") }];

test("a menu taller than a landscape screen is cut to the safe room and its rows scroll, so the last one stays reachable", () => {
  const { pointPlacer } = require("../components/ui") as typeof import("../components/ui");
  const placer = pointPlacer({ x: 400, y: 300 }, { width: 873, height: 392 }, { top: 24, bottom: 24, left: 0, right: 0 }, 250);
  const root = renderSurface(<Menu items={RECENT} placer={placer} onDismiss={() => undefined} />);
  const panel = root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")[0]!;
  const style = require("react-native").StyleSheet.flatten(panel.props.style);
  expect(style.top).toBeGreaterThanOrEqual(32);
  expect(style.top + style.maxHeight).toBeLessThanOrEqual(360);
  const rows = root.root.findAll((node) => node.props.testID === "drawnMenuRows" && typeof node.props.onContentSizeChange === "function")[0]!;
  expect(rows.findAll((node) => node.props.accessibilityLabel === "Close Tab" && typeof node.props.onPress === "function")).not.toHaveLength(0);
  act(() => rows.props.onContentSizeChange(250, 500));
  const measured = require("react-native").StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")[0]!.props.style);
  expect(measured.maxHeight).toBe(328);
  expect(measured.top + measured.maxHeight).toBeLessThanOrEqual(360);
  unmount(root);
});

const rowsOf = (root: Root) => root.root.findAll((node) => node.props.testID === "drawnMenuRows" && typeof node.props.onContentSizeChange === "function")[0]!;
const panelOf = (root: Root) => root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")[0]!;
const flat = (style: unknown) => require("react-native").StyleSheet.flatten(style);
const setWindow = (window: object) => act(() => (require("react-native").Dimensions as { set: (dims: object) => void }).set({ window, screen: window }));

test("a placed menu stays hidden until its rows are measured, then shows where they fit, so it never jumps across the finger", () => {
  const { pointPlacer } = require("../components/ui") as typeof import("../components/ui");
  const placer = pointPlacer({ x: 60, y: 600 }, { width: 393, height: 873 }, { top: 40, bottom: 24, left: 0, right: 0 }, 250);
  const five: MenuItem[] = Array.from({ length: 5 }, (_, at): MenuItem => ({ label: `Row ${at}`, onPress: run(`row${at}`) }));
  const root = renderSurface(<Menu items={five} placer={placer} onDismiss={() => undefined} />);
  expect(flat(panelOf(root).props.style).opacity).toBe(0);
  const hiddenLayer = () => root.root.findAll((node) => typeof node.type === "string" && node.props.pointerEvents === "none" && node.props.accessibilityElementsHidden === true);
  expect(hiddenLayer()).toHaveLength(1);
  act(() => rowsOf(root).props.onContentSizeChange(250, 300));
  const shown = flat(panelOf(root).props.style);
  expect(shown.opacity).not.toBe(0);
  expect(hiddenLayer()).toHaveLength(0);
  expect(shown.top).toBe(600 - 16 - (300 + 2 * menuLook.rim));
  unmount(root);
});

test("when a submenu's page is taller, the menu re-measures and stays on its side of the finger", () => {
  const { pointPlacer } = require("../components/ui") as typeof import("../components/ui");
  const placer = pointPlacer({ x: 60, y: 500 }, { width: 393, height: 873 }, { top: 40, bottom: 24, left: 0, right: 0 }, 250);
  const root = renderSurface(<Menu items={ITEMS} placer={placer} onDismiss={() => undefined} />);
  act(() => rowsOf(root).props.onContentSizeChange(250, 250));
  expect(flat(panelOf(root).props.style).top).toBe(500);
  pickMenu(root, "Send to Device");
  act(() => rowsOf(root).props.onContentSizeChange(250, 420));
  const page = flat(panelOf(root).props.style);
  expect(page.top).toBeLessThan(500);
  expect(page.top).toBe(841 - (420 + 2 * menuLook.rim));
  expect(page.top + page.maxHeight).toBeLessThanOrEqual(841);
  unmount(root);
});

test("turning the phone closes an open drawn menu, as UIKit's do, but the keyboard coming up does not", () => {
  const { Dimensions } = require("react-native") as typeof import("react-native");
  const before = Dimensions.get("window");
  const closed = jest.fn();
  const root = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={closed} />);
  setWindow({ ...before, height: before.height - 300 });
  expect(closed).not.toHaveBeenCalled();
  setWindow(before);
  setWindow({ ...before, width: before.height, height: before.width });
  expect(closed).toHaveBeenCalledTimes(1);
  setWindow(before);
  unmount(root);
});

test("a chosen row runs at once, and only once however often it is tapped, while the menu plays its close", () => {
  const closed = jest.fn();
  const chosen = jest.fn();
  const root = renderSurface(<Menu items={[{ label: "Close Tab", destructive: true, onPress: chosen }]} place={{ top: 100, left: 20, width: 250 }} onDismiss={closed} />);
  const row = root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.props.onPress === "function")[0]!;
  act(() => row.props.onPress());
  expect(chosen).toHaveBeenCalledTimes(1);
  act(() => row.props.onPress());
  expect(chosen).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1000));
  expect(chosen).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("rows scroll under a tap with the keyboard up, in the menu and in the confirmation", () => {
  const root = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={() => undefined} />);
  expect(rowsOf(root).props.keyboardShouldPersistTaps).toBe("handled");
  unmount(root);
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => undefined} />);
  expect(sheet.root.findAll((node) => node.props.testID === "drawnConfirmationScroll" && typeof node.type !== "string")[0]!.props.keyboardShouldPersistTaps).toBe("handled");
  unmount(sheet);
});

test("TalkBack moves to the first enabled row once the menu is shown, and back to the control that opened it only when the menu is dismissed without a choice", () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const hidden = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} shown={false} onDismiss={() => undefined} />);
  expect(asked).not.toHaveBeenCalled();
  unmount(hidden);
  const shown = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={() => undefined} />);
  expect(asked).toHaveBeenCalledTimes(1);
  unmount(shown);
  const opener = { opener: true };
  const restored = () => asked.mock.calls.filter(([target]) => target() === opener).length;
  const back = pressBack();
  const root = trigger("tap");
  const open = () => act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: opener, nativeEvent: {} }));
  open();
  back();
  throughClose();
  expect(restored()).toBe(1);
  open();
  act(() => root.root.findAll((node) => node.props.testID === "drawnMenuScrim" && typeof node.props.onPress === "function")[0]!.props.onPress({ nativeEvent: {} }));
  throughClose();
  expect(restored()).toBe(2);
  open();
  pickMenu(root, "Copy Link");
  throughClose();
  expect(restored()).toBe(2);
  open();
  back();
  unmount(root);
  throughClose();
  expect(restored()).toBe(2);
});

test("a TalkBack focus asked for as the menu opens is dropped once the menu starts closing, so it never lands on a closing row", async () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const cancelled = jest.fn();
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => cancelled);
  const back = pressBack();
  measuredOverlay({ x: 0, y: 280, width: 393, height: 60 });
  const root = trigger("longPress");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 120, pageY: 300 } }));
  await act(async () => undefined);
  act(() => rowsOf(root).props.onContentSizeChange(250, 200));
  expect(asked).toHaveBeenCalledTimes(1);
  expect(cancelled).not.toHaveBeenCalled();
  back();
  expect(cancelled).toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1000));
  unmount(root);
});

test("an Incognito card's native menu on iPhone is not counted either", () => {
  if (Platform.OS !== "ios") return;
  mockNative.contextMenu = true;
  const { onNativeMenuOpened } = require("../components/ui/MenuTrigger") as typeof import("../components/ui/MenuTrigger");
  const opened = jest.fn();
  onNativeMenuOpened(opened);
  const root = renderSurface(
    <MenuTrigger items={ITEMS} trigger="longPress" privately>
      {() => <Text>Card</Text>}
    </MenuTrigger>,
  );
  act(() => contextMenus(root)[0]!.props.onOpen());
  expect(opened).toHaveBeenCalledWith(true);
  unmount(root);
  const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const { countNativeMenu } = require("../state/browse/menuCounts") as typeof import("../state/browse/menuCounts");
  const { useTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
  act(() => useTabs.setState({ incognito: false }));
  countNativeMenu(true);
  expect(counted).not.toHaveBeenCalled();
  countNativeMenu(false);
  expect(counted).toHaveBeenCalledWith("native_menus_opened");
  onNativeMenuOpened(() => undefined);
});

test("drawn menus count public opens and Android selections once, but neither is counted while browsing privately", () => {
  const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const { countDrawnMenu, countDrawnMenuAction } = require("../state/browse/menuCounts") as typeof import("../state/browse/menuCounts");
  const { onDrawnMenuActionChosen, onDrawnMenuOpened } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");
  const { useTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
  const { useBrowse } = require("../state/browse/store") as typeof import("../state/browse/store");
  const { launchTabs } = require("../state/tabs/tabsState") as typeof import("../state/tabs/tabsState");
  const { someTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");
  const tabs = useTabs.getState();
  const browse = useBrowse.getState();
  const privateTab = someTabs(1, true)[0]!;
  const openAndChoose = (privately = false) => {
    const root = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} privately={privately} onDismiss={() => undefined} />);
    try {
      pickMenu(root, "Copy Link");
      pickMenu(root, "Copy Link");
    } finally {
      unmount(root);
    }
  };
  onDrawnMenuOpened(countDrawnMenu);
  if (Platform.OS === "android") onDrawnMenuActionChosen(countDrawnMenuAction);
  try {
    act(() => {
      useTabs.setState({ ...launchTabs(someTabs(2), 0), incognito: false, listing: 0 });
      useBrowse.setState({ surface: "deck" });
    });
    openAndChoose();
    openAndChoose(true);
    act(() => useTabs.setState({ incognito: true }));
    openAndChoose();
    act(() => {
      useTabs.setState({ incognito: false, privates: [privateTab], selectedId: privateTab.id });
      useBrowse.setState({ surface: "browsing" });
    });
    openAndChoose();
    expect(ran).toEqual(["copy", "copy", "copy", "copy"]);
    expect(counted.mock.calls).toEqual(Platform.OS === "android" ? [["drawn_menus_opened"], ["drawn_menu_actions_chosen"]] : [["drawn_menus_opened"]]);
  } finally {
    onDrawnMenuOpened(() => undefined);
    onDrawnMenuActionChosen(() => undefined);
    act(() => {
      useTabs.setState(tabs);
      useBrowse.setState(browse);
    });
  }
});

test("a confirmation's button labels wrap instead of truncating, and the card grows with the text size up to the screen's width", () => {
  const { ConfirmSheet, confirmCardWidth, materialDialogWidth } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  expect(confirmCardWidth(1, 393)).toBeCloseTo(240.3);
  expect(confirmCardWidth(1.5, 393)).toBeCloseTo(360.45);
  expect(confirmCardWidth(2, 393)).toBe(361);
  expect(materialDialogWidth(393)).toBe(345);
  expect(materialDialogWidth(1000)).toBe(560);
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => undefined} />);
  const label = sheet.root.findAll((node) => typeof node.type === "string" && node.props.children === "Close All Tabs")[0]!;
  expect(label.props.numberOfLines).toBeUndefined();
  const button = sheet.root.findAll((node) => node.props.accessibilityLabel === "Close All Tabs" && typeof node.type === "string")[0]!;
  const style = require("react-native").StyleSheet.flatten(button.props.style);
  expect(style.height).toBeUndefined();
  expect(style.minHeight).toBe(Platform.OS === "android" ? 40 : 43.5);
  unmount(sheet);
});

const covered = (root: Root) => root.root.findAll((node) => node.props.testID === "overlayCovered" && typeof node.type === "string")[0]!.props;

test("a closed menu stays drawn for its close, out of the way of touches and TalkBack, and goes when the close ends", () => {
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(covered(root).importantForAccessibility).toBe("no-hide-descendants");
  act(() => root.root.findAll((node) => node.props.testID === "drawnMenuScrim" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")).toHaveLength(1);
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.pointerEvents === "none" && node.props.accessibilityElementsHidden === true)).not.toHaveLength(0);
  expect(covered(root).importantForAccessibility).toBe("auto");
  act(() => jest.advanceTimersByTime(menuExitMs(false)));
  expect(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")).toHaveLength(0);
  unmount(root);
});

test("a row that opens a confirmation shows the card alone: the closing menu is dropped at once, and the app behind is hidden from TalkBack", () => {
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const { useState } = require("react") as typeof import("react");
  function Asking() {
    const [asking, setAsking] = useState(false);
    return (
      <>
        <MenuTrigger items={[{ label: "Close All Tabs", destructive: true, onPress: () => setAsking(true) }]} trigger="tap">
          {({ onPress }) => (
            <Pressable accessibilityLabel="More" onPress={onPress}>
              <Text>More</Text>
            </Pressable>
          )}
        </MenuTrigger>
        {asking ? <ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => setAsking(false)} /> : null}
      </>
    );
  }
  const root = renderSurface(<Asking />);
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "More" && typeof node.props.onPress === "function")[0]!.props.onPress());
  pickMenu(root, "Close All Tabs");
  expect(root.root.findAll((node) => node.props.testID === "drawnActionSheet" && typeof node.type === "string")).toHaveLength(1);
  expect(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")).toHaveLength(0);
  expect(covered(root).importantForAccessibility).toBe("no-hide-descendants");
  unmount(root);
});

const measuredOverlay = (anchor: { x: number; y: number; width: number; height: number }) => {
  const overlay = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  jest.spyOn(overlay, "measureAnchor").mockResolvedValue(anchor);
  jest.spyOn(overlay, "useOverlayFrame").mockReturnValue(() => Promise.resolve({ x: 0, y: 0, width: 393, height: 873 }));
};

test("a tap menu closes by shrinking into its trigger's size from the trigger's corner", async () => {
  measuredOverlay({ x: 336, y: 66, width: 44, height: 44 });
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  await act(async () => undefined);
  const placed = root.root.findAll((node) => node.type === Menu)[0]!.props.placer(272);
  expect(placed.origin).toBe("right top");
  expect(placed.shrink).toEqual({ x: 44 / 250, y: 44 / 272 });
  expect(placed.place).toMatchObject({ left: 130, top: 66 });
  unmount(root);
});

test("a long press on a small control, like the tabs button, opens its menu ending 16 pt above the control when it can't fit below", async () => {
  measuredOverlay({ x: 16, y: 790, width: 48, height: 48 });
  const root = trigger("longPress");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 814 } }));
  const menu = () => root.root.findAll((node) => node.type === Menu)[0]!;
  expect(menu().props.shown).toBe(false);
  await act(async () => undefined);
  const placed = menu().props.placer(300);
  expect(placed.place.top + placed.maxHeight).toBe(790 - 16);
  unmount(root);
});

test("on Android TalkBack focus lands after layout, a moment after the menu shows, and never once the menu has gone", async () => {
  if (Platform.OS !== "android") return;
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const { focusForScreenReader, ANDROID_FOCUS_DELAY_MS } = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  const focused = jest.spyOn(AccessibilityInfo, "setAccessibilityFocus").mockImplementation(() => undefined);
  focusForScreenReader(() => 42 as never);
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(20));
  expect(focused).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS));
  expect(focused).toHaveBeenCalledWith(42);
  focused.mockClear();
  let live = true;
  focusForScreenReader(
    () => 42 as never,
    () => live,
  );
  await act(async () => undefined);
  live = false;
  act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS + 50));
  expect(focused).not.toHaveBeenCalled();
});

test("a confirmation's title and message are one TalkBack stop, the one focus lands on when it opens", () => {
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => undefined} />);
  const heading = sheet.root.findAll((node) => node.props.testID === "drawnConfirmationHeading" && typeof node.type === "string")[0]!;
  expect(heading.props.accessible).toBe(true);
  expect(heading.props.accessibilityLabel).toBe("Close 3 Tabs? They’ll stay in your Archive.");
  expect(sheet.root.findAll((node) => typeof node.type === "string" && node.props.accessible === true && node.props.accessibilityLabel?.includes?.("Close 3 Tabs?"))).toHaveLength(1);
  unmount(sheet);
});

test("on Android TalkBack focus goes through the native accessibility-focus action, not RN's focus event, and announcements through the native announcer", async () => {
  if (Platform.OS !== "android") return;
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const phoneNative = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  const { focusForScreenReader, announceForScreenReader, ANDROID_FOCUS_DELAY_MS } = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  jest.spyOn(phoneNative, "screenReaderFocusIsNative").mockReturnValue(true);
  const nativeFocus = jest.spyOn(phoneNative, "focusViewNatively").mockImplementation(() => () => undefined);
  const nativeAnnounce = jest.spyOn(phoneNative, "announceNatively").mockImplementation(() => undefined);
  const rnFocus = jest.spyOn(AccessibilityInfo, "setAccessibilityFocus").mockImplementation(() => undefined);
  focusForScreenReader(() => 42 as never);
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS + 20));
  expect(nativeFocus).toHaveBeenCalledWith(42, { returning: false });
  expect(rnFocus).not.toHaveBeenCalled();
  announceForScreenReader("Close 3 Tabs? They’ll stay in your Archive.");
  await act(async () => undefined);
  expect(nativeAnnounce).toHaveBeenCalledWith("Close 3 Tabs? They’ll stay in your Archive.");
});

test("the confirmation gives TalkBack focus to its heading, one node reading title and message as AlertDialog's does, with no separate announcement; on Android Cancel is an action on the heading and on each button", async () => {
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const phoneNative = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const nativeAnnounce = jest.spyOn(phoneNative, "announceNatively").mockImplementation(() => undefined);
  const announced = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const closed = jest.fn();
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={closed} />);
  await act(async () => undefined);
  const heading = sheet.root.findAll((node) => node.props.testID === "drawnConfirmationHeading" && typeof node.type === "string")[0]!;
  const headingView = sheet.root.findAll((node) => node.props.testID === "drawnConfirmationHeading" && typeof node.type !== "string").map((node) => node.instance).filter(Boolean)[0];
  expect(heading.props.accessibilityLabel).toBe("Close 3 Tabs? They’ll stay in your Archive.");
  expect(asked).toHaveBeenCalledTimes(1);
  expect(headingView).toBeTruthy();
  expect(asked.mock.calls[0]![0]() === headingView).toBe(true);
  expect(nativeAnnounce).not.toHaveBeenCalled();
  expect(announced).not.toHaveBeenCalled();
  const button = sheet.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button" && node.props.accessibilityLabel === "Close All Tabs")[0]!;
  if (Platform.OS === "android") {
    expect(heading.props.accessibilityActions).toEqual([{ name: "cancel", label: "Cancel" }]);
    act(() => heading.props.onAccessibilityAction({ nativeEvent: { actionName: "cancel" } }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(button.props.accessibilityActions).toContainEqual({ name: "cancel", label: "Cancel" });
    act(() => button.props.onAccessibilityAction({ nativeEvent: { actionName: "cancel" } }));
    expect(closed).toHaveBeenCalledTimes(2);
  } else {
    expect(heading.props.accessibilityActions).toBeUndefined();
  }
  unmount(sheet);
});

test("TalkBack's way back to a held menu's trigger waits until the closing layer has gone and the app can be read again, then a frame", async () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const opener = { opener: true };
  const landed: { menus: number; app: unknown }[] = [];
  let root: Root | null = null;
  jest.spyOn(focus, "focusForScreenReader").mockImplementation((target) => {
    if (target() === opener && root) {
      landed.push({
        menus: root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string").length,
        app: root.root.findAll((node) => node.props.testID === "overlayCovered" && typeof node.type === "string")[0]!.props.importantForAccessibility,
      });
    }
    return () => undefined;
  });
  const back = pressBack();
  measuredOverlay({ x: 0, y: 280, width: 393, height: 60 });
  root = trigger("longPress");
  act(() => root!.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ currentTarget: opener, nativeEvent: { pageX: 120, pageY: 300 } }));
  await act(async () => undefined);
  act(() => rowsOf(root!).props.onContentSizeChange(250, 200));
  back();
  for (let step = 0; step < 40; step++) act(() => jest.advanceTimersByTime(16));
  expect(landed).toEqual([{ menus: 0, app: "auto" }]);
  unmount(root);
});

test("a confirmation opened from a menu row gives TalkBack focus back to the menu's trigger when it is cancelled, by Back, a tap outside or the Cancel action, and not when it is confirmed", () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const opener = { opener: true };
  const restored = () => asked.mock.calls.filter(([target]) => target() === opener).length;
  const closedAll = jest.fn();
  function Harness() {
    const [asking, setAsking] = useState(false);
    return (
      <>
        <MenuTrigger items={[{ label: "Close All Tabs", destructive: true, onPress: () => setAsking(true) }]} trigger="tap">
          {({ onPress }) => (
            <Pressable accessibilityLabel="More" onPress={onPress}>
              <Text>More</Text>
            </Pressable>
          )}
        </MenuTrigger>
        {asking ? <ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: closedAll }} onClose={() => setAsking(false)} /> : null}
      </>
    );
  }
  const back = pressBack();
  const root = renderSurface(<Harness />);
  const ask = () => {
    asked.mockClear();
    act(() => root.root.findAll((node) => node.props.accessibilityLabel === "More" && typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: opener, nativeEvent: {} }));
    pickMenu(root, "Close All Tabs");
    throughClose();
    expect(root.root.findAll((node) => node.props.testID === "drawnActionSheet")).not.toHaveLength(0);
    expect(restored()).toBe(0);
  };
  const host = (testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0]!;
  const ways: (() => void)[] = [back, () => act(() => root.root.findAll((node) => node.props.testID === "drawnConfirmationOutside" && typeof node.props.onPress === "function")[0]!.props.onPress())];
  if (Platform.OS === "android") ways.push(() => act(() => host("drawnConfirmationHeading").props.onAccessibilityAction({ nativeEvent: { actionName: "cancel" } })));
  for (const cancel of ways) {
    ask();
    cancel();
    throughClose();
    expect(root.root.findAll((node) => node.props.testID === "drawnActionSheet")).toHaveLength(0);
    expect(restored()).toBe(1);
  }
  ask();
  act(() => root.root.findAll((node) => node.props.accessibilityRole === "button" && node.props.accessibilityLabel === "Close All Tabs" && typeof node.props.onPress === "function")[0]!.props.onPress());
  throughClose();
  expect(closedAll).toHaveBeenCalledTimes(1);
  expect(restored()).toBe(0);
  unmount(root);
});

test("a closing layer goes as soon as its own animation says it has finished, and after its exit time plus a fallback if it never does", () => {
  const { Portal, LEAVE_FALLBACK_MS, usePortalLeaving, usePortalLeft } = require("../components/ui/Overlay") as typeof import("../components/ui/Overlay");
  function Leaving({ finishes }: { finishes: boolean }) {
    const leaving = usePortalLeaving();
    const left = usePortalLeft();
    return (
      <Pressable testID="leavingLayer" onPress={() => finishes && leaving && left()}>
        <Text>{leaving ? "leaving" : "shown"}</Text>
      </Pressable>
    );
  }
  const { updateSurface } = require("../../test/render/harness") as typeof import("../../test/render/harness");
  const layers = (root: Root) => root.root.findAll((node) => node.props.testID === "leavingLayer" && typeof node.props.onPress === "function");
  for (const finishes of [true, false]) {
    const view = (open: boolean) => (open ? <Portal exitMs={5000}><Leaving finishes={finishes} /></Portal> : null);
    const root = renderSurface(view(true));
    updateSurface(root, view(false));
    expect(layers(root)).toHaveLength(1);
    act(() => layers(root)[0]!.props.onPress());
    if (finishes) expect(layers(root)).toHaveLength(0);
    else {
      act(() => jest.advanceTimersByTime(5000 + LEAVE_FALLBACK_MS - 1));
      expect(layers(root)).toHaveLength(1);
      act(() => jest.advanceTimersByTime(1));
      expect(layers(root)).toHaveLength(0);
    }
    unmount(root);
  }
});

test("a tap menu's rows fade within four frames and its glass in the last two of the 200 ms shrink", () => {
  expect(menuMotion.contentFade).toBeLessThanOrEqual(Math.ceil((4 * 1000) / 60));
  expect(menuMotion.glassFade).toBeLessThanOrEqual(Math.ceil((2 * 1000) / 60));
  expect(menuMotion.glassFade).toBeLessThan(menuMotion.close);
});

test("a long press with no touch point, as TalkBack and Switch Access send, places the menu from the pressed control: 16 pt above a small one near the bottom", async () => {
  measuredOverlay({ x: 16, y: 790, width: 48, height: 48 });
  const root = trigger("longPress");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress());
  await act(async () => undefined);
  const placed = root.root.findAll((node) => node.type === Menu)[0]!.props.placer(300);
  expect(placed.place.top + placed.maxHeight).toBe(790 - 16);
  expect(placed.place.left).toBe(16);
  unmount(root);
});

describe("giving TalkBack focus back to the trigger after a menu closes without a choice", () => {
  const OPENER = 77;
  const settle = async () => {
    for (let step = 0; step < 4; step++) {
      await act(async () => undefined);
      act(() => jest.advanceTimersByTime(400));
    }
  };
  function Harness({ disabled = false, asking = false }: { disabled?: boolean; asking?: boolean }) {
    const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
    return (
      <>
        <MenuTrigger items={ITEMS} trigger="tap" disabled={disabled}>
          {({ onPress }) => (
            <Pressable accessibilityLabel="Trigger" onPress={onPress}>
              <Text>Trigger</Text>
            </Pressable>
          )}
        </MenuTrigger>
        {asking ? <ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => undefined} /> : null}
      </>
    );
  }
  const setUp = () => {
    const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
    jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
    const focused = jest.spyOn(AccessibilityInfo, "setAccessibilityFocus").mockImplementation(() => undefined);
    focused.mockClear();
    const back = pressBack();
    const { updateSurface } = require("../../test/render/harness") as typeof import("../../test/render/harness");
    const root = renderSurface(<Harness />);
    const open = () => act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: OPENER, nativeEvent: {} }));
    const restored = () => focused.mock.calls.filter(([handle]) => handle === OPENER).length;
    return { root, open, back, restored, update: (props: { disabled?: boolean; asking?: boolean }) => updateSurface(root, <Harness {...props} />) };
  };

  test("lands on the trigger once the menu has closed", async () => {
    const { root, open, back, restored } = setUp();
    open();
    back();
    await settle();
    expect(restored()).toBe(1);
    unmount(root);
  });

  test("is dropped when the menu is opened again before it lands", async () => {
    const { root, open, back, restored } = setUp();
    open();
    back();
    act(() => jest.advanceTimersByTime(100));
    open();
    await settle();
    expect(restored()).toBe(0);
    unmount(root);
  });

  test("is dropped when the trigger goes away after the restore has started", async () => {
    const { root, open, back, restored } = setUp();
    open();
    back();
    act(() => jest.advanceTimersByTime(menuMotion.heldClose + 1));
    await act(async () => undefined);
    unmount(root);
    await settle();
    expect(restored()).toBe(0);
  });

  test("is dropped when the trigger is turned off", async () => {
    const { root, open, back, restored, update } = setUp();
    open();
    back();
    update({ disabled: true });
    await settle();
    expect(restored()).toBe(0);
    unmount(root);
  });

  test("stays dropped once a newer overlay has opened, even after that overlay has closed again", async () => {
    const { root, open, back, restored, update } = setUp();
    open();
    back();
    act(() => jest.advanceTimersByTime(100));
    update({ asking: true });
    act(() => jest.advanceTimersByTime(100));
    update({ asking: false });
    await settle();
    expect(restored()).toBe(0);
    unmount(root);
  });

  test("is dropped when a newer overlay has opened over the screen", async () => {
    const { root, open, back, restored, update } = setUp();
    open();
    back();
    act(() => jest.advanceTimersByTime(menuMotion.heldClose + 1));
    await act(async () => undefined);
    update({ asking: true });
    await settle();
    expect(restored()).toBe(0);
    unmount(root);
  });
});

test("on Android cancelling a focus after its native request went out revokes that request, so a closing menu's row is never focused late", async () => {
  if (Platform.OS !== "android") return;
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const phoneNative = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  const { focusForScreenReader, ANDROID_FOCUS_DELAY_MS } = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  jest.spyOn(phoneNative, "screenReaderFocusIsNative").mockReturnValue(true);
  const revoked = jest.fn();
  const sent = jest.spyOn(phoneNative, "focusViewNatively").mockImplementation(() => revoked);
  const cancel = focusForScreenReader(() => 42 as never);
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS + 20));
  expect(sent).toHaveBeenCalledWith(42, { returning: false });
  expect(revoked).not.toHaveBeenCalled();
  cancel();
  expect(revoked).toHaveBeenCalledTimes(1);
});

test("a tap menu's close is over at 200 ms, its fade folded into the end of the shrink, and the layer goes a couple of frames later", () => {
  expect(menuExitMs(false)).toBeLessThanOrEqual(menuMotion.close + 40);
  expect(menuExitMs(true)).toBeLessThanOrEqual(menuMotion.heldClose + 40);
});

test("on Android the menu's scrim can't take TalkBack focus, since Back dismisses as PopupMenu's does; iPhone keeps VoiceOver's Dismiss", () => {
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  const scrim = root.root.findAll((node) => node.props.testID === "drawnMenuScrim" && typeof node.props.onPress === "function")[0]!;
  if (Platform.OS === "android") {
    expect(scrim.props.importantForAccessibility).toBe("no");
    expect(scrim.props.accessible).toBe(false);
    expect(scrim.props.accessibilityLabel).toBeUndefined();
  } else {
    expect(scrim.props.accessibilityLabel).toBe("Dismiss");
  }
  const focusable = root.root.findAll((node) => typeof node.type === "string" && (node.props.accessible === true || typeof node.props.accessibilityLabel === "string") && node.props.importantForAccessibility !== "no");
  const labels = focusable.map((node) => node.props.accessibilityLabel).filter(Boolean);
  expect(labels).toEqual(expect.arrayContaining(["Copy Link", "Send to Device", "Light", "Dark", "Close Tab"]));
  if (Platform.OS === "android") expect(labels).not.toContain("Dismiss");
  unmount(root);
});

test("a picker gives TalkBack focus back to its row after a choice, as PopupMenu does, while other menus don't after a choice", async () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const opener = { opener: true };
  const restored = () => asked.mock.calls.filter(([target]) => target() === opener).length;
  for (const restoresAfterChoice of [true, false]) {
    asked.mockClear();
    const root = renderSurface(
      <MenuTrigger items={[{ label: "After 1 day", onPress: () => undefined }]} trigger="tap" restoresAfterChoice={restoresAfterChoice}>
        {({ onPress }) => (
          <Pressable accessibilityLabel="Archive Inactive Tabs" onPress={onPress}>
            <Text>Archive Inactive Tabs</Text>
          </Pressable>
        )}
      </MenuTrigger>,
    );
    act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Archive Inactive Tabs" && typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: opener, nativeEvent: {} }));
    pickMenu(root, "After 1 day");
    throughClose();
    expect(restored()).toBe(restoresAfterChoice ? 1 : 0);
    unmount(root);
  }
});

test("on Android a restore already handed to the native side is revoked the moment a newer overlay opens, even if it closes again", async () => {
  if (Platform.OS !== "android") return;
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const phoneNative = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const { updateSurface } = require("../../test/render/harness") as typeof import("../../test/render/harness");
  const { ANDROID_FOCUS_DELAY_MS } = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  jest.spyOn(phoneNative, "screenReaderFocusIsNative").mockReturnValue(true);
  const revoked = jest.fn();
  const sent = jest.spyOn(phoneNative, "focusViewNatively").mockImplementation(() => revoked);
  function Harness({ asking = false }: { asking?: boolean }) {
    return (
      <>
        <MenuTrigger items={ITEMS} trigger="tap">
          {({ onPress }) => (
            <Pressable accessibilityLabel="Trigger" onPress={onPress}>
              <Text>Trigger</Text>
            </Pressable>
          )}
        </MenuTrigger>
        {asking ? <ConfirmSheet confirmation={{ title: "Question", message: "", action: "Confirm", run: () => undefined }} onClose={() => undefined} /> : null}
      </>
    );
  }
  const back = pressBack();
  const root = renderSurface(<Harness />);
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: 77, nativeEvent: {} }));
  back();
  throughClose();
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS + 50));
  expect(sent).toHaveBeenCalledWith(77, { returning: true });
  expect(revoked).not.toHaveBeenCalled();
  updateSurface(root, <Harness asking />);
  expect(revoked).toHaveBeenCalledTimes(1);
  updateSurface(root, <Harness />);
  unmount(root);
});

test("a submenu inside a submenu opens over its parent, and Back, by the key or the Back row, goes up one level at a time before the menu closes", () => {
  const back = pressBack();
  const dismissed = jest.fn();
  const nested: MenuItem[] = [
    { label: "Copy Link", onPress: run("copy") },
    { label: "Share", children: [{ label: "Mail", onPress: run("mail") }, { label: "More Apps", children: [{ label: "Notes", onPress: run("notes") }, { label: "Files", onPress: run("files") }] }] },
  ];
  const root = renderSurface(<Menu items={nested} place={{ top: 100, left: 20, width: 250 }} onDismiss={dismissed} />);
  const backRow = () => root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.startsWith("Back, ") && typeof node.props.onPress === "function")[0];
  pickMenu(root, "Share");
  pickMenu(root, "More Apps");
  expect(menuLabels(root)).toEqual(["Notes", "Files"]);
  expect(backRow()!.props.accessibilityLabel).toBe("Back, More Apps");
  back();
  expect(menuLabels(root)).toEqual(["Mail", "More Apps"]);
  expect(backRow()!.props.accessibilityLabel).toBe("Back, Share");
  pickMenu(root, "More Apps");
  act(() => backRow()!.props.onPress());
  expect(menuLabels(root)).toEqual(["Mail", "More Apps"]);
  back();
  expect(menuLabels(root)).toEqual(["Copy Link", "Share"]);
  expect(backRow()).toBeUndefined();
  expect(dismissed).not.toHaveBeenCalled();
  back();
  expect(dismissed).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("the app is readable again the moment a menu or a confirmation starts closing, with the closing layer already hidden, so TalkBack settles during the close and not after the restore", () => {
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const { updateSurface } = require("../../test/render/harness") as typeof import("../../test/render/harness");
  const back = pressBack();
  function Harness({ asking = false }: { asking?: boolean }) {
    return (
      <>
        <MenuTrigger items={ITEMS} trigger="tap">
          {({ onPress }) => (
            <Pressable accessibilityLabel="Trigger" onPress={onPress}>
              <Text>Trigger</Text>
            </Pressable>
          )}
        </MenuTrigger>
        {asking ? <ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => undefined} /> : null}
      </>
    );
  }
  const root = renderSurface(<Harness />);
  const app = () => root.root.findAll((node) => node.props.testID === "overlayCovered" && typeof node.type === "string")[0]!.props.importantForAccessibility;
  const layerHidden = (testID: string) => {
    let node = root.root.findAll((one) => one.props.testID === testID && typeof one.type === "string")[0]!.parent;
    while (node && node.props.importantForAccessibility !== "no-hide-descendants") node = node.parent;
    return node !== null && node.props.testID !== "overlayCovered";
  };
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ nativeEvent: {} }));
  expect(app()).toBe("no-hide-descendants");
  back();
  expect(app()).toBe("auto");
  expect(layerHidden("drawnMenuRows")).toBe(true);
  throughClose();
  updateSurface(root, <Harness asking />);
  expect(app()).toBe("no-hide-descendants");
  updateSurface(root, <Harness />);
  expect(app()).toBe("auto");
  expect(layerHidden("drawnActionSheet")).toBe(true);
  unmount(root);
});

test("on Android a restore asks the native side to return focus, which re-asks once 300 ms after landing only if the target lost focus; JS sends it once, and a newer overlay revokes it, re-ask included", async () => {
  if (Platform.OS !== "android") return;
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const phoneNative = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const { updateSurface } = require("../../test/render/harness") as typeof import("../../test/render/harness");
  const { ANDROID_FOCUS_DELAY_MS } = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  jest.spyOn(phoneNative, "screenReaderFocusIsNative").mockReturnValue(true);
  const revoked = jest.fn();
  const sent = jest.spyOn(phoneNative, "focusViewNatively").mockImplementation(() => revoked);
  function Harness({ asking = false }: { asking?: boolean }) {
    return (
      <>
        <MenuTrigger items={ITEMS} trigger="tap">
          {({ onPress }) => (
            <Pressable accessibilityLabel="Trigger" onPress={onPress}>
              <Text>Trigger</Text>
            </Pressable>
          )}
        </MenuTrigger>
        {asking ? <ConfirmSheet confirmation={{ title: "Question", message: "", action: "Confirm", run: () => undefined }} onClose={() => undefined} /> : null}
      </>
    );
  }
  const back = pressBack();
  const root = renderSurface(<Harness />);
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: 77, nativeEvent: {} }));
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS + 20));
  back();
  throughClose();
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS + 20));
  const restores = () => sent.mock.calls.filter(([tag]) => tag === 77);
  expect(restores()).toEqual([[77, { returning: true }]]);
  act(() => jest.advanceTimersByTime(3000));
  expect(restores()).toHaveLength(1);
  const others = sent.mock.calls.filter(([tag]) => tag !== 77);
  expect(others.every(([, options]) => options?.returning === false)).toBe(true);
  expect(revoked).not.toHaveBeenCalled();
  updateSurface(root, <Harness asking />);
  expect(revoked).toHaveBeenCalledTimes(1);
  updateSurface(root, <Harness />);
  unmount(root);
});

test("the dark confirmation sits on a darker card and pill than the iPhone's, with a lighter red, so its message and its 17-point button label both read at 4.5:1, where the iPhone's own are 2.5:1 and 1.5:1", () => {
  const { actionSheetInk } = require("../components/ui/tokens") as typeof import("../components/ui/tokens");
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
  };
  const dark = actionSheetInk.dark;
  expect(contrast(dark.message, dark.solid)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark.title, dark.solid)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark.destructive, dark.button)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark.title, dark.button)).toBeGreaterThanOrEqual(4.5);
  expect(luminance(dark.button)).toBeGreaterThan(luminance(dark.solid));
  expect(contrast("#C5C5C5", "#797979")).toBeLessThan(3);
  expect(contrast("#FF9B9C", "#959595")).toBeLessThan(2);
});

test("on Android a cancelled confirmation's restore already handed to the native side is revoked the moment a newer overlay opens; with no newer overlay it still lands", async () => {
  if (Platform.OS !== "android") return;
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const phoneNative = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const { ANDROID_FOCUS_DELAY_MS } = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  jest.spyOn(phoneNative, "screenReaderFocusIsNative").mockReturnValue(true);
  const revoked = jest.fn();
  const sent = jest.spyOn(phoneNative, "focusViewNatively").mockImplementation(() => revoked);
  let show: (which: "asking" | "other" | null) => void = () => undefined;
  function Harness() {
    const [which, setWhich] = useState<"asking" | "other" | null>("asking");
    show = setWhich;
    if (which === "asking") return <ConfirmSheet confirmation={{ title: "Clear Data?", message: "", action: "Clear Data", run: () => undefined, opener: 77 }} onClose={() => setWhich(null)} />;
    if (which === "other") return <ConfirmSheet confirmation={{ title: "Question", message: "", action: "Confirm", run: () => undefined }} onClose={() => setWhich(null)} />;
    return null;
  }
  const back = pressBack();
  const root = renderSurface(<Harness />);
  const toOpener = () => sent.mock.calls.filter(([tag]) => tag === 77).length;
  const cancelAndLand = async () => {
    back();
    throughClose();
    await act(async () => undefined);
    act(() => jest.advanceTimersByTime(ANDROID_FOCUS_DELAY_MS + 20));
  };
  await cancelAndLand();
  expect(toOpener()).toBe(1);
  expect(revoked).not.toHaveBeenCalled();
  act(() => show("other"));
  expect(revoked).toHaveBeenCalledTimes(1);
  act(() => show(null));
  throughClose();
  act(() => show("asking"));
  revoked.mockClear();
  await cancelAndLand();
  expect(toOpener()).toBe(2);
  act(() => jest.advanceTimersByTime(3000));
  expect(revoked).not.toHaveBeenCalled();
  unmount(root);
});

test("an open drawn menu carries a Fabric catch-up while its opening scale plays, so a press after it settles lands on the row Fabric knows about", () => {
  const root = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={() => undefined} />);
  expect(root.root.findAll((node) => node.props.testID === "menuFabricCatchUp" && typeof node.type === "string")).toHaveLength(1);
  unmount(root);
});

test("the Material You menu carries the same Fabric catch-up while its opening motion plays", () => {
  const { DesignProvider } = require("../components/ui/design") as typeof import("../components/ui/design");
  const root = renderSurface(
    <DesignProvider design="material">
      <Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={() => undefined} />
    </DesignProvider>,
  );
  expect(root.root.findAll((node) => node.props.testID === "materialMenu" && typeof node.type === "string")).toHaveLength(1);
  expect(root.root.findAll((node) => node.props.testID === "menuFabricCatchUp" && typeof node.type === "string")).toHaveLength(1);
  unmount(root);
});
