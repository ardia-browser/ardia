import { Platform, StyleSheet } from "react-native";
import { FABRIC_CATCH_UP_PING_MS } from "../components/ui/FabricCatchUp";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import "../platform/copy";
import { pages } from "../platform/pages";
import { blocking } from "../platform/blocking";
import { WarmPageMenuHost } from "../components/browsing/PageMenu";
import { DesignProvider, Sheet } from "../components/ui";
import { closePageMenu, handleSystemBack, openPageMenu, openSiteSettings, openSiteSettingsSheet } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { useSettingsNav } from "../state/settings/nav";
import { useBrowse } from "../state/browse/store";
import * as telemetry from "../state/telemetry/telemetry";
import { pressButton, renderSurface, textOf, unmount, updateSurface, withTabs } from "../../test/render/harness";
import { useMenuModel } from "../state/page/hooks";
import type { MenuModel } from "../state/page/pageMenu";

const BLOCKERS_ROW = "menuToggle:Block Ads and Trackers";
const SHEET_GONE_MS = 1000;

const navigation = (url: string, isLoading: boolean, blockedRequests = 0) => ({ url, title: "Site 0", canGoBack: false, canGoForward: false, isLoading, pageZoom: 1, isDesktopSite: false, blockedRequests }) as never;
const page = (url: string, isLoading: boolean, blockedRequests = 0) => act(() => usePages.setState((state) => ({ ...state, navigation: { t0: navigation(url, isLoading, blockedRequests) } })));

let printed: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  act(() => usePageUi.setState({ menuOpen: false, menuPage: "main", menuSite: null, findOpen: false, readerTabId: null, press: null }));
  act(() => useBrowse.setState({ surface: "browsing", sheet: null }));
  act(() => useSettingsNav.setState({ open: false, stack: [], popping: false }));
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "always" } as never);
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  printed = jest.spyOn(pages, "print").mockResolvedValue(true);
  jest.spyOn(blocking, "isEnabledForSite").mockResolvedValue(false);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const host = () =>
  renderSurface(
    <DesignProvider design="redesigned">
      <WarmPageMenuHost tabId="t0" />
    </DesignProvider>,
  );

const rowsIn = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "pageMenuWords");
const shownJson = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());
const sheetOf = (root: ReactTestRenderer): ReactTestInstance => root.root.findAll((node) => node.type === Sheet)[0]!;
const panelOf = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityViewIsModal === true)[0]!;

async function open() {
  await act(async () => {
    await openPageMenu();
  });
}

function closeAndSettle() {
  act(() => closePageMenu());
  act(() => jest.advanceTimersByTime(SHEET_GONE_MS));
}

test("the drawn page menu mounts once the page is quiet, hidden from touch and screen readers, and opening it reveals the same rows instead of building them", async () => {
  page("https://site0.example/", true);
  const root = host();
  expect(rowsIn(root)).toHaveLength(0);
  page("https://site0.example/", false);
  const rows = rowsIn(root)[0]!;
  expect(rows).toBeDefined();
  expect(shownJson(root)).not.toContain("pageMenuWords");
  await open();
  expect(rowsIn(root)[0]).toBe(rows);
  expect(shownJson(root)).toContain("pageMenuWords");
  closeAndSettle();
  expect(rowsIn(root)[0]).toBe(rows);
  expect(shownJson(root)).not.toContain("pageMenuWords");
  unmount(root);
});

function ModelProbe({ live, seen }: { live: boolean; seen: (model: MenuModel) => void }) {
  seen(useMenuModel("t0", live));
  return null;
}

test("a menu armed on a quiet web page builds its page rows while hidden, and opening keeps those same rows", async () => {
  page("https://site0.example/", false);
  const root = host();
  const pageRow = () => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === BLOCKERS_ROW)[0];
  const hidden = pageRow();
  expect(hidden).toBeDefined();
  await open();
  expect(pageRow()).toBe(hidden);
  unmount(root);
});

test("a hidden menu catches up with a page that settles while it is closed, so the rows a new page needs are built before the press", async () => {
  act(() => usePages.setState((state) => ({ ...state, navigation: {} })));
  const root = host();
  await open();
  closeAndSettle();
  const pageRow = () => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === BLOCKERS_ROW)[0];
  expect(pageRow()).toBeUndefined();
  page("https://site0.example/", true, 3);
  expect(pageRow()).toBeUndefined();
  page("https://site0.example/", false, 4);
  const built = pageRow();
  expect(built).toBeDefined();
  await open();
  expect(pageRow()).toBe(built);
  unmount(root);
});

test("a closed page menu's model holds still while its page loads and as requests are blocked, follows the page once it settles, and reads it afresh the moment it goes live", () => {
  page("https://site0.example/", false);
  const seen = jest.fn();
  const root = renderSurface(<ModelProbe live={false} seen={seen} />);
  seen.mockClear();
  for (let blocked = 1; blocked <= 4; blocked++) page("https://site0.example/next", true, blocked);
  expect(seen).not.toHaveBeenCalled();
  page("https://site0.example/next", false, 5);
  expect(seen).toHaveBeenCalledTimes(1);
  expect(seen.mock.calls[0]![0]).toMatchObject({ reload: "reload", blockedCount: null });
  page("https://site0.example/next", false, 6);
  expect(seen).toHaveBeenCalledTimes(1);
  updateSurface(root, <ModelProbe live seen={seen} />);
  expect(seen).toHaveBeenCalledTimes(2);
  expect(seen.mock.calls[1]![0]).toMatchObject({ reload: "reload", blockedCount: "6" });
  page("https://site0.example/next", true, 7);
  expect(seen).toHaveBeenCalledTimes(3);
  unmount(root);
});

test("on Android the page menu opens as the iPhone's inset card at its medium stop, with a grabber, and elsewhere keeps its fitted sheet", async () => {
  page("https://site0.example/", false);
  const root = host();
  await open();
  const style = StyleSheet.flatten(panelOf(root).props.style);
  const floating = root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "floatingSheetCard");
  if (Platform.OS === "android") {
    expect(floating).toHaveLength(1);
    expect(sheetOf(root).props.floating).toBe(true);
    expect(style.height).toBeGreaterThan(0);
    expect(style.maxHeight).toBeUndefined();
  } else {
    expect(floating).toHaveLength(0);
    expect(style.height).toBeUndefined();
    expect(style.maxHeight).toBeGreaterThan(0);
  }
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "sheetGrabber")).toHaveLength(1);
  expect(sheetOf(root).props.catchUpPingMs).toBe(Platform.OS === "android" ? FABRIC_CATCH_UP_PING_MS : undefined);
  unmount(root);
});

test("an earlier showing's late hide neither hides the menu that opened after it nor runs that menu's follow-up", async () => {
  page("https://site0.example/", false);
  const root = host();
  await open();
  act(() => closePageMenu());
  const staleHidden = sheetOf(root).props.onHidden as () => void;
  await open();
  await pressButton(root, "Print");
  await act(async () => {
    staleHidden();
  });
  expect(printed).not.toHaveBeenCalled();
  expect(shownJson(root)).toContain("pageMenuWords");
  await act(async () => {
    jest.advanceTimersByTime(SHEET_GONE_MS);
  });
  expect(printed).toHaveBeenCalledTimes(1);
  expect(shownJson(root)).not.toContain("pageMenuWords");
  unmount(root);
});

test("Site Settings opens inside the drawn menu at once, with the site's group first, and system Back returns to the menu's main page", async () => {
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  page("https://site0.example/", false);
  const root = host();
  await open();
  await pressButton(root, "Site Settings");
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "siteSettings" });
  expect(useSettingsNav.getState().open).toBe(false);
  expect(shownJson(root)).not.toContain("pageMenuWords");
  const words = textOf(root);
  expect(words.indexOf("site0.example")).toBeGreaterThanOrEqual(0);
  expect(words.indexOf("site0.example")).toBeLessThan(words.indexOf("Block Cookie Banners"));
  act(() => {
    handleSystemBack();
  });
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "main" });
  expect(shownJson(root)).toContain("pageMenuWords");
  unmount(root);
});

test("a Site Settings press that lands after the menu has closed opens nothing and counts nothing", async () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  page("https://site0.example/", false);
  const root = host();
  await open();
  closeAndSettle();
  act(() => openSiteSettings());
  act(() => openSiteSettingsSheet());
  expect(usePageUi.getState()).toMatchObject({ menuOpen: false, menuPage: "main", menuSettings: null });
  expect(useSettingsNav.getState().open).toBe(false);
  expect(counted.mock.calls.map(([field]) => field)).not.toContain("page_menu_site_settings_opened");
  unmount(root);
});
