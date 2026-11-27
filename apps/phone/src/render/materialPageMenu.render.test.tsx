import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import "../platform/copy";
import { PageMenu } from "../components/browsing/PageMenu";
import { DesignProvider } from "../components/ui";
import { materialSwitchHandle } from "../components/ui/MaterialSurfaces";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import { useBrowse } from "../state/browse/store";
import { useLibrary } from "../state/library/store";
import { usePageUi } from "../state/page/store";
import * as pageActions from "../state/page/actions";
import { usePages } from "../state/pages/store";
import { blocking } from "../platform/blocking";
import { pages } from "../platform/pages";
import { usePageSummariesSwitch } from "../state/pageSummary/enabled";
import * as telemetry from "../state/telemetry/telemetry";
import { useDefaultBrowser } from "../state/settings/defaultBrowser";
import { useSettingsNav } from "../state/settings/nav";
import { useTabs } from "../state/tabs/store";
import { selectedTab } from "../state/tabs/tabsState";
import { classicOnAndroid, renderSurface, textOf, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

const page = (url: string) =>
  usePages.setState((state) => ({ ...state, navigation: { t0: { url, title: "Site 0", canGoBack: true, canGoForward: false, isLoading: false, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  page("https://site0.example/");
  setDynamicScheme(null);
  useBrowse.setState({ surface: "browsing", sheet: null });
  useLibrary.setState({ open: false, section: "history", path: [] });
  useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false });
  useDefaultBrowser.setState({ status: { isDefault: false, canAsk: true } });
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "disabled" } as never);
  jest.spyOn(blocking, "isEnabledForSite").mockResolvedValue(true);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setDynamicScheme(null);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function" && found.props.android_ripple !== undefined)[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

async function openMenu(wrap: (menu: React.ReactElement) => React.ReactNode = (menu) => <DesignProvider design="material">{menu}</DesignProvider>) {
  await act(async () => {
    await pageActions.openPageMenu();
  });
  return renderSurface(wrap(<PageMenu tabId={selectedTab(useTabs.getState())!.id} open onHidden={() => undefined} />) as React.ReactElement);
}

onAndroid("the material page menu is a Material bottom sheet: a title row, navigation as 48 dp icon buttons, Reader, Copy Link and Share as tonal buttons, and list rows in Material 3 Expressive groups: rounded segments 2 dp apart, no dividers", async () => {
  const root = await openMenu();
  expect(node(root, "materialSheet")).toBeDefined();
  expect(node(root, "materialPageMenu")).toBeDefined();
  expect(flat(pressable(root, "pageMenuTitle")).minHeight).toBe(56);
  for (const label of ["Back", "Forward", "Reload"]) {
    expect(flat(node(root, `materialMenuIcon:${label}`))).toMatchObject({ width: 48, height: 48 });
    expect(pressable(root, `materialMenuIcon:${label}`).props.android_ripple).toMatchObject({ borderless: true });
  }
  expect(node(root, "materialMenuIcon:Back")!.props.accessibilityState).toMatchObject({ disabled: false });
  expect(node(root, "materialMenuIcon:Forward")!.props.accessibilityState).toMatchObject({ disabled: true });
  for (const title of ["Reader", "Copy Link", "Share"]) {
    const action = node(root, `materialMenuAction:${title}`);
    expect(flat(action)).toMatchObject({ height: 40, borderRadius: 9999, backgroundColor: LIGHT.secondaryContainer, flexGrow: 1, flexShrink: 1 });
    expect(flat(action).flex).toBeUndefined();
    expect(action!.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
    const label = action!.findAll((found) => found.type === "Text")[0]!;
    expect(label.props.ellipsizeMode).toBe("tail");
    expect(flat(label).flexShrink).toBe(1);
  }
  const row = node(root, "pageMenuRow:Find on Page");
  expect(flat(row).minHeight).toBe(56);
  expect(row!.findAll((found) => found.type === "Text")[0]!.props.numberOfLines).toBeUndefined();
  expect(pressable(root, "pageMenuRow:Find on Page").props.android_ripple).toMatchObject({ borderless: false });
  expect(node(root, "menuToggle:Block Ads and Trackers")!.findAll((found) => found.type === "Text")[0]!.props.numberOfLines).toBeUndefined();
  expect(root.root.findAll((found) => found.props.testID === "materialMenuDivider")).toHaveLength(0);
  const group = root.root.findAll((found) => found.props.testID === "materialMenuGroup" && typeof found.type === "string")[1]!;
  expect(flat(group).gap).toBe(2);
  const segments = group.findAll((found) => found.props.testID === "materialMenuSegment" && typeof found.type === "string");
  expect(segments).toHaveLength(3);
  expect(flat(segments[0])).toMatchObject({ borderTopLeftRadius: 20, borderBottomLeftRadius: 4, backgroundColor: LIGHT.surfaceContainerHighest });
  expect(flat(segments.at(-1))).toMatchObject({ borderTopLeftRadius: 4, borderBottomLeftRadius: 20 });
  unmount(root);
});

onAndroid("the Material page menu has no History, Bookmarks, Downloads, Night Shade, Page Zoom or Desktop Site rows: the Library is in the tab switcher's menu and the site's own switches in Site Settings", async () => {
  const root = await openMenu();
  for (const title of ["History", "Bookmarks", "Downloads"]) expect(node(root, `pageMenuRow:${title}`)).toBeUndefined();
  for (const title of ["Night Shade", "Desktop Site"]) expect(node(root, `menuToggle:${title}`)).toBeUndefined();
  expect(node(root, "menuZoom")).toBeUndefined();
  expect(node(root, "materialZoomReset")).toBeUndefined();
  expect(root.root.findAll((found) => found.props.accessibilityLabel === "Zoom In")).toHaveLength(0);
  expect(node(root, "pageMenuRow:Site Settings")).toBeDefined();
  unmount(root);
});

onAndroid("toggle rows carry a Material switch: one switch for TalkBack, a tap anywhere flips it, and the handle grows from 16 to 24 dp as it moves", async () => {
  const flip = jest.spyOn(pageActions, "setBlockersOn").mockImplementation(() => undefined as never);
  const root = await openMenu();
  const row = pressable(root, "menuToggle:Block Ads and Trackers");
  expect(row.props.accessibilityRole).toBe("switch");
  expect(row.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  expect(row.findAll((found) => found.props.testID === "materialSwitch" && typeof found.type === "string")).toHaveLength(1);
  act(() => {
    row.props.onPress();
  });
  expect(flip).toHaveBeenCalledWith(false);
  expect(materialSwitchHandle(0)).toEqual({ size: 16, left: 6, top: 6 });
  expect(materialSwitchHandle(1)).toEqual({ size: 24, left: 22, top: 2 });
  unmount(root);
});

async function materialSiteSettings() {
  const root = await openMenu();
  act(() => usePageUi.setState({ zoomLevels: [0.5, 1, 1.5, 2] }));
  await act(async () => {
    pressable(root, "pageMenuRow:Site Settings").props.onPress();
  });
  return root;
}

const labelled = (root: Root, label: string) => root.root.findAll((found) => found.props.accessibilityLabel === label && typeof found.type === "string")[0];
const pressLabelled = (root: Root, label: string) => act(() => root.root.findAll((found) => found.props.accessibilityLabel === label && typeof found.props.onPress === "function")[0]!.props.onPress());

onAndroid("the Material Site Settings starts with the site's group: its host above Night Shade, Page Zoom and Desktop Site as Material rows, with 48 dp zoom controls", async () => {
  const root = await materialSiteSettings();
  const sheet = node(root, "materialPageMenuSiteSettings")!;
  const words = textOf({ root: sheet } as never).split("\n");
  expect(words.indexOf("site0.example")).toBeGreaterThanOrEqual(0);
  expect(words.indexOf("site0.example")).toBeLessThan(words.indexOf("Night Shade"));
  expect(words.indexOf("Night Shade")).toBeLessThan(words.indexOf("Block Cookie Banners"));
  expect(words).toEqual(expect.arrayContaining(["Page Zoom", "Desktop Site", "Desktop Site applies to this tab."]));
  const shade = pressable(root, "materialSettingsRow:Night Shade");
  expect(shade.props.accessibilityRole).toBe("switch");
  expect(shade.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  expect(pressable(root, "materialSettingsRow:Desktop Site").props.accessibilityRole).toBe("switch");
  expect(flat(labelled(root, "Zoom Out"))).toMatchObject({ width: 48, height: 48 });
  expect(flat(labelled(root, "Zoom In"))).toMatchObject({ width: 48, height: 48 });
  expect(flat(labelled(root, "Reset Zoom")).height).toBe(48);
  expect(labelled(root, "Reset Zoom")!.props.accessibilityValue).toEqual({ text: "100%" });
  unmount(root);
});

onAndroid("the Material site group's Night Shade, Zoom In and Desktop Site write to the page and count, and opening Site Settings from the menu is counted", async () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(telemetry, "usageCountingWindow").mockImplementation(() => (field) => telemetry.countUsage(field));
  const shade = jest.spyOn(pages, "setNightShade").mockResolvedValue(undefined);
  const zoomIn = jest.spyOn(pages, "zoomIn").mockResolvedValue(1.5);
  const desktop = jest.spyOn(pages, "setDesktopSite").mockResolvedValue(undefined);
  const root = await materialSiteSettings();
  act(() => pressable(root, "materialSettingsRow:Night Shade").props.onPress());
  pressLabelled(root, "Zoom In");
  await act(async () => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });
  act(() => pressable(root, "materialSettingsRow:Desktop Site").props.onPress());
  await act(async () => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });
  expect(shade).toHaveBeenCalledWith("always", "site0.example", false);
  expect(zoomIn).toHaveBeenCalledWith("t0");
  expect(desktop).toHaveBeenCalledWith("t0", true);
  expect(counted.mock.calls.map(([field]) => field).filter((field) => field === "page_menu_site_settings_opened" || field.startsWith("site_settings_")).sort()).toEqual(["page_menu_site_settings_opened", "site_settings_desktop_site_changed", "site_settings_night_shade_changed", "site_settings_zoom_changed"]);
  unmount(root);
});

onAndroid("Filter Lists from the Material Site Settings closes the menu and opens Settings on Filter Lists over Site Settings", async () => {
  const root = await materialSiteSettings();
  act(() => pressable(root, "materialSettingsRow:Filter Lists").props.onPress());
  expect(pageActions.siteSettingsInMenu()).toBe(false);
  expect(useSettingsNav.getState()).toMatchObject({ open: true, stack: [{ page: "siteSettings" }, { page: "filterLists" }] });
  unmount(root);
});

onAndroid("a wallpaper scheme change re-themes the open menu", async () => {
  const root = await openMenu();
  act(() => setDynamicScheme({ light: SEEDED_SCHEMES.pink.light, dark: SEEDED_SCHEMES.pink.dark }));
  expect(flat(node(root, "materialMenuAction:Reader")).backgroundColor).toBe(SEEDED_SCHEMES.pink.light.secondaryContainer);
  unmount(root);
});

onAndroid("Site Settings opens inside the Material page menu sheet and Back returns to the menu", async () => {
  const root = await openMenu();
  await act(async () => {
    pressable(root, "pageMenuRow:Site Settings").props.onPress();
  });
  expect(useSettingsNav.getState().open).toBe(false);
  expect(node(root, "materialSheet")).toBeDefined();
  expect(node(root, "materialSiteSettingsHeader")).toBeDefined();
  expect(node(root, "materialPageMenuSiteSettings")).toBeDefined();
  expect(node(root, "materialPageMenu")).toBeUndefined();
  expect(flat(node(root, "materialSettingsSegment")).backgroundColor).toBe(LIGHT.surfaceContainerHighest);
  act(() => {
    pressable(root, "siteSettingsSheetBack").props.onPress();
  });
  expect(node(root, "materialPageMenu")).toBeDefined();
  expect(node(root, "materialPageMenuSiteSettings")).toBeUndefined();
  unmount(root);
});

onAndroid("the original design's menu is untouched by the Material one", async () => {
  const root = await openMenu(classicOnAndroid);
  expect(node(root, "materialPageMenu")).toBeUndefined();
  expect(node(root, "materialSwitch")).toBeUndefined();
  unmount(root);
});

onAndroid("Summarize Page sits under Find on Page in the Material menu where the phone summarizes and Pinch to Summarize is on, and runs the same summary", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  const summarize = jest.spyOn(pageActions, "summarizeCurrentPage").mockImplementation(() => undefined);
  usePageSummariesSwitch.setState({ enabled: false });
  const off = await openMenu();
  expect(node(off, "pageMenuRow:Summarize Page")).toBeUndefined();
  unmount(off);
  usePageSummariesSwitch.setState({ enabled: true });
  const root = await openMenu();
  expect(node(root, "pageMenuRow:Summarize Page")).toBeDefined();
  act(() => pressable(root, "pageMenuRow:Summarize Page").props.onPress());
  expect(summarize).toHaveBeenCalledTimes(1);
  unmount(root);
  usePageSummariesSwitch.setState({ enabled: false });
});

onAndroid("a tap on the scrim around the Material page menu counts page_menu_tapped_away, as main's sheet does", async () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = await openMenu();
  const scrim = root.root.findAll((found) => found.props.accessibilityLabel === "Close" && typeof found.props.onPress === "function")[0]!;
  act(() => scrim.props.onPress());
  expect(counted).toHaveBeenCalledWith("page_menu_tapped_away");
  unmount(root);
});
