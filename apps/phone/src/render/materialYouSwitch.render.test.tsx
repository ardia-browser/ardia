import { Platform, ScrollView, StyleSheet, Text } from "react-native";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle, LayoutAnimationConfig } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { DesignProvider, Portal, useDesign } from "../components/ui";
import * as coverFocus from "../components/ui/coverFocus";
import * as settingsReveal from "../components/settings/settingsReveal";
import { SettingsView } from "../components/settings/SettingsView";
import { MaterialBottomBar } from "../components/ui/MaterialBottomBar";
import { pages } from "../platform/pages";
import { closeArchive, markSheetFromSettings, openArchive, openSpaces, useBrowse } from "../state/browse/store";
import { handleSystemBack } from "../state/page/actions";
import { closeSettings, openSettings, pushSettings, settingsScroll, useSettingsNav } from "../state/settings/nav";
import { currentPreferences, usePreferences } from "../state/settings/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, textOf, unmount, updateSurface, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const onIPhone = Platform.OS === "ios" ? test : test.skip;

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  usePreferences.setState({ materialYou: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null, veiled: null });
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  usePreferences.setState({ materialYou: false });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const materialYouRow = (root: Root): ReactTestInstance | undefined =>
  root.root.findAll((node) => node.props.accessibilityLabel === "Material You" && node.props.accessibilityRole === "switch" && typeof node.props.onPress === "function")[0];
const materialBars = (root: Root) => root.root.findAll((node) => node.type === MaterialBottomBar);
const fullSheet = (root: Root) => root.root.findAll((node) => node.props.testID === "fullSheet" && typeof node.type === "string")[0]!;
const hostById = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};
const settle = () => {
  for (let frame = 0; frame < 30; frame++) act(() => jest.advanceTimersByTime(16));
};

const settingButton = (root: Root, label: string) =>
  root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!;

onAndroid("Material You is off by default and the switch lives in Appearance", () => {
  expect(currentPreferences().materialYou).toBe(false);
  const root = renderSurface(<Surfaces />);
  expect(materialBars(root)).toHaveLength(0);
  act(() => openSettings());
  settle();
  expect(materialYouRow(root)).toBeUndefined();
  act(() => settingButton(root, "Appearance").props.onPress());
  expect(materialYouRow(root)?.props.accessibilityState).toMatchObject({ checked: false });
  expect(textOf(root)).not.toContain("Dynamic Colors");
  unmount(root);
});

const materialPages = (root: Root) => root.root.findAll((node) => node.props.testID === "materialSettingsPage" && typeof node.type === "string");
const settingsList = (root: Root) => hostById(root, "settingsPage")!.findAll((node) => node.type === ScrollView)[0]!;

onAndroid("turning Material You on in Appearance makes Settings the full-screen Material page in place, and turning it off brings the iPhone sheet back; each flip is counted", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  act(() => settingButton(root, "Appearance").props.onPress());
  const sheet = fullSheet(root);
  const sheetTop = flat(sheet).top as number;
  expect(sheetTop).toBeGreaterThan(40);
  expect(materialPages(root)).toHaveLength(0);
  const scroll = settingsList(root);
  act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } }));

  act(() => materialYouRow(root)!.props.onPress());
  expect(fullSheet(root)).toBe(sheet);
  expect(flat(sheet)).toMatchObject({ top: 0, left: 0, right: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 });
  expect(getAnimatedStyle(sheet)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
  settle();
  expect(getAnimatedStyle(sheet)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
  expect(useSettingsNav.getState().stack).toEqual([{ page: "root" }, { page: "appearance" }]);
  expect(settingsList(root)).toBe(scroll);
  expect(settingsScroll("Appearance")).toBe(100);
  expect(materialPages(root)).toHaveLength(1);
  expect(hostById(root, "materialTopAppBar")).toBeDefined();
  expect(materialYouRow(root)!.props.accessibilityState.checked).toBe(true);
  expect(currentPreferences().materialYou).toBe(true);
  expect(materialBars(root)).toHaveLength(1);
  expect(counted).toHaveBeenCalledWith("material_you_turned_on");

  act(() => materialYouRow(root)!.props.onPress());
  expect(fullSheet(root)).toBe(sheet);
  expect(flat(sheet).top).toBe(sheetTop);
  expect(getAnimatedStyle(sheet)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
  settle();
  expect(getAnimatedStyle(sheet)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
  expect(useSettingsNav.getState().stack).toEqual([{ page: "root" }, { page: "appearance" }]);
  expect(settingsList(root)).toBe(scroll);
  expect(materialPages(root)).toHaveLength(0);
  expect(materialYouRow(root)!.props.accessibilityState.checked).toBe(false);
  expect(currentPreferences().materialYou).toBe(false);
  expect(materialBars(root)).toHaveLength(0);
  expect(counted).toHaveBeenCalledWith("material_you_turned_off");

  act(() => void handleSystemBack());
  expect(hostById(root, "settingsTitle")!.props.children).toBe("Settings");
  expect(settingButton(root, "Appearance")).toBeDefined();
  expect(materialYouRow(root)).toBeUndefined();
  unmount(root);
});

const paneRows = (root: Root) => ["General", "Tabs", "Appearance", "Search", "Site settings"].map((pane) => settingButton(root, pane));

onAndroid("with Material You on, Settings opens as the Material page of the same pane list, the switch is only in Appearance, and turning it off there keeps the page", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const sheet = fullSheet(root);
  expect(flat(sheet).top).toBe(0);
  expect(materialPages(root)).toHaveLength(1);
  for (const row of paneRows(root)) expect(row).toBeDefined();
  expect(materialYouRow(root)).toBeUndefined();
  act(() => settingButton(root, "Appearance").props.onPress());
  expect(materialYouRow(root)!.props.accessibilityState.checked).toBe(true);
  const scroll = settingsList(root);
  act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));

  act(() => materialYouRow(root)!.props.onPress());
  settle();
  expect(fullSheet(root)).toBe(sheet);
  expect(flat(sheet).top).toBeGreaterThan(40);
  expect(getAnimatedStyle(sheet)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
  expect(useSettingsNav.getState().stack).toEqual([{ page: "root" }, { page: "appearance" }]);
  expect(settingsList(root)).toBe(scroll);
  expect(settingsScroll("Appearance")).toBe(120);
  expect(materialPages(root)).toHaveLength(0);
  expect(materialYouRow(root)!.props.accessibilityState.checked).toBe(false);
  expect(currentPreferences().materialYou).toBe(false);
  expect(counted).toHaveBeenCalledWith("material_you_turned_off");
  act(() => void handleSystemBack());
  for (const row of paneRows(root)) expect(row).toBeDefined();
  expect(materialYouRow(root)).toBeUndefined();
  unmount(root);
});

onAndroid("a Material You flip swaps Settings' rows without their entering or exiting animations, inside the same scroll view, and leaves later scrolls alone", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  act(() => pushSettings({ page: "appearance" }));
  const content = () => settingsList(root).findAll((node) => node.props.testID === "settingsPageContent" && typeof node.type === "string")[0]!;
  const config = () => settingsList(root).findAll((node) => node.type === LayoutAnimationConfig)[0]!;
  const list = settingsList(root);
  const before = content();
  const beforeConfig = config();
  expect(beforeConfig.props).toMatchObject({ skipEntering: true, skipExiting: true });
  act(() => list.props.onScroll({ nativeEvent: { contentOffset: { y: 60 } } }));
  expect(content()).toBe(before);
  act(() => materialYouRow(root)!.props.onPress());
  settle();
  expect(settingsList(root)).toBe(list);
  expect(config()).not.toBe(beforeConfig);
  expect(config().props).toMatchObject({ skipEntering: true, skipExiting: true });
  expect(content()).not.toBe(before);
  expect(settingsScroll("Appearance")).toBe(60);
  const flipped = content();
  act(() => list.props.onScroll({ nativeEvent: { contentOffset: { y: 90 } } }));
  expect(content()).toBe(flipped);
  unmount(root);
});

onAndroid("a Material You flip during Settings' entrance lands the new frame instead of jumping to a part-way slide", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  act(() => openSettings());
  act(() => jest.advanceTimersByTime(48));
  const sheet = fullSheet(root);
  expect((getAnimatedStyle(sheet) as { opacity: number }).opacity).toBeLessThan(1);
  act(() => usePreferences.setState({ materialYou: false }));
  act(() => jest.advanceTimersByTime(16));
  expect(getAnimatedStyle(fullSheet(root))).toMatchObject({ transform: [{ translateY: 0 }] });
  unmount(root);
});

const revealsWith = (y: number) => {
  const actualReveal = settingsReveal.revealInList;
  const scrolledTo: unknown[] = [];
  const reveal = jest.spyOn(settingsReveal, "revealInList").mockImplementation((frame, target) => {
    const list = frame.list as unknown as { getInnerViewRef: () => unknown; scrollTo: jest.Mock };
    list.getInnerViewRef = () => ({});
    list.scrollTo.mockImplementation((to: unknown) => void scrolledTo.push(to));
    (target as unknown as { measureLayout: (relative: unknown, onSuccess: (x: number, y: number, width: number, height: number) => void) => void }).measureLayout = (_relative, onSuccess) => onSuccess(0, y, 393, 72);
    actualReveal(frame, target);
  });
  return { reveal, scrolledTo };
};

onAndroid("each Material You flip in Appearance brings the replacement switch into the list's view before focusing it", () => {
  const { reveal, scrolledTo } = revealsWith(40);
  const focus = jest.spyOn(coverFocus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const root = renderSurface(<Surfaces />);
  act(() => openSettings({ page: "appearance" }));
  settle();
  const list = settingsList(root);
  act(() => list.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 700 } } }));
  act(() => list.props.onScroll({ nativeEvent: { contentOffset: { y: 260 } } }));
  for (const enabled of [true, false]) {
    reveal.mockClear();
    focus.mockClear();
    scrolledTo.length = 0;
    act(() => materialYouRow(root)!.props.onPress());
    settle();
    expect(currentPreferences().materialYou).toBe(enabled);
    expect(reveal).toHaveBeenCalledTimes(1);
    const [frame, target] = reveal.mock.calls[0]!;
    expect(frame).toMatchObject({ scrollY: 260, viewport: 700 });
    expect(target).not.toBeNull();
    expect(scrolledTo).toEqual([{ y: 40, animated: false }]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.calls[0]![0]()).toBe(target);
    expect(reveal.mock.invocationCallOrder[0]!).toBeLessThan(focus.mock.invocationCallOrder[0]!);
  }
  unmount(root);
});

onIPhone("iPhone Appearance has no Material You switch", () => {
  openSettings({ page: "appearance" });
  const root = renderSurface(<SettingsView />);
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.title === "Interface style")).toHaveLength(1);
  expect(materialYouRow(root)).toBeUndefined();
  unmount(root);
});

onAndroid("rapid Material You flips and dismissal leave the browser in the final design", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  act(() => {
    usePreferences.setState({ materialYou: true });
    usePreferences.setState({ materialYou: false });
    usePreferences.setState({ materialYou: true });
    closeSettings();
  });
  settle();
  expect(materialBars(root)).toHaveLength(1);
  act(() => {
    openSettings();
    usePreferences.setState({ materialYou: false });
    closeSettings();
  });
  settle();
  expect(materialBars(root)).toHaveLength(0);
  unmount(root);
});

test("a menu portal retains its opening design through its exit", () => {
  function DesignLabel() {
    return <Text testID="portalDesign">{useDesign()}</Text>;
  }
  const root = renderSurface(<DesignProvider design="material"><Portal exitMs={200}><DesignLabel /></Portal></DesignProvider>);
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")[0]!.props.children).toBe("material");
  updateSurface(root, <DesignProvider design="redesigned">{null}</DesignProvider>);
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")[0]!.props.children).toBe("material");
  act(() => jest.advanceTimersByTime(400));
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")).toHaveLength(0);
  unmount(root);
});

onAndroid("Archive opened from full-screen Material Settings slides up as a sheet instead of appearing in place", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  for (let pass = 0; pass < 4; pass++) settle();
  const sheet = fullSheet(root);
  expect(getAnimatedStyle(sheet)).toMatchObject({ transform: [{ translateY: 0 }] });
  act(() => {
    closeSettings();
    openArchive();
  });
  act(() => jest.advanceTimersByTime(16));
  const entering = getAnimatedStyle(fullSheet(root)) as { transform: [{ translateY: number }] };
  expect(entering.transform[0].translateY).toBeGreaterThan(200);
  for (let pass = 0; pass < 4; pass++) settle();
  expect(getAnimatedStyle(fullSheet(root))).toMatchObject({ transform: [{ translateY: 0 }] });
  act(() => useBrowse.setState({ sheet: null }));
  unmount(root);
});

for (const [name, open] of [["Archive", openArchive], ["Spaces", openSpaces]] as const) {
  onAndroid(`Back from ${name} opened in Material Settings brings Settings back opaque and in place`, () => {
    usePreferences.setState({ materialYou: true });
    const root = renderSurface(<Surfaces />);
    act(() => openSettings());
    for (let pass = 0; pass < 4; pass++) settle();
    act(() => {
      closeSettings();
      open();
      markSheetFromSettings();
    });
    for (let pass = 0; pass < 4; pass++) settle();
    expect(getAnimatedStyle(fullSheet(root))).toMatchObject({ transform: [{ translateY: 0 }] });
    act(() => void handleSystemBack());
    expect(materialPages(root)).toHaveLength(1);
    for (let frame = 0; frame < 20; frame++) {
      act(() => jest.advanceTimersByTime(16));
      expect(getAnimatedStyle(fullSheet(root))).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
    }
    act(() => {
      closeSettings();
      closeArchive();
    });
    unmount(root);
  });
}

onAndroid("reopening Settings during dismissal starts a fresh scroll view at the top", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const settingsList = () => root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!;
  const previous = settingsList();
  act(() => previous.props.onScroll({ nativeEvent: { contentOffset: { y: 240 } } }));
  expect(settingsScroll("Settings")).toBe(240);
  act(() => closeSettings());
  act(() => openSettings());
  expect(settingsList()).not.toBe(previous);
  expect(settingsList().props.contentOffset).toEqual({ x: 0, y: 0 });
  unmount(root);
});

type DragHandlers = { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void; onTouchesMove: (event: unknown, manager: unknown) => void } };

const dragsFromList = () => {
  const drag = getByGestureTestId("fullSheetDrag") as unknown as DragHandlers;
  const verdict = { activated: false, failed: false };
  const manager = { activate: () => void (verdict.activated = true), fail: () => void (verdict.failed = true), end: () => undefined, begin: () => undefined };
  const at = (y: number) => ({ id: 0, x: 200, y, absoluteX: 200, absoluteY: y });
  act(() => {
    drag.handlers.onTouchesDown({ allTouches: [at(400)], changedTouches: [at(400)] }, manager);
    drag.handlers.onTouchesMove({ allTouches: [at(440)], changedTouches: [at(440)] }, manager);
  });
  return verdict;
};

onAndroid("a final scroll event from the exiting Settings cannot seed the newly opened page or block dragging the sheet down from its list", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const settingsList = () => root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!;
  const exitingOnScroll = settingsList().props.onScroll;
  act(() => exitingOnScroll({ nativeEvent: { contentOffset: { y: 240 } } }));
  expect(dragsFromList()).toEqual({ activated: false, failed: true });
  act(() => closeSettings());
  act(() => openSettings());
  act(() => exitingOnScroll({ nativeEvent: { contentOffset: { y: 265 } } }));
  settle();
  expect(settingsList().props.contentOffset).toEqual({ x: 0, y: 0 });
  expect(settingsScroll("Settings")).toBe(0);
  expect(dragsFromList()).toEqual({ activated: true, failed: false });
  const currentOnScroll = settingsList().props.onScroll;
  act(() => currentOnScroll({ nativeEvent: { contentOffset: { y: 90 } } }));
  expect(settingsScroll("Settings")).toBe(90);
  expect(dragsFromList()).toEqual({ activated: false, failed: true });
  unmount(root);
});
