import { Dimensions, Keyboard, Platform, StyleSheet, Text } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { FloatingBar } from "../components/browsing/FloatingBar";
import { BottomBar } from "../components/browsing/BottomBar";
import { tabCountLabel } from "../components/browsing/MaterialPageBar";
import { barCenterFromBottom, barHeight, DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { pages } from "../platform/pages";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import { closeLibrary } from "../state/library/store";
import * as pageActions from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { storeFind, storeNavigation, usePages, type PageState } from "../state/pages/store";
import { dismissSearch, searchState } from "../state/search/store";
import { currentPreferences, setPreference } from "../state/settings/store";
import { closeSettings, settingsNav } from "../state/settings/nav";
import { currentTabs, useTabs } from "../state/tabs/store";
import { launchTabs } from "../state/tabs/tabsState";
import { renderSurface, someTabs, textOf, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

jest.mock("@ardia/phone-native", () => ({ ...jest.requireActual("@ardia/phone-native"), pageObscuresInsets: () => true }));

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  setDynamicScheme(null);
  setPreference("collapsesBottomBar", null);
  usePages.setState({ navigation: {}, tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false, menuOpen: false, menuPage: "main", menuDocked: false });
  closeSettings();
  closeLibrary();
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setDynamicScheme(null);
  setPreference("collapsesBottomBar", null);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function" && found.props.android_ripple !== undefined)[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};
const moved = (found: ReactTestInstance) => {
  const style = { ...flat(found), ...getAnimatedStyle(found) } as { opacity?: number; transform?: Record<string, number>[] };
  const transform = Object.assign({}, ...(style.transform ?? [])) as { translateY?: number };
  return { opacity: style.opacity ?? 1, translateY: transform.translateY ?? 0 };
};
const scrolled = (scrollDirection: "up" | "down", url = "https://site0.example/") =>
  act(() => storeNavigation(currentTabs().open[0]!.id, { url, title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));
const settle = () => {
  for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
};

const screen = () => {
  const tab = currentTabs().open[0]!;
  return renderSurface(
    <DesignProvider design="material">
      <BrowsingScreen tabId={tab.id} />
    </DesignProvider>,
    { flushTimers: false },
  );
};

onAndroid("the material page bar has a rounded capsule with tabs, centered search and add above the navigation inset", () => {
  const root = screen();
  expect(root.root.findAll((found) => found.type === FloatingBar)).toHaveLength(0);
  expect(root.root.findAll((found) => found.type === BottomBar)).toHaveLength(0);
  expect(node(root, "materialBarBand")).toBeUndefined();
  expect(flat(node(root, "pageArea")).marginBottom).toBe(0);
  const pageView = root.root.findAll((found) => found.props.pageId !== undefined && found.props.obscuredInsets !== undefined)[0]!;
  expect(pageView.props.obscuredInsets.bottom).toBe(0);
  expect(pageView.props.summaryBottomInset).toBe(barHeight(24, "material"));
  expect(pageView.props.toneInsets).toEqual({ top: 0, bottom: 0 });
  expect(node(root, "pageBar")!.props.pointerEvents).toBe("box-none");
  expect(flat(node(root, "pageBar")).backgroundColor).toBeUndefined();
  expect(flat(node(root, "materialPageBar"))).toMatchObject({ height: 64, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainer });
  expect(flat(node(root, "materialAddressField"))).toMatchObject({ height: 48, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainerHigh });
  for (const id of ["materialBarPlus", "materialBarTabs"]) {
    expect(flat(node(root, id))).toMatchObject({ width: 48, height: 48 });
    expect(flat(node(root, id)).backgroundColor).toBeUndefined();
    expect(pressable(root, id).props.android_ripple).toMatchObject({ borderless: true });
  }
  expect(pressable(root, "materialAddressField").props.android_ripple).toMatchObject({ borderless: false });
  const order = root.root.findAll((found) => typeof found.type === "string" && ["materialBarTabs", "materialAddressField", "materialBarPlus"].includes(found.props.testID)).map((found) => found.props.testID);
  expect(order).toEqual(["materialBarTabs", "materialAddressField", "materialBarPlus"]);
  unmount(root);
});

onAndroid("the bar's height and centre are Material's 80 dp over the navigation inset", () => {
  expect(barHeight(48, "material")).toBe(128);
  expect(barCenterFromBottom(48, "material")).toBe(88);
});

onAndroid("search edits the address, Tabs opens the deck, add opens a new search, holding the address opens the page menu, and the URL box three-dots icon opens site settings", () => {
  const edit = jest.spyOn(pageActions, "editPageQuery").mockImplementation(() => undefined);
  const deck = jest.spyOn(browse, "showDeck").mockImplementation(() => Promise.resolve());
  const plus = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const menu = jest.spyOn(pageActions, "openPageMenu").mockImplementation(() => Promise.resolve());
  const siteSettings = jest.spyOn(pageActions, "openDockedSiteSettings").mockResolvedValue(undefined);
  const root = screen();
  expect(node(root, "materialAddressField")!.findAll((found) => found.props.testID === "materialBarSiteSettings")).not.toHaveLength(0);
  act(() => {
    pressable(root, "materialAddressField").props.onPress();
  });
  act(() => {
    pressable(root, "materialBarTabs").props.onPress();
  });
  act(() => {
    pressable(root, "materialBarPlus").props.onPress();
  });
  act(() => {
    pressable(root, "materialAddressField").props.onLongPress();
  });
  act(() => {
    pressable(root, "materialBarSiteSettings").props.onPress();
  });
  expect(edit).toHaveBeenCalled();
  expect(deck).toHaveBeenCalled();
  expect(plus).toHaveBeenCalled();
  expect(menu).toHaveBeenCalled();
  expect(siteSettings).toHaveBeenCalledTimes(1);
  unmount(root);
});

onAndroid("the address button opens the compact page menu with the iOS actions and a Site Settings link", async () => {
  const tab = currentTabs().open[0]!;
  act(() => useTabs.setState({ selectedId: tab.id }));
  act(() => storeNavigation(tab.id, { url: tab.url, title: tab.title } as PageState));
  jest.spyOn(pageActions, "canPrintPages").mockReturnValue(true);
  const root = screen();
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  const list = node(root, "dockedPageMenuList")!;
  const windowHeight = Dimensions.get("window").height;
  const sheet = node(root, "materialSheet")!;
  expect(flat(sheet).maxHeight).toBeCloseTo((windowHeight - 64) * 0.52 + 128);
  expect(node(root, "materialTopAppBar")).toBeUndefined();
  for (const id of ["materialMenuAction:Reader", "materialMenuAction:Copy Link", "materialMenuAction:Share", "pageMenuRow:Find on Page", "pageMenuRow:Print", "pageMenuRow:Translate", "menuToggle:Block Ads and Trackers", "pageMenuRow:Site Settings"]) {
    expect(list.findAll((found) => typeof found.type === "string" && found.props.testID === id).length).toBeGreaterThan(0);
  }
  for (const id of ["pageMenuRow:History", "pageMenuRow:Bookmarks", "pageMenuRow:Downloads", "menuToggle:Night Shade", "menuZoom", "menuToggle:Desktop Site"]) {
    expect(list.findAll((found) => found.props.testID === id)).toHaveLength(0);
  }
  expect(settingsNav().open).toBe(false);
  act(() => { expect(pageActions.handleSystemBack()).toBe(true); });
  expect(usePageUi.getState().menuOpen).toBe(false);
  settle();
  expect(node(root, "dockedPageMenuList")).toBeUndefined();
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  settle();
  await act(async () => { pressable(root, "pageMenuRow:Site Settings").props.onPress(); });
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "siteSettings", menuDocked: true });
  expect(settingsNav().open).toBe(false);
  expect(node(root, "materialSheet")).toBeDefined();
  expect(node(root, "materialSheetDockedBar")?.props.pointerEvents).toBe("none");
  expect(flat(node(root, "materialSheetDockedBar"))).toMatchObject({ display: "none", backgroundColor: "transparent", elevation: 0 });
  const siteSettingsBar = node(root, "dockedPageMenuBar")!;
  expect(node(root, "materialSiteSettingsHeader")).toBeDefined();
  expect(node(root, "dockedPageMenuSiteSettings")).toBeDefined();
  expect(node(root, "dockedPageMenuSiteSettings")!.findAll((found) => typeof found.type === "string" && ["siteSettingsZoom", "materialSettingsRow:Night Shade", "materialSettingsRow:Desktop Site"].includes(found.props.testID)).map((found) => found.props.testID)).toEqual(["materialSettingsRow:Night Shade", "siteSettingsZoom", "materialSettingsRow:Desktop Site", "materialSettingsRow:Night Shade"]);
  expect(node(root, "dockedPageMenuList")).toBeUndefined();
  expect(textOf(root)).toContain("Block Cookie Banners");
  expect(flat(node(root, "materialSettingsSegment")).backgroundColor).toBe(LIGHT.surfaceContainerHighest);
  act(() => { expect(pageActions.handleSystemBack()).toBe(true); });
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "main", menuDocked: true });
  expect(node(root, "dockedPageMenuList")).toBeDefined();
  expect(node(root, "materialSheetDockedBar")?.props.pointerEvents).toBe("box-none");
  expect(flat(node(root, "materialSheetDockedBar"))).toMatchObject({ display: "flex", backgroundColor: LIGHT.surfaceContainerHigh, elevation: 2 });
  expect(node(root, "dockedPageMenuBar")).toBe(siteSettingsBar);
  expect(node(root, "dockedPageMenuBar")!).toHaveAnimatedStyle({ paddingLeft: 4 });
  expect(flat(node(root, "dockedPageMenuBar")).opacity).toBeUndefined();
  expect(node(root, "dockedPageMenuTitleSlot")!).toHaveAnimatedStyle({ opacity: 1 });
  expect(node(root, "dockedPageMenuHistory")!).toHaveAnimatedStyle({ width: 80, opacity: 1 });
  expect(node(root, "dockedPageMenuTitle")).toBeDefined();
  await act(async () => { pressable(root, "pageMenuRow:Site Settings").props.onPress(); });
  act(() => pressable(root, "siteSettingsSheetBack").props.onPress());
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "main", menuDocked: true });
  expect(flat(node(root, "materialSheetDockedBar"))).toMatchObject({ display: "flex", backgroundColor: LIGHT.surfaceContainerHigh, elevation: 2 });
  expect(node(root, "dockedPageMenuTitleSlot")!).toHaveAnimatedStyle({ opacity: 1 });
  expect(node(root, "dockedPageMenuHistory")!).toHaveAnimatedStyle({ width: 80, opacity: 1 });
  await act(async () => { pressable(root, "pageMenuRow:Site Settings").props.onPress(); });
  act(() => pressable(root, "materialSettingsRow:Filter Lists").props.onPress());
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(settingsNav().stack).toEqual([{ page: "siteSettings" }, { page: "filterLists" }]);
  act(() => { expect(pageActions.handleSystemBack()).toBe(true); });
  expect(settingsNav()).toMatchObject({ open: true, stack: [{ page: "siteSettings" }] });
  act(() => { expect(pageActions.handleSystemBack()).toBe(true); });
  expect(settingsNav().open).toBe(false);
  expect(usePageUi.getState().menuOpen).toBe(false);
  unmount(root);
});

onAndroid("the page menu capsule docks with the iOS history controls, page title and reload button", async () => {
  withTabs(1);
  const back = jest.spyOn(pageActions, "menuBack").mockImplementation(pageActions.closePageMenu);
  const forward = jest.spyOn(pageActions, "menuForward").mockImplementation(pageActions.closePageMenu);
  const tab = currentTabs().open[0]!;
  const navigate = (canGoBack: boolean, canGoForward: boolean, isLoading = false) =>
    act(() => storeNavigation(tab.id, { url: tab.url, title: tab.title, canGoBack, canGoForward, isLoading } as PageState));
  navigate(true, false);
  const root = screen();
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  const dock = node(root, "materialSheetDockedBar")!;
  expect(dock).toHaveAnimatedStyle({ left: 76, right: 76, bottom: 40, transform: [{ translateY: 0 }] });
  expect(flat(node(root, "materialAddressField")).opacity).toBe(0);
  for (let frame = 0; frame < 6; frame++) act(() => jest.advanceTimersByTime(16));
  const widening = getAnimatedStyle(dock);
  expect(widening.left).toBeLessThan(76);
  expect(widening.right).toBe(widening.left);
  expect(widening.transform).toEqual([{ translateY: 0 }]);
  settle();
  const compactHeight = flat(node(root, "materialSheet")).maxHeight as number;
  expect(dock).toHaveAnimatedStyle({ left: 16, right: 16, transform: [{ translateY: 136 - compactHeight }] });
  expect(node(root, "siteSettingsAddressHost")?.props.children).toEqual(node(root, "materialBarHost")?.props.children);
  expect(node(root, "siteSettingsAddressHost")?.props.ellipsizeMode).toBe("tail");
  expect(pressable(root, "dockedPageMenuTitle").props.accessibilityLabel).toBe(tab.title);
  expect(pressable(root, "dockedPageMenuReload").props.accessibilityLabel).toBe("Reload");
  const history = node(root, "dockedPageMenuHistory")!;
  expect(history.findAll((found) => typeof found.type === "string" && ["siteSettingsBack", "siteSettingsForward"].includes(found.props.testID)).map((found) => found.props.testID)).toEqual(["siteSettingsBack", "siteSettingsForward"]);
  expect(flat(node(root, "siteSettingsBack"))).toMatchObject({ width: 40, height: 48 });
  expect(pressable(root, "siteSettingsBack").props.hitSlop).toEqual({ left: 4, right: 4 });
  expect(pressable(root, "siteSettingsBack").props.disabled).toBe(false);
  expect(pressable(root, "siteSettingsForward").props.disabled).toBe(true);
  act(() => pressable(root, "siteSettingsBack").props.onPress());
  expect(back).toHaveBeenCalledTimes(1);
  expect(node(root, "materialSheetDockedBar")).toBeDefined();
  settle();
  expect(node(root, "materialSheetDockedBar")).toBeUndefined();
  expect(flat(node(root, "materialAddressField")).opacity).toBeUndefined();
  navigate(false, true, true);
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  settle();
  expect(pressable(root, "siteSettingsBack").props.disabled).toBe(true);
  expect(pressable(root, "siteSettingsForward").props.disabled).toBe(false);
  expect(pressable(root, "dockedPageMenuReload").props.accessibilityLabel).toBe("Stop Loading");
  act(() => pressable(root, "siteSettingsForward").props.onPress());
  expect(forward).toHaveBeenCalledTimes(1);
  settle();
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  settle();
  const menuSheet = node(root, "materialSheet");
  const menuBar = node(root, "materialSheetDockedBar")!;
  const menuCapsule = flat(menuBar);
  const menuPosition = getAnimatedStyle(menuBar).transform;
  act(() => pressable(root, "dockedPageMenuTitle").props.onPress());
  expect(searchState()).toMatchObject({ open: true, initialText: tab.url });
  expect(node(root, "materialSheet")).toBe(menuSheet);
  expect(node(root, "materialSheetDockedBar")).toBe(menuBar);
  expect(flat(menuBar)).toMatchObject({ backgroundColor: menuCapsule.backgroundColor, borderRadius: menuCapsule.borderRadius, height: menuCapsule.height });
  expect(node(root, "dockedPageMenuList")).toBeUndefined();
  expect(node(root, "materialSearchBar")).toBeDefined();
  expect(node(root, "materialSearchResults")).toBeDefined();
  expect(getAnimatedStyle(menuBar).transform).toEqual(menuPosition);
  settle();
  expect(getAnimatedStyle(menuBar).transform).not.toEqual(menuPosition);
  act(() => dismissSearch());
  settle();
  expect(node(root, "materialSheetDockedBar")).toBeUndefined();
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  settle();
  expect(node(root, "dockedPageMenuList")).toBeDefined();
  expect(node(root, "materialSearchBar")).toBeUndefined();
  act(() => pageActions.closePageMenu());
  expect(node(root, "materialSearchBar")).toBeUndefined();
  settle();
  unmount(root);
});

onAndroid("the docked menu has no Library rows, and Find on Page uses the Material address capsule", async () => {
  withTabs(1);
  scrolled("up");
  const find = jest.spyOn(pages, "find").mockResolvedValue(undefined);
  const next = jest.spyOn(pages, "findNext").mockResolvedValue(undefined);
  const previous = jest.spyOn(pages, "findPrevious").mockResolvedValue(undefined);
  const end = jest.spyOn(pages, "endFind").mockResolvedValue(undefined);
  const dismissKeyboard = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => undefined);
  const root = screen();
  const openMenu = async () => {
    await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
    settle();
  };
  await openMenu();
  for (const label of ["History", "Bookmarks", "Downloads"]) expect(root.root.findAll((found) => found.props.testID === `pageMenuRow:${label}`)).toHaveLength(0);
  act(() => pressable(root, "pageMenuRow:Find on Page").props.onPress());
  expect(usePageUi.getState().menuOpen).toBe(false);
  settle();
  expect(node(root, "materialSheet")).toBeUndefined();
  expect(flat(node(root, "materialFindBar"))).toMatchObject({ height: 64, left: 16, right: 16, bottom: 32 });
  const id = currentTabs().selectedId!;
  expect(node(root, "materialSearchIncognito")).toBeUndefined();
  const input = root.root.findAll((found) => found.props.accessibilityLabel === "Find on Page" && typeof found.props.onChangeText === "function")[0]!;
  await act(async () => { input.props.onChangeText("needle"); });
  expect(find).toHaveBeenCalledWith(id, "needle");
  expect(searchState().open).toBe(false);
  act(() => storeFind(id, { query: "needle", activeIndex: 0, total: 3, isDone: true }));
  expect(node(root, "materialFindCount")?.props.children).toBe("1 of 3");
  const button = (label: string) => root.root.findAll((found) => found.props.accessibilityLabel === label && typeof found.props.onPress === "function")[0]!;
  await act(async () => { button("Next Match").props.onPress(); });
  expect(next).toHaveBeenCalledWith(id);
  await act(async () => { button("Previous Match").props.onPress(); });
  expect(previous).toHaveBeenCalledWith(id);
  scrolled("down");
  await act(async () => { button("Close Find").props.onPress(); });
  expect(dismissKeyboard).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledWith(id);
  expect(node(root, "materialFindBar")).toBeUndefined();
  expect(node(root, "pageBar")?.props.pointerEvents).toBe("box-none");
  expect(moved(node(root, "pageBar")!)).toEqual({ opacity: 1, translateY: 0 });
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  expect(node(root, "dockedPageMenuList")).toBeDefined();
  act(() => pageActions.closePageMenu());
  unmount(root);
});

onAndroid("swiping up expands the docked page menu, then swiping down restores its compact height", async () => {
  const root = screen();
  await act(async () => { await pressable(root, "materialBarSiteSettings").props.onPress(); });
  settle();
  const sheet = node(root, "materialSheet")!;
  const compactHeight = flat(sheet).maxHeight as number;
  const windowHeight = Dimensions.get("window").height;
  const layout = (height: number) => act(() => sheet.props.onLayout({ nativeEvent: { layout: { height } } }));
  const swipe = (translationY: number) => act(() => fireGestureHandler(getByGestureTestId("sheetDrag"), [
    { state: State.BEGAN, y: 24, translationY: 0, velocityY: 0 },
    { state: State.ACTIVE, y: 24, translationY: 0, velocityY: 0 },
    { state: State.ACTIVE, y: 24 + translationY, translationY, velocityY: 0 },
    { state: State.END, y: 24 + translationY, translationY, velocityY: 0 },
  ]));
  layout(compactHeight);
  swipe(-180);
  settle();
  expect(sheet).toHaveAnimatedStyle({ height: windowHeight, paddingTop: 40, borderTopLeftRadius: 0 });
  layout(windowHeight);
  expect(node(root, "materialSheetDockedBar")!).toHaveAnimatedStyle({ left: 16, right: 16, transform: [{ translateY: 176 - windowHeight }] });
  swipe(180);
  settle();
  expect(sheet).toHaveAnimatedStyle({ maxHeight: compactHeight, paddingTop: 0, borderTopLeftRadius: 28 });
  expect(usePageUi.getState().menuOpen).toBe(true);
  act(() => pageActions.closePageMenu());
  unmount(root);
});

onAndroid("the Tabs button shows the tab count in Material's outlined box, says it to TalkBack, and caps at 99+", () => {
  const root = screen();
  const tabs = pressable(root, "materialBarTabs");
  expect(tabs.props.accessibilityValue).toEqual({ text: "3 tabs" });
  expect(node(root, "materialTabCount")!.findAll((found) => found.type === Text)[0]!.props.children).toBe("3");
  expect(tabCountLabel(150)).toBe("99+");
  unmount(root);
});

onAndroid.each(["light", "dark"] as const)("Incognito keeps the page search bar black with %s appearance", (appearance) => {
  const previous = currentPreferences().schemeChoice;
  act(() => setPreference("schemeChoice", appearance));
  useTabs.setState({ ...launchTabs(someTabs(1, true), 0), incognito: true, listing: 0 });
  const tab = [...currentTabs().privates, ...currentTabs().open].find((one) => one.isPrivate)!;
  const root = renderSurface(
    <DesignProvider design="material">
      <BrowsingScreen tabId={tab.id} />
    </DesignProvider>,
    { flushTimers: false },
  );
  expect(flat(node(root, "materialAddressField")).backgroundColor).toBe("#000000");
  expect(flat(node(root, "materialPageBar")).backgroundColor).toBe("#000000");
  expect(flat(node(root, "materialBarHost")).color).toBe(SEEDED_SCHEMES.ardia.dark.onSurface);
  unmount(root);
  act(() => setPreference("schemeChoice", previous));
});

onAndroid("a wallpaper scheme change re-themes the bar", () => {
  const root = screen();
  act(() => setDynamicScheme({ light: { ...SEEDED_SCHEMES.blue.light }, dark: SEEDED_SCHEMES.blue.dark }));
  expect(flat(node(root, "materialPageBar")).backgroundColor).toBe(SEEDED_SCHEMES.blue.light.surfaceContainer);
  expect(flat(node(root, "materialAddressField")).backgroundColor).toBe(SEEDED_SCHEMES.blue.light.surfaceContainerHigh);
  unmount(root);
});

onAndroid("an open Material Find bar keeps the summary card clear of it", () => {
  const root = screen();
  act(() => usePageUi.setState({ findOpen: true }));
  settle();
  const pageView = root.root.findAll((found) => found.props.pageId !== undefined && found.props.obscuredInsets !== undefined)[0]!;
  expect(pageView.props.summaryBottomInset).toBe(barHeight(24, "material"));
  unmount(root);
});

onAndroid("scrolling a page down folds the Material bottom bar into a host pill by default, and the pill or scrolling up brings it back", () => {
  scrolled("up");
  const root = screen();
  const pageView = () => root.root.findAll((found) => found.props.pageId !== undefined && found.props.obscuredInsets !== undefined)[0]!;
  const expandedSummaryInset = pageView().props.summaryBottomInset as number;
  expect(expandedSummaryInset).toBe(barHeight(24, "material"));
  scrolled("down");
  settle();
  expect(node(root, "materialBarFold")!).toHaveAnimatedStyle({ opacity: 0 });
  expect(node(root, "materialBarFold")!.props.pointerEvents).toBe("none");
  expect(node(root, "materialBarFold")!.props.accessibilityElementsHidden).toBe(true);
  expect(node(root, "materialBarPillPlace")!).toHaveAnimatedStyle({ opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] });
  expect(node(root, "materialBarPillPlace")!.props.pointerEvents).toBe("box-none");
  expect(flat(node(root, "materialBarPill"))).toMatchObject({ height: 36, borderRadius: 9999, elevation: 3 });
  expect(flat(node(root, "materialBarPillPlace"))).toMatchObject({ height: 60, paddingVertical: 12 });
  expect(pageView().props.summaryBottomInset).toBeGreaterThan(0);
  expect(pageView().props.summaryBottomInset).toBeLessThan(expandedSummaryInset);
  scrolled("up");
  settle();
  expect(node(root, "materialBarFold")!).toHaveAnimatedStyle({ opacity: 1 });
  expect(node(root, "materialBarFold")!.props.pointerEvents).toBe("box-none");
  expect(node(root, "materialBarPillPlace")!).toHaveAnimatedStyle({ opacity: 0 });
  expect(node(root, "materialBarPillPlace")!.props.accessibilityElementsHidden).toBe(true);
  expect(pageView().props.summaryBottomInset).toBe(expandedSummaryInset);
  scrolled("down");
  settle();
  act(() => pressable(root, "materialBarPill").props.onPress());
  settle();
  expect(node(root, "materialBarFold")!).toHaveAnimatedStyle({ opacity: 1 });
  expect(pageView().props.summaryBottomInset).toBe(expandedSummaryInset);
  unmount(root);
});

onAndroid("turning Collapse Bottom Bar off keeps the Material bottom bar unfolded while scrolling down, and the page stops above it so its end stays reachable", () => {
  setPreference("collapsesBottomBar", false);
  scrolled("up");
  const root = screen();
  scrolled("down");
  settle();
  expect(moved(node(root, "pageBar")!)).toMatchObject({ opacity: 1, translateY: 0 });
  expect(node(root, "pageBar")!.props.pointerEvents).toBe("box-none");
  expect(node(root, "materialBarFold")!).toHaveAnimatedStyle({ opacity: 1 });
  expect(node(root, "materialBarFold")!.props.pointerEvents).toBe("box-none");
  expect(node(root, "materialBarPillPlace")!).toHaveAnimatedStyle({ opacity: 0 });
  const pageView = root.root.findAll((found) => found.props.pageId !== undefined && found.props.obscuredInsets !== undefined)[0]!;
  expect(pageView.props.obscuredInsets.bottom).toBe(barHeight(24, "material"));
  unmount(root);
});

onAndroid("the Material bar's + says New Tab, or New Incognito Tab on an Incognito page, as every other bar's + does", () => {
  const plain = screen();
  expect(pressable(plain, "materialBarPlus").props.accessibilityLabel).toBe("New Tab");
  unmount(plain);
  const privateTab = { ...currentTabs().open[0]!, isPrivate: true };
  useTabs.setState((state) => ({ open: state.open.map((other) => (other.id === privateTab.id ? privateTab : other)) }));
  const incognito = renderSurface(
    <DesignProvider design="material">
      <BrowsingScreen tabId={privateTab.id} />
    </DesignProvider>,
    { flushTimers: false },
  );
  expect(pressable(incognito, "materialBarPlus").props.accessibilityLabel).toBe("New Incognito Tab");
  unmount(incognito);
});
