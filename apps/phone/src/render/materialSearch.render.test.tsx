import { Dimensions, Platform, StyleSheet, Text } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { materialSearchFocusDelay, materialSearchMs } from "../components/search/MaterialSearchView";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import { history } from "../state/history/store";
import { dismissSearch, presentSearch, searchState, typeSearch } from "../state/search/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { useTabs } from "../state/tabs/store";
import { currentPreferences, setPreference } from "../state/settings/store";
import { renderSurface, textOf, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;
let revision = 5000;

beforeEach(() => {
  jest.useFakeTimers();
  revision += 1;
  jest.spyOn(history(), "summary").mockImplementation(() => [
    { url: "https://www.google.com/search?q=otters", title: "otters - Google Search", favicon: null, visits: 3, lastVisit: 1 },
    { url: "https://www.google.com/search?q=sintra", title: "sintra - Google Search", favicon: null, visits: 2, lastVisit: 2 },
  ]);
  jest.spyOn(history(), "revision").mockImplementation(() => revision);
  withTabs(2);
  setDynamicScheme(null);
  act(() => {
    browse.useBrowse.setState({ surface: "start" });
    useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } as never }));
  });
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function")[0]!;
const closeSearch = (root: Root) => root.root.findAll((found) => found.props.accessibilityLabel === "Close Search" && typeof found.props.onPress === "function")[0]!.props.onPress();
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const tray = () =>
  renderSurface(
    <DesignProvider design="material">
      <SearchTray />
    </DesignProvider>,
  );

onAndroid("the Material search capsule uses the same docked sheet as the page menu", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  expect(flat(node(root, "materialSheet"))).toMatchObject({
    backgroundColor: LIGHT.surfaceContainerLow,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  });
  expect(node(root, "materialDragHandle")).toBeDefined();
  expect(node(root, "materialSheetDockedBar")).toHaveAnimatedStyle({ left: 16, right: 16, bottom: 40 });
  expect(flat(node(root, "materialSheetDockedBar"))).toMatchObject({ height: 48, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainerHigh });
  expect(flat(node(root, "materialSearchBar"))).toMatchObject({
    height: 48,
  });
  expect(flat(node(root, "materialSearchBar")).backgroundColor).toBeUndefined();
  expect(flat(node(root, "materialSearchBox"))).toMatchObject({
    height: 48,
  });
  expect(flat(node(root, "materialSearchBox")).backgroundColor).toBeUndefined();
  expect(node(root, "materialSearchBox")!.findAll((found) => found.props.testID === "materialSearchIncognito").length).toBeGreaterThan(0);
  expect(flat(node(root, "materialSearchIncognito"))).toMatchObject({ width: 48, height: 48 });
  expect(pressable(root, "materialSearchIncognito").props.android_ripple).toMatchObject({ borderless: true });
  const field = root.root.findAll((found) => found.props.accessibilityLabel === "Search or Enter Address" && typeof found.type === "string")[0]!;
  expect(flat(field)).toMatchObject({ height: 48, flex: 1 });
  act(() => typeSearch("site"));
  act(() => jest.advanceTimersByTime(50));
  expect(textOf(root)).toContain("Site 1");
  expect(node(root, "materialSearchRows")).toBeDefined();
  expect(node(root, "materialSearchResults")).toBeDefined();
  const group = node(root, "materialSearchGroup")!;
  const segments = group.findAll((found) => found.props.testID === "materialSearchSegment" && typeof found.type === "string");
  expect(segments.length).toBeGreaterThan(2);
  expect(flat(segments[0])).toMatchObject({ borderTopLeftRadius: 20, borderBottomLeftRadius: 4 });
  expect(flat(segments[0]).backgroundColor).toBeUndefined();
  expect(flat(segments[1])).toMatchObject({ borderTopLeftRadius: 4, borderBottomLeftRadius: 4 });
  expect(flat(segments.at(-1))).toMatchObject({ borderTopLeftRadius: 4, borderBottomLeftRadius: 20 });
  expect(flat(node(root, "materialSearchIconSlot"))).toMatchObject({ width: 20, height: 20 });
  unmount(root);
});

onAndroid("the expanded field lands in the sheet header with results visible below it and closes cleanly", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  const bar = node(root, "materialSheetDockedBar")!;
  act(() => jest.advanceTimersByTime(400));
  expect(bar).toHaveAnimatedStyle({ left: 16, transform: [{ translateY: -228 }] });
  act(() => closeSearch(root));
  expect(node(root, "materialSheet")).toBeDefined();
  act(() => jest.advanceTimersByTime(400));
  expect(node(root, "materialSheet")).toBeUndefined();
  unmount(root);
});

onAndroid("hiding or shortening the keyboard leaves the search field and sheet in place and frees space for results", () => {
  const keyboard = { height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) };
  jest.spyOn(Reanimated, "useAnimatedKeyboard").mockReturnValue(keyboard);
  act(() => presentSearch("start", ""));
  const root = tray();
  const sheet = node(root, "materialSheet")!;
  const bar = node(root, "materialSheetDockedBar")!;
  act(() => { keyboard.height.value = 300; });
  act(() => jest.advanceTimersByTime(400));
  const raisedHeight = getAnimatedStyle(sheet).height;
  const raisedTransform = getAnimatedStyle(bar).transform;
  expect(raisedHeight).toBe(640);
  for (const next of [180, 0, 300, 0]) {
    act(() => { keyboard.height.value = next; });
    act(() => jest.advanceTimersByTime(400));
    expect(getAnimatedStyle(sheet).height).toBe(raisedHeight);
    expect(getAnimatedStyle(bar).transform).toEqual(raisedTransform);
  }
  expect(sheet).toHaveAnimatedStyle({ paddingBottom: 32 });
  expect(searchState().open).toBe(true);
  unmount(root);
});

onAndroid("in landscape the sheet grows past its top bar room so the search field sits wholly above the keyboard", () => {
  const portrait = Dimensions.get("window");
  const landscape = { width: 873, height: 393 };
  Dimensions.set({ window: { ...portrait, ...landscape }, screen: { ...portrait, ...landscape } });
  const keyboard = { height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) };
  jest.spyOn(Reanimated, "useAnimatedKeyboard").mockReturnValue(keyboard);
  act(() => presentSearch("start", ""));
  const root = tray();
  const sheet = node(root, "materialSheet")!;
  act(() => { keyboard.height.value = 248; });
  act(() => jest.advanceTimersByTime(400));
  expect(getAnimatedStyle(sheet).height).toBeGreaterThanOrEqual(248 + 48 + 48 + 8);
  expect(getAnimatedStyle(sheet).height).toBeLessThanOrEqual(393);
  unmount(root);
  Dimensions.set({ window: portrait, screen: portrait });
});

onAndroid.each([["start", 24], ["browsing", 80], ["deck", 80]] as const)("search returns to the %s bar with the menu's timing and morphs into the resting contents before removal", (surface, side) => {
  act(() => {
    browse.useBrowse.setState({ surface });
    presentSearch("start", "");
  });
  const root = tray();
  const bar = node(root, "materialSheetDockedBar")!;
  act(() => node(root, "materialSearchEditing")!.props.onLayout({ nativeEvent: { layout: { width: 360 } } }));
  act(() => closeSearch(root));
  act(() => jest.advanceTimersByTime(100));
  const moving = getAnimatedStyle(bar) as { left: number; transform: [{ translateY: number }] };
  expect(moving.left).toBe(16);
  expect(moving.transform[0].translateY).toBeLessThan(0);
  expect(node(root, "materialSearchEditing")!).toHaveAnimatedStyle({ opacity: 1 });
  expect(flat(node(root, "materialSearchEditing")).width).toBe(360);
  expect(node(root, "materialSearchLanding")!).toHaveAnimatedStyle({ opacity: 0 });
  act(() => jest.advanceTimersByTime(100));
  const landing = getAnimatedStyle(bar) as { left: number; transform: [{ translateY: number }] };
  expect(landing.left).toBeGreaterThan(moving.left);
  expect(landing.left).toBeLessThanOrEqual(side);
  expect(landing.transform[0].translateY).toBe(0);
  expect(getAnimatedStyle(node(root, "materialSearchLanding")!).opacity).toBeGreaterThan(0);
  expect(getAnimatedStyle(node(root, "materialSearchEditing")!).opacity).toBeLessThan(1);
  act(() => jest.advanceTimersByTime(150));
  expect(node(root, "materialSheetDockedBar")).toBeUndefined();
  unmount(root);
});

onAndroid("swiping up expands search to the whole screen, down returns to the sheet, then down dismisses", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  const height = Dimensions.get("window").height;
  const sheet = node(root, "materialSheet")!;
  const layout = (size: number) => act(() => sheet.props.onLayout({ nativeEvent: { layout: { height: size } } }));
  const swipe = (translationY: number) => act(() => fireGestureHandler(getByGestureTestId("sheetDrag"), [
    { state: State.BEGAN, translationY: 0, velocityY: 0 },
    { state: State.ACTIVE, translationY: 0, velocityY: 0 },
    { state: State.ACTIVE, translationY, velocityY: 0 },
    { state: State.END, translationY, velocityY: 0 },
  ]));
  const settle = () => act(() => jest.advanceTimersByTime(400));
  layout(364);
  swipe(-180);
  settle();
  expect(searchState().open).toBe(true);
  expect(sheet).toHaveAnimatedStyle({ height, paddingTop: 40, borderTopLeftRadius: 0 });
  expect(node(root, "materialSheetDockedBar")!).toHaveAnimatedStyle({ transform: [{ translateY: -(height - 176) }] });
  layout(height);
  swipe(180);
  settle();
  expect(searchState().open).toBe(true);
  expect(sheet).toHaveAnimatedStyle({ height: 364, paddingTop: 0, borderTopLeftRadius: 28 });
  layout(364);
  swipe(180);
  settle();
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(400));
  unmount(root);
});

onAndroid("tapping the scrim during expansion closes search and the sheet leaves before it unmounts", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  act(() => closeSearch(root));
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(1000));
  expect(node(root, "materialSheet")).toBeUndefined();
  unmount(root);
});

onAndroid.each(["light", "dark"] as const)("in Incognito search stays dark with %s appearance", (appearance) => {
  const previous = currentPreferences().schemeChoice;
  act(() => setPreference("schemeChoice", appearance));
  act(() => useTabs.setState({ incognito: true }));
  act(() => presentSearch("start", ""));
  const root = tray();
  expect(flat(node(root, "materialSheet")).backgroundColor).toBe("#000000");
  expect(flat(node(root, "materialSearchBar")).backgroundColor).toBeUndefined();
  expect(flat(node(root, "materialSheetDockedBar")).backgroundColor).toBe("#000000");
  expect(flat(node(root, "materialSearchIncognitoNote")).backgroundColor).toBe("#000000");
  expect(root.root.findAll((found) => found.type === Text).some((found) => found.props.children === "You\u2019re browsing Incognito")).toBe(true);
  expect(pressable(root, "materialSearchIncognito").props.accessibilityState).toEqual({ selected: true });
  unmount(root);
  act(() => setPreference("schemeChoice", previous));
  act(() => useTabs.setState({ incognito: false }));
});

onAndroid("a wallpaper scheme change re-themes the search capsule and suggestions", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  act(() => {
    setDynamicScheme({ light: SEEDED_SCHEMES.red.light, dark: SEEDED_SCHEMES.red.dark });
    typeSearch("site");
  });
  act(() => jest.advanceTimersByTime(50));
  expect(flat(node(root, "materialSheet")).backgroundColor).toBe(SEEDED_SCHEMES.red.light.surfaceContainerLow);
  expect(flat(node(root, "materialSearchBar")).backgroundColor).toBeUndefined();
  expect(flat(node(root, "materialSheetDockedBar")).backgroundColor).toBe(SEEDED_SCHEMES.red.light.surfaceContainerHigh);
  expect(flat(node(root, "materialSearchSegment")).backgroundColor).toBeUndefined();
  unmount(root);
});

onAndroid("with Remove animations search settles at once; otherwise it expands for 100 ms and rises for 250 ms, reversing on close", () => {
  expect(materialSearchMs(true, true)).toBe(0);
  expect(materialSearchMs(false, true)).toBe(350);
  expect(materialSearchMs(false, false)).toBe(250);
});

onAndroid("the field takes focus, and with it the keyboard, only once the field has reached the sheet header, so Android doesn't drop the request on a half-shown view", () => {
  expect(materialSearchFocusDelay(550, 0)).toBe(582);
  expect(materialSearchFocusDelay(550, 700)).toBe(32);
  expect(materialSearchFocusDelay(0, 0)).toBe(32);
});
