import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { PageMenu } from "../components/browsing/PageMenu";
import { SettingsView } from "../components/settings/SettingsView";
import { DesignProvider } from "../components/ui";
import { blocking } from "../platform/blocking";
import { pages } from "../platform/pages";
import { handleSystemBack, openPageMenu } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { openSettings, popSettings, useSettingsNav } from "../state/settings/nav";
import { useBrowse } from "../state/browse/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useTabs } from "../state/tabs/store";
import { selectedTab } from "../state/tabs/tabsState";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

const navigation = (url: string, pageZoom = 1) => ({ url, title: "Site 0", canGoBack: false, canGoForward: false, isLoading: false, pageZoom, isDesktopSite: false, blockedRequests: 0 }) as never;
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState((state) => ({ ...state, navigation: { t0: navigation("https://site0.example/") } }));
  useBrowse.setState({ surface: "browsing", sheet: null });
  useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false });
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "disabled" } as never);
  jest.spyOn(blocking, "isEnabledForSite").mockResolvedValue(true);
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(telemetry, "usageCountingWindow").mockImplementation(() => (field) => telemetry.countUsage(field));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const flush = () =>
  act(async () => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });

async function openMenu(tabId = selectedTab(useTabs.getState())!.id) {
  await act(async () => {
    await openPageMenu();
  });
  act(() => usePageUi.setState({ zoomLevels: ZOOM_LEVELS }));
  return renderSurface(
    <DesignProvider design="original">
      <PageMenu tabId={tabId} open onHidden={() => undefined} />
    </DesignProvider>,
  );
}

async function siteSettings(tabId?: string) {
  const root = await openMenu(tabId);
  await pressButton(root, "Site Settings");
  act(() => jest.runOnlyPendingTimers());
  return root;
}

const siteCounts = () => (telemetry.countUsage as jest.Mock).mock.calls.map(([field]) => field as string).filter((field) => field === "page_menu_site_settings_opened" || field.startsWith("site_settings_"));
const control = (root: Root, role: string, label: string) => root.root.findAll((node) => node.props.accessibilityRole === role && node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0];
const tap = (node: ReactTestInstance | undefined) => act(() => node!.props.onPress());

test("Site Settings opens inside the menu with a Back button, and Back returns to the menu", async () => {
  const root = await siteSettings();
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "siteSettings" });
  expect(useSettingsNav.getState().open).toBe(false);
  expect(textOf(root)).toContain("Block Cookie Banners");
  expect(textOf(root)).not.toContain("Find on Page");
  const back = root.root.findAll((node) => node.props.accessibilityLabel === "Back" && typeof node.props.onPress === "function")[0]!;
  await act(async () => back.props.onPress());
  act(() => jest.runOnlyPendingTimers());
  expect(textOf(root)).toContain("Find on Page");
  expect(usePageUi.getState().menuOpen).toBe(true);
  unmount(root);
});

test("system Back on the menu's Site Settings returns to the menu instead of closing it, and the menu reopens on its main page", async () => {
  const root = await openMenu();
  await pressButton(root, "Site Settings");
  act(() => {
    handleSystemBack();
  });
  expect(usePageUi.getState().menuOpen).toBe(true);
  expect(usePageUi.getState().menuPage).toBe("main");
  await pressButton(root, "Site Settings");
  act(() => usePageUi.setState({ menuOpen: false }));
  await act(async () => {
    await openPageMenu();
  });
  expect(usePageUi.getState().menuPage).toBe("main");
  unmount(root);
});

test.each(["Filter Lists", "Trusted Sites"])("%s from the menu's Site Settings closes the menu and opens Settings on it over Site Settings, so Back lands on Site Settings", async (title) => {
  const root = await siteSettings();
  await pressButton(root, title);
  const page = title === "Filter Lists" ? "filterLists" : "trustedSites";
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(useSettingsNav.getState()).toMatchObject({ open: true, stack: [{ page: "siteSettings" }, { page }] });
  act(() => void popSettings());
  expect(useSettingsNav.getState()).toMatchObject({ open: true, stack: [{ page: "siteSettings" }] });
  unmount(root);
});

test("the menu's Site Settings starts with a group for the site, headed by its host, with Night Shade, Page Zoom and Desktop Site, and opening it is counted", async () => {
  const root = await siteSettings();
  const words = textOf(root);
  expect(words).toContain("site0.example");
  expect(words).toContain("Desktop Site applies to this tab.");
  expect(words).toContain("Change one site from Site Settings in its page menu.");
  expect(words.indexOf("site0.example")).toBeLessThan(words.indexOf("Block Cookie Banners"));
  expect(control(root, "switch", "Night Shade")!.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  expect(control(root, "switch", "Desktop Site")!.props.accessibilityState).toMatchObject({ checked: false });
  expect(control(root, "button", "Reset Zoom")!.props.accessibilityValue).toEqual({ text: "100%" });
  expect(["Zoom Out", "Zoom In"].map((label) => control(root, "button", label)!.props.accessibilityState?.disabled)).toEqual([false, false]);
  expect(siteCounts()).toEqual(["page_menu_site_settings_opened"]);
  unmount(root);
});

test("the site group's rows write to the page, each counted only once its write lands, and Desktop Site closes the menu", async () => {
  const zoomIn = jest.spyOn(pages, "zoomIn").mockResolvedValue(1.5);
  const zoomOut = jest.spyOn(pages, "zoomOut").mockResolvedValue(1.25);
  const reset = jest.spyOn(pages, "setPageZoom").mockResolvedValue(1);
  let shadeLands: () => void = () => undefined;
  const shade = jest.spyOn(pages, "setNightShade").mockImplementation(() => new Promise<void>((resolve) => (shadeLands = resolve)));
  const desktop = jest.spyOn(pages, "setDesktopSite").mockResolvedValue(undefined);
  usePages.setState((state) => ({ ...state, navigation: { t0: navigation("https://site0.example/", 1.25) } }));
  const root = await siteSettings();
  (telemetry.countUsage as jest.Mock).mockClear();
  tap(control(root, "button", "Zoom In"));
  tap(control(root, "button", "Zoom Out"));
  tap(control(root, "button", "Reset Zoom"));
  await flush();
  expect([zoomIn.mock.calls, zoomOut.mock.calls, reset.mock.calls]).toEqual([[["t0"]], [["t0"]], [["t0", 1]]]);
  tap(control(root, "switch", "Night Shade"));
  await flush();
  expect(shade).toHaveBeenCalledWith("always", "site0.example", false);
  expect(control(root, "switch", "Night Shade")!.props.accessibilityState).toMatchObject({ checked: true });
  expect(siteCounts()).toEqual(["site_settings_zoom_changed", "site_settings_zoom_changed", "site_settings_zoom_changed"]);
  shadeLands();
  await flush();
  expect(siteCounts()).toEqual(["site_settings_zoom_changed", "site_settings_zoom_changed", "site_settings_zoom_changed", "site_settings_night_shade_changed"]);
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "siteSettings" });
  tap(control(root, "switch", "Desktop Site"));
  await flush();
  expect(desktop).toHaveBeenCalledWith("t0", true);
  expect(siteCounts().at(-1)).toBe("site_settings_desktop_site_changed");
  expect(usePageUi.getState().menuOpen).toBe(false);
  unmount(root);
});

test("a refused write counts nothing, and Reset Zoom on a page already at 100% counts nothing", async () => {
  const reset = jest.spyOn(pages, "setPageZoom").mockResolvedValue(1);
  jest.spyOn(pages, "zoomIn").mockRejectedValue(new Error("gone"));
  jest.spyOn(pages, "setNightShade").mockRejectedValue(new Error("refused"));
  jest.spyOn(pages, "setDesktopSite").mockRejectedValue(new Error("gone"));
  const root = await siteSettings();
  (telemetry.countUsage as jest.Mock).mockClear();
  tap(control(root, "button", "Reset Zoom"));
  tap(control(root, "button", "Zoom In"));
  tap(control(root, "switch", "Night Shade"));
  await flush();
  tap(control(root, "switch", "Desktop Site"));
  await flush();
  expect(reset).toHaveBeenCalledWith("t0", 1);
  expect(siteCounts()).toEqual([]);
  unmount(root);
});

test("a second Reset Zoom that lands before the page reports its new zoom counts nothing, since the zoom it reads back is unchanged", async () => {
  const reset = jest.spyOn(pages, "setPageZoom").mockResolvedValue(1);
  usePages.setState((state) => ({ ...state, navigation: { t0: navigation("https://site0.example/", 1.25) } }));
  const root = await siteSettings();
  (telemetry.countUsage as jest.Mock).mockClear();
  tap(control(root, "button", "Reset Zoom"));
  await flush();
  tap(control(root, "button", "Reset Zoom"));
  await flush();
  expect(reset).toHaveBeenCalledTimes(2);
  expect(siteCounts()).toEqual(["site_settings_zoom_changed"]);
  unmount(root);
});

test("two queued Reset Zooms count once even when the page reports something else between them", async () => {
  const lands: ((zoom: number) => void)[] = [];
  const reset = jest.spyOn(pages, "setPageZoom").mockImplementation(() => new Promise((resolve) => lands.push(resolve)));
  usePages.setState((state) => ({ ...state, navigation: { t0: navigation("https://site0.example/", 1.25) } }));
  const root = await siteSettings();
  (telemetry.countUsage as jest.Mock).mockClear();
  tap(control(root, "button", "Reset Zoom"));
  tap(control(root, "button", "Reset Zoom"));
  await flush();
  act(() => {
    lands.shift()!(1);
    usePages.setState((state) => ({ ...state, navigation: { t0: { ...state.navigation.t0!, title: "Scrolled" } } }));
  });
  await flush();
  lands.shift()!(1);
  await flush();
  expect(reset).toHaveBeenCalledTimes(2);
  expect(siteCounts()).toEqual(["site_settings_zoom_changed"]);
  unmount(root);
});

test("Night Shade in the site group stays disabled until the site's own setting is read, and the header follows the page's current address", async () => {
  let answer: (mode: { mode: string }) => void = () => undefined;
  jest.spyOn(pages, "nightShade").mockImplementation((host) => (host === "moved-on.example" ? new Promise((resolve) => (answer = resolve as never)) : Promise.resolve({ mode: "disabled" })) as never);
  usePages.setState((state) => ({ ...state, navigation: { t0: navigation("https://moved-on.example/article") } }));
  act(() => void openPageMenu());
  const root = renderSurface(
    <DesignProvider design="original">
      <PageMenu tabId="t0" open onHidden={() => undefined} />
    </DesignProvider>,
  );
  await pressButton(root, "Site Settings");
  expect(textOf(root)).toContain("moved-on.example");
  expect(textOf(root)).not.toContain("site0.example");
  expect(control(root, "switch", "Night Shade")!.props.accessibilityState).toMatchObject({ disabled: true });
  expect(control(root, "switch", "Desktop Site")!.props.accessibilityState).toMatchObject({ disabled: false });
  answer({ mode: "always" });
  await flush();
  expect(control(root, "switch", "Night Shade")!.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  unmount(root);
});

test("from a private tab neither opening Site Settings nor changing its site is counted", async () => {
  jest.spyOn(pages, "zoomIn").mockResolvedValue(1.25);
  act(() => useTabs.setState((state) => ({ ...state, privates: [{ ...state.open[0]!, id: "p0", isPrivate: true }], selectedId: "p0", incognito: true })));
  act(() => usePages.setState((state) => ({ ...state, navigation: { p0: navigation("https://site0.example/") } })));
  const root = await siteSettings("p0");
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "siteSettings" });
  tap(control(root, "button", "Zoom In"));
  await flush();
  expect(pages.zoomIn).toHaveBeenCalledWith("p0");
  expect(siteCounts()).toEqual([]);
  unmount(root);
});

onAndroid("Site Settings opened from Settings has no group for a site, even while a page menu is open, and points to the page menu for one site", async () => {
  const menu = await openMenu();
  act(() => openSettings({ page: "siteSettings" }));
  const root = renderSurface(
    <DesignProvider design="original">
      <SettingsView />
    </DesignProvider>,
  );
  await flush();
  const words = textOf(root);
  expect(words).toContain("Block Cookie Banners");
  expect(words).toContain("Change one site from Site Settings in its page menu.");
  for (const gone of ["site0.example", "Page Zoom", "Desktop Site", "Desktop Site applies to this tab."]) expect(words).not.toContain(gone);
  expect(control(root, "switch", "Night Shade")).toBeUndefined();
  unmount(root);
  unmount(menu);
});
