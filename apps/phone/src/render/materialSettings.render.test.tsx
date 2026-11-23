import { Platform, ScrollView, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { SettingsView } from "../components/settings/SettingsView";
import { materialAppBarFill } from "../components/settings/MaterialSettingsKit";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as settingsActions from "../state/settings/actions";
import { closeSettings, openSettings, pushSettings, useSettingsNav } from "../state/settings/nav";
import { currentPreferences, loadPreferences, setPreference } from "../state/settings/store";
import { classicOnAndroid, renderSurface, unmount, withTabs, withMaterialYou } from "../../test/render/harness";
import { pages } from "../platform/pages";
import { closeArchive, openArchive } from "../state/browse/store";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  setDynamicScheme(null);
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  openSettings();
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function" && found.props.android_ripple !== undefined)[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const settings = () =>
  renderSurface(
    <DesignProvider design="material">
      <Surfaces />
    </DesignProvider>,
  );

type Detected = { toGestureArray?: () => { config: { testId?: string; enabled?: boolean } }[] };
const sheetDragEnabled = (root: Root) =>
  root.root
    .findAll((found) => typeof (found.props.gesture as Detected | undefined)?.toGestureArray === "function")
    .flatMap((found) => (found.props.gesture as Required<Detected>).toGestureArray())
    .filter((gesture) => gesture.config.testId === "fullSheetDrag")
    .map((gesture) => gesture.config.enabled !== false)
    .pop();

onAndroid("Material Settings fills the screen with a 112 dp medium top app bar, no sheet gap, corners or drag", () => {
  const root = settings();
  expect(flat(node(root, "fullSheet"))).toMatchObject({ top: 0, left: 0, right: 0, bottom: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, backgroundColor: LIGHT.surfaceContainer });
  expect(node(root, "fullSheet")!.props.accessibilityViewIsModal).toBe(true);
  expect(sheetDragEnabled(root)).toBe(false);
  expect(flat(node(root, "materialSettingsPage")).backgroundColor).toBe(LIGHT.surfaceContainer);
  const bar = node(root, "materialTopAppBar")!;
  expect(flat(bar)).toMatchObject({ paddingTop: 40, backgroundColor: LIGHT.surfaceContainer });
  expect(flat(bar.findAll((found) => typeof found.type === "string" && flat(found).minHeight === 64)[0])).toMatchObject({ minHeight: 64 });
  expect(flat(node(root, "materialMediumTitle"))).toMatchObject({ height: 48, fontSize: 28, color: LIGHT.onSurface });
  expect(node(root, "settingsTitle")!.props.children).toBeNull();
  const row = node(root, "materialSettingsRow:Search Engine")!;
  expect(flat(row).minHeight).toBeGreaterThanOrEqual(56);
  expect(pressable(root, "materialSettingsRow:Search Engine").props.android_ripple).toMatchObject({ borderless: false });
  expect(row.findAll((found) => found.props.name === "chevronRight")).toHaveLength(0);
  expect(flat(node(root, "materialSettingsIconSlot"))).toMatchObject({ width: 24, height: 24 });
  expect(row.findAll((found) => found.props.name === "magnifyingglass")[0]?.props.color).toBe(LIGHT.onSurfaceVariant);
  unmount(root);
});

onAndroid("the app bar takes surfaceContainerHigh once the list scrolls under it, as Material's top app bar does", () => {
  const root = settings();
  const list = node(root, "materialSettingsPage")!.findAll((found) => found.type === ScrollView)[0]!;
  act(() => list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 80 } } }));
  expect(flat(node(root, "materialTopAppBar")).backgroundColor).toBe(LIGHT.surfaceContainerHigh);
  expect(node(root, "settingsTitle")!.props.children).toBe("Settings");
  expect(flat(node(root, "settingsTitle"))).toMatchObject({ fontSize: 22 });
  act(() => list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } }));
  expect(node(root, "settingsTitle")!.props.children).toBeNull();
  expect(flat(node(root, "materialTopAppBar")).backgroundColor).toBe(LIGHT.surfaceContainer);
  expect(materialAppBarFill(LIGHT, false)).toBe(LIGHT.surfaceContainer);
  unmount(root);
});

onAndroid("Archive keeps the Material bottom sheet, with its top gap, corners and drag", () => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  act(() => openArchive());
  const root = settings();
  const sheet = flat(node(root, "fullSheet"));
  expect(sheet.top).toBe(40);
  expect(sheet.borderTopLeftRadius).toBe(28);
  expect(sheetDragEnabled(root)).toBe(true);
  act(() => closeArchive());
  unmount(root);
});

onAndroid("groups are Material 3 Expressive: rows as surfaceBright segments 2 dp apart, 20 dp outer corners and 4 dp inner ones, and no dividers", () => {
  const root = settings();
  expect(root.root.findAll((found) => found.props.testID === "materialSettingsDivider")).toHaveLength(0);
  const group = root.root.findAll((found) => found.props.testID === "materialSettingsGroup" && typeof found.type === "string" && found.findAll((inner) => inner.props.testID === "materialSettingsSegment" && typeof inner.type === "string").length > 2)[0]!;
  const segments = group.findAll((found) => found.props.testID === "materialSettingsSegment" && typeof found.type === "string");
  expect(flat(segments[0])).toMatchObject({ borderTopLeftRadius: 20, borderBottomLeftRadius: 4, backgroundColor: LIGHT.surfaceBright });
  expect(flat(segments[1])).toMatchObject({ borderTopLeftRadius: 4, borderBottomLeftRadius: 4 });
  expect(flat(segments.at(-1))).toMatchObject({ borderTopLeftRadius: 4, borderBottomLeftRadius: 20 });
  unmount(root);
});

onAndroid("switch rows are one switch for TalkBack with a Material switch inside, and a tap anywhere flips them", () => {
  const set = jest.spyOn(settingsActions, "setSearchSuggestions").mockImplementation(() => undefined as never);
  const root = settings();
  const row = pressable(root, "materialSettingsRow:Search Suggestions");
  expect(row.props.accessibilityRole).toBe("switch");
  expect(row.findAll((found) => found.props.testID === "materialSwitch" && typeof found.type === "string")).toHaveLength(1);
  const checked = row.props.accessibilityState.checked;
  act(() => {
    row.props.onPress();
  });
  expect(set).toHaveBeenCalledWith(!checked);
  unmount(root);
});

onAndroid("Dynamic Colors switches immediately between wallpaper and a saved custom color and survives reloading preferences", () => {
  setDynamicScheme(SEEDED_SCHEMES.green);
  setPreference("colorChoice", "blue");
  setPreference("dynamicColors", true);
  const root = settings();
  const toggle = () => pressable(root, "materialSettingsRow:Dynamic Colors");
  expect(toggle().props.accessibilityState.checked).toBe(true);
  expect(flat(node(root, "materialSettingsPage")).backgroundColor).toBe(SEEDED_SCHEMES.green.light.surfaceContainer);
  expect(root.root.findAll((found) => found.props.accessibilityRole === "radio")).toHaveLength(0);
  act(() => toggle().props.onPress());
  expect(flat(node(root, "materialSettingsPage")).backgroundColor).toBe(SEEDED_SCHEMES.blue.light.surfaceContainer);
  expect(root.root.findAll((found) => found.props.accessibilityRole === "radio").length).toBeGreaterThan(0);
  act(() => loadPreferences());
  expect(currentPreferences().dynamicColors).toBe(false);
  expect(currentPreferences().colorChoice).toBe("blue");
  act(() => toggle().props.onPress());
  expect(flat(node(root, "materialSettingsPage")).backgroundColor).toBe(SEEDED_SCHEMES.green.light.surfaceContainer);
  expect(currentPreferences().colorChoice).toBe("blue");
  unmount(root);
});

onAndroid("a picker row shows its choice as supporting text and opens a Material dialog with a radio list; picking closes it and applies", () => {
  const set = jest.spyOn(settingsActions, "setArchiveInterval").mockImplementation(() => undefined as never);
  const root = settings();
  act(() => {
    pressable(root, "materialSettingsRow:Archive Inactive Tabs").props.onPress();
  });
  expect(node(root, "materialDialog")).toBeDefined();
  const radios = node(root, "materialRadioList")!.findAll((found) => typeof found.type === "string" && found.props.accessibilityRole === "radio");
  expect(radios.length).toBeGreaterThan(1);
  expect(radios.filter((radio) => radio.props.accessibilityState.selected)).toHaveLength(1);
  const other = radios.find((radio) => !radio.props.accessibilityState.selected)!;
  for (const radio of radios) expect(flat(radio).minHeight).toBeGreaterThanOrEqual(48);
  act(() => {
    pressable(root, other.props.testID).props.onPress();
  });
  expect(set).toHaveBeenCalledTimes(1);
  expect(node(root, "materialDialog")).toBeUndefined();
  unmount(root);
});

onAndroid("a pushed page carries a 48 dp back arrow in the app bar", () => {
  act(() => pushSettings({ page: "about" }));
  const root = settings();
  expect(useSettingsNav.getState().stack.length).toBe(2);
  expect(flat(node(root, "materialSettingsBack"))).toMatchObject({ width: 48, height: 48 });
  expect(pressable(root, "materialSettingsBack").props.android_ripple).toMatchObject({ borderless: true });
  unmount(root);
});

onAndroid("the original design's Settings are untouched by the Material one", () => {
  const root = renderSurface(classicOnAndroid(<SettingsView />));
  expect(node(root, "materialSettingsPage")).toBeUndefined();
  expect(node(root, "materialSwitch")).toBeUndefined();
  unmount(root);
});

onAndroid("Settings closes from a close icon at the start of its top app bar, with no iPhone Done", () => {
  const closing = jest.spyOn(require("../state/settings/nav"), "closeSettings");
  const root = settings();
  expect(root.root.findAll((found) => found.props.children === "Done")).toHaveLength(0);
  expect(flat(node(root, "materialSettingsClose"))).toMatchObject({ width: 48, height: 48 });
  act(() => {
    pressable(root, "materialSettingsClose").props.onPress();
  });
  expect(closing).toHaveBeenCalled();
  unmount(root);
});

onAndroid("Collapse Bottom Bar in Material Site Settings starts on by default and persists turning off", () => {
  setPreference("collapsesBottomBar", null);
  act(() => pushSettings({ page: "siteSettings" }));
  const root = settings();
  const row = () => pressable(root, "materialSettingsRow:Collapse Bottom Bar");
  expect(row().props.accessibilityState.checked).toBe(true);
  act(() => row().props.onPress());
  expect(row().props.accessibilityState.checked).toBe(false);
  expect(currentPreferences().collapsesBottomBar).toBe(false);
  setPreference("collapsesBottomBar", null);
  unmount(root);
});
