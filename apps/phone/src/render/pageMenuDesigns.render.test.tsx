import { useDefaultBrowser } from "../state/settings/defaultBrowser";
import { Dimensions, StyleSheet } from "react-native";
import { act, type ReactTestRenderer } from "react-test-renderer";
import "../platform/copy";
import { pages } from "../platform/pages";
import { PageMenu } from "../components/browsing/PageMenu";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { openPageMenu } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { setPageSummariesEnabled, usePageSummariesSwitch } from "../state/pageSummary/enabled";
import { registerPageHandle, usePages } from "../state/pages/store";
import { useSettingsNav } from "../state/settings/nav";
import { useBrowse } from "../state/browse/store";
import { useLibrary } from "../state/library/store";
import { OFF_STATUS, useSync, type SyncedProfile } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useTabs } from "../state/tabs/store";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const realWindow = Dimensions.get("window");

const page = (url: string, isLoading = false) =>
  usePages.setState((state) => ({ ...state, navigation: { t0: { url, title: "Site 0", canGoBack: false, canGoForward: false, isLoading, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } }));

let printed: jest.SpyInstance;
let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  page("https://site0.example/");
  useBrowse.setState({ surface: "browsing", sheet: null });
  useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false });
  useDefaultBrowser.setState({ status: { isDefault: false, canAsk: true } });
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } as never }));
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  printed = jest.spyOn(pages, "print").mockResolvedValue(true);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  usePageSummariesSwitch.setState({ enabled: true });
});

afterEach(() => {
  Dimensions.set({ window: realWindow, screen: realWindow });
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function LiveMenu() {
  const open = usePageUi((s) => s.menuOpen);
  return <PageMenu tabId="t0" open={open} onHidden={() => undefined} />;
}

async function openMenu(design: Design) {
  await act(async () => {
    await openPageMenu();
  });
  return renderSurface(
    <DesignProvider design={design}>
      <LiveMenu />
    </DesignProvider>,
  );
}

const hosts = (root: ReactTestRenderer, match: (testID: string) => boolean) =>
  root.root.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string" && match(node.props.testID));
const host = (root: ReactTestRenderer, testID: string) => hosts(root, (id) => id === testID)[0];

const ROW_IDS = /^(pageMenuRow:|menuToggle:|menuZoom$)/;
const rowTitle = (testID: string) => (testID === "menuZoom" ? "Page Zoom" : testID.replace(/^(pageMenuRow|menuToggle):/, ""));
const wordRows = (root: ReactTestRenderer) => hosts(root, (id) => ROW_IDS.test(id)).map((node) => rowTitle(node.props.testID));
const symbolsIn = (node: { findAll: ReactTestRenderer["root"]["findAll"] }) => node.findAll((child) => (child.type as { name?: string })?.name === "Symbol");
const labelled = (root: ReactTestRenderer, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0];
const textSize = (scale: number) => Dimensions.set({ window: { ...realWindow, fontScale: scale }, screen: { ...realWindow, fontScale: scale } });

function withOneMac() {
  const profile = { syncId: "work", name: "Work", color: null, icon: null, isDefault: true, theme: null, deviceTabs: [], pinned: { tiles: [], sections: [] }, bookmarks: [], history: [], sendTargets: ["mac"] } as SyncedProfile;
  const mac = { id: "mac", name: "Studio", kind: "mac", lastSeen: 1, isCurrent: false, canReceiveTabs: true };
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
    view: { devices: [mac], profiles: [profile], search: null, syncedAt: 1, selectedProfileId: "work", shownProfileId: "work", receivers: [] } as never,
  }));
}

test("the original menu is unchanged: icon rows and tiles, no glass capsules, Print only where the phone can print, and Site Settings opens inside the menu", async () => {
  jest.spyOn(pages, "canPrint").mockReturnValue(false);
  const root = await openMenu("original");
  expect(host(root, "pageMenuWords")).toBeUndefined();
  expect(hosts(root, (id) => id.startsWith("pageMenuAction:"))).toHaveLength(0);
  expect(textOf(root)).toContain("Find on Page");
  expect(textOf(root)).toContain("Reader");
  expect(textOf(root)).not.toContain("Print");
  expect(StyleSheet.flatten(host(root, "sheetFill")!.props.style).backgroundColor).toBe("#F2F2F7");
  await pressButton(root, "Site Settings");
  expect(usePageUi.getState().menuPage).toBe("siteSettings");
  expect(useSettingsNav.getState().open).toBe(false);
  unmount(root);
});

test("the redesign's page menu shows every row at once, with no More row: the navigation bar, the four tiles and four groups", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  withOneMac();
  const root = await openMenu("redesigned");
  expect(host(root, "pageMenuRow:More")).toBeUndefined();
  expect(hosts(root, (id) => id.startsWith("pageMenuAction:"))).toHaveLength(4);
  expect(host(root, "pageMenuCapsule")).toBeDefined();
  expect(wordRows(root)).toEqual(["Summarize Page", "Send to Studio", "Block Ads and Trackers", "Night Shade", "Page Zoom", "Desktop Site", "Translate", "Print", "Site Settings", "History", "Bookmarks", "Downloads", "Open in Default Browser"]);
  expect(hosts(root, (id) => id === "pageMenuGroup")).toHaveLength(4);
  unmount(root);
});

test("the redesign has main's word rows in main's order, each with its icon, in main's groups, with the Library's rows on both phones", async () => {
  const root = await openMenu("redesigned");
  expect(wordRows(root)).toEqual(["Block Ads and Trackers", "Night Shade", "Page Zoom", "Desktop Site", "Translate", "Print", "Site Settings", "History", "Bookmarks", "Downloads", "Open in Default Browser"]);
  expect(hosts(root, (id) => id === "pageMenuGroup")).toHaveLength(4);
  for (const row of hosts(root, (id) => id.startsWith("pageMenuRow:") || id.startsWith("menuToggle:"))) expect(symbolsIn(row)).toHaveLength(1);
  unmount(root);
});

test("on both phones the page menu's History, Bookmarks and Downloads close the menu and open that Library sheet, as main's do", async () => {
  for (const section of ["history", "bookmarks", "downloads"] as const) {
    useLibrary.setState({ open: false, section: "history", path: [] });
    const root = await openMenu("redesigned");
    const title = section === "history" ? "History" : section === "bookmarks" ? "Bookmarks" : "Downloads";
    await pressButton(root, title);
    expect(usePageUi.getState().menuOpen).toBe(false);
    expect(useLibrary.getState()).toMatchObject({ open: true, section });
    expect(counted).toHaveBeenCalledWith("library_opened");
    unmount(root);
  }
});

test("opening the Library from an Incognito page isn't counted", async () => {
  useTabs.setState({ incognito: true });
  const root = await openMenu("redesigned");
  await pressButton(root, "History");
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "history" });
  expect(counted).not.toHaveBeenCalledWith("library_opened");
  unmount(root);
});

test("the redesign puts Send above Block Ads and Trackers, in the first group", async () => {
  withOneMac();
  const root = await openMenu("redesigned");
  expect(wordRows(root).slice(0, 2)).toEqual(["Send to Studio", "Block Ads and Trackers"]);
  unmount(root);
});

test("the redesign's Reader, Find on Page, Copy Link and Share are square rounded tiles with their label under them, in one row under a pill navigation bar, in the bottom sheet", async () => {
  const root = await openMenu("redesigned");
  const capsules = hosts(root, (id) => id.startsWith("pageMenuAction:"));
  expect(capsules.map((node) => node.props.testID)).toEqual(["pageMenuAction:Reader", "pageMenuAction:Find on Page", "pageMenuAction:Copy Link", "pageMenuAction:Share"]);
  for (const capsule of capsules) {
    expect(textOf({ root: capsule } as never)).toBe(capsule.props.testID.slice("pageMenuAction:".length));
    expect(symbolsIn(capsule)).toHaveLength(1);
  }
  const nav = host(root, "pageMenuCapsule")!;
  for (const label of ["Back", "Forward", "Pin to Mac", "Reload"]) expect(nav.findAll((node) => node.props.accessibilityLabel === label).length).toBeGreaterThan(0);
  expect(textOf({ root: nav } as never)).toContain("Site 0");
  expect(host(root, "pageMenuCapsuleRow")!.findAll((node) => node.props.testID === "pageMenuTitle" && typeof node.type === "string")).toHaveLength(1);
  expect(StyleSheet.flatten(nav.props.style).borderRadius).toBe(StyleSheet.flatten(host(root, "pageMenuCapsuleRow")!.props.style).minHeight / 2);
  expect(host(root, "pageMenuCard")).toBeUndefined();
  expect(StyleSheet.flatten(host(root, "sheetFill")!.props.style)).toMatchObject({ backgroundColor: "#F2F2F7" });
  unmount(root);
});

test("the redesign's capsules are off on a page that isn't on the web, and Print with them", async () => {
  page("about:blank");
  const root = await openMenu("redesigned");
  for (const label of ["Reader", "Copy Link", "Share"]) expect(labelled(root, label)!.props.accessibilityState).toMatchObject({ disabled: true });
  expect(host(root, "pageMenuRow:Print")!.props.accessibilityState).toMatchObject({ disabled: true });
  unmount(root);
});

test("Print shows only where the phone can print", async () => {
  jest.spyOn(pages, "canPrint").mockReturnValue(false);
  const root = await openMenu("redesigned");
  expect(wordRows(root)).not.toContain("Print");
  expect(wordRows(root).slice(3, 6)).toEqual(["Desktop Site", "Translate", "Site Settings"]);
  unmount(root);
});

test("Print closes the menu, then prints the current page once the sheet has gone, and counts it", async () => {
  const root = await openMenu("redesigned");
  await pressButton(root, "Print");
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(printed).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(printed).toHaveBeenCalledTimes(1);
  expect(printed).toHaveBeenCalledWith("t0");
  expect(counted).toHaveBeenCalledWith("pages_printed");
  unmount(root);
});

test("a private page prints but is never counted, and a print that didn't open isn't counted", async () => {
  useTabs.setState((state) => ({ ...state, open: state.open.map((tab) => ({ ...tab, isPrivate: true })) }));
  const root = await openMenu("redesigned");
  await pressButton(root, "Print");
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(printed).toHaveBeenCalledWith("t0");
  expect(counted).not.toHaveBeenCalledWith("pages_printed");
  unmount(root);
  useTabs.setState((state) => ({ ...state, open: state.open.map((tab) => ({ ...tab, isPrivate: false })) }));
  printed.mockResolvedValue(false);
  const again = await openMenu("redesigned");
  await pressButton(again, "Print");
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(printed).toHaveBeenCalledTimes(2);
  expect(counted).not.toHaveBeenCalledWith("pages_printed");
  unmount(again);
});

test("Summarize Page shows only where the phone summarizes, under Find on Page", async () => {
  const absent = await openMenu("redesigned");
  expect(wordRows(absent)).not.toContain("Summarize Page");
  unmount(absent);
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  const root = await openMenu("redesigned");
  const rows = wordRows(root);
  expect(rows[rows.indexOf("Find on Page") + 1]).toBe("Summarize Page");
  expect(host(root, "pageMenuRow:Summarize Page")!.props.accessibilityState).toMatchObject({ disabled: false });
  unmount(root);
});

test("Summarize Page stays out of the menu until Pinch to Summarize is turned on in Settings", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  usePageSummariesSwitch.setState({ enabled: false });
  const root = await openMenu("redesigned");
  expect(wordRows(root)).not.toContain("Summarize Page");
  act(() => usePageSummariesSwitch.setState({ enabled: true }));
  expect(wordRows(root)).toContain("Summarize Page");
  unmount(root);
  usePageSummariesSwitch.setState({ enabled: false });
  const original = await openMenu("original");
  expect(textOf(original)).not.toContain("Summarize Page");
  unmount(original);
});

test("turning Pinch to Summarize off while the menu closes cancels the summary request", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  const summarized = jest.spyOn(pages, "summarize").mockResolvedValue(true);
  const root = await openMenu("redesigned");
  await pressButton(root, "Summarize Page");
  await act(async () => {
    usePageSummariesSwitch.setState({ enabled: false });
    jest.advanceTimersByTime(1000);
  });
  expect(summarized).not.toHaveBeenCalled();
  unmount(root);
});

test("turning Pinch to Summarize back on does not revive a request queued before it was turned off", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  jest.spyOn(pages, "switchesSummaries").mockReturnValue(true);
  jest.spyOn(pages, "setSummariesEnabled").mockImplementation(async (enabled) => enabled);
  const summarized = jest.spyOn(pages, "summarize").mockResolvedValue(true);
  const root = await openMenu("redesigned");
  await pressButton(root, "Summarize Page");
  await act(async () => {
    await setPageSummariesEnabled(false);
    await setPageSummariesEnabled(true);
    jest.advanceTimersByTime(1000);
  });
  expect(summarized).not.toHaveBeenCalled();
  unmount(root);
});

test("Summarize Page closes the menu, then summarizes the current page once the sheet has gone, and leaves counting to the page's own events", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  const summarized = jest.spyOn(pages, "summarize").mockResolvedValue(true);
  const root = await openMenu("redesigned");
  await pressButton(root, "Summarize Page");
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(summarized).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(summarized).toHaveBeenCalledTimes(1);
  expect(summarized).toHaveBeenCalledWith("t0");
  expect(counted).not.toHaveBeenCalledWith("page_summaries_from_menu");
  unmount(root);
});

test("the original menu offers Summarize Page where the phone can summarize", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  const root = await openMenu("original");
  expect(textOf(root)).toContain("Summarize Page");
  unmount(root);
});

test("a reload during the menu dismissal cancels the summary request", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  const summarized = jest.spyOn(pages, "summarize").mockResolvedValue(true);
  const root = await openMenu("redesigned");
  await pressButton(root, "Summarize Page");
  await act(async () => {
    page("https://site0.example/", true);
    jest.advanceTimersByTime(1000);
  });
  expect(summarized).not.toHaveBeenCalled();
  unmount(root);
});

test("Summarize Page is off on a page that isn't on the web", async () => {
  jest.spyOn(pages, "canSummarize").mockReturnValue(true);
  page("about:blank");
  const root = await openMenu("redesigned");
  expect(host(root, "pageMenuRow:Summarize Page")!.props.accessibilityState).toMatchObject({ disabled: true });
  unmount(root);
});

test("a print asked for and then given up by reopening the menu doesn't run later", async () => {
  const root = await openMenu("redesigned");
  await pressButton(root, "Print");
  await act(async () => {
    await openPageMenu();
  });
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(printed).not.toHaveBeenCalled();
  unmount(root);
});

test("the redesign's Site Settings closes the menu and opens Settings at Site Settings, as main", async () => {
  const root = await openMenu("redesigned");
  await pressButton(root, "Site Settings");
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(usePageUi.getState().menuPage).toBe("main");
  expect(useSettingsNav.getState().open).toBe(true);
  expect(useSettingsNav.getState().stack.at(-1)).toEqual({ page: "siteSettings" });
  unmount(root);
});

test("at accessibility text sizes the redesign's title moves under the navigation buttons and the zoom controls stack, while the capsules stay icons", async () => {
  textSize(1.7);
  const root = await openMenu("redesigned");
  const titlesIn = (testID: string) => host(root, testID)!.findAll((node) => node.props.testID === "pageMenuTitle" && typeof node.type === "string").length;
  expect(titlesIn("pageMenuCapsule")).toBe(1);
  expect(titlesIn("pageMenuCapsuleRow")).toBe(0);
  expect(StyleSheet.flatten(host(root, "menuZoom")!.props.style).flexDirection).not.toBe("row");
  expect(hosts(root, (id) => id.startsWith("pageMenuAction:"))).toHaveLength(4);
  unmount(root);
});

function withTranslation(start: { languageName: string | null; confirmed: boolean }) {
  const state = { language: start.languageName ? "de" : null, ...start };
  jest.spyOn(pages, "translation").mockImplementation(async () => ({ ...state }));
  const confirmed = jest.spyOn(pages, "confirmTranslation").mockImplementation(async () => {
    state.confirmed = true;
  });
  const asked = jest.spyOn(pages, "translationUrl").mockImplementation(async (url: string) => `https://translate.google.com/translate?sl=auto&tl=${state.language ?? "en"}&u=${encodeURIComponent(url)}`);
  const loaded: string[] = [];
  registerPageHandle("t0", { loadUrl: async (url: string) => void loaded.push(url) } as never);
  return { confirmed, asked, loaded };
}

for (const design of ["redesigned", "original"] as const) {
  test(`${design}: Translate asks about Google the first time, and the answer stands: the next one goes straight there, as main's does`, async () => {
    const { confirmed, loaded } = withTranslation({ languageName: null, confirmed: false });
    const first = await openMenu(design);
    await pressButton(first, "Translate");
    expect(textOf(first)).toContain("Translate with Google?");
    expect(loaded).toHaveLength(0);
    const answer = first.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as ReactTestRenderer) === "Translate").pop()!;
    await act(async () => {
      answer.props.onPress();
    });
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual(["https://translate.google.com/translate?sl=auto&tl=en&u=https%3A%2F%2Fsite0.example%2F"]);
    expect(counted).toHaveBeenCalledWith("pages_translated");
    expect(usePageUi.getState().menuOpen).toBe(false);
    unmount(first);
    const second = await openMenu(design);
    await pressButton(second, "Translate");
    expect(textOf(second)).not.toContain("Translate with Google?");
    expect(loaded).toHaveLength(2);
    unmount(second);
    registerPageHandle("t0", null);
  });

  test(`${design}: the row names the remembered language and opens the page in it`, async () => {
    const { loaded } = withTranslation({ languageName: "German", confirmed: true });
    const root = await openMenu(design);
    expect(textOf(root)).toContain("Translate to German");
    await pressButton(root, "Translate to German");
    expect(loaded).toEqual(["https://translate.google.com/translate?sl=auto&tl=de&u=https%3A%2F%2Fsite0.example%2F"]);
    unmount(root);
    registerPageHandle("t0", null);
  });

  test(`${design}: an Incognito tab always asks, and its answer is not kept`, async () => {
    const { confirmed, loaded } = withTranslation({ languageName: "German", confirmed: true });
    useTabs.setState((state) => ({ ...state, open: [], privates: [{ ...state.open[0]!, isPrivate: true }], incognito: true }));
    const root = await openMenu(design);
    await pressButton(root, "Translate to German");
    expect(textOf(root)).toContain("Translate with Google?");
    expect(loaded).toHaveLength(0);
    const answer = root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as ReactTestRenderer) === "Translate").pop()!;
    await act(async () => {
      answer.props.onPress();
    });
    expect(loaded).toHaveLength(1);
    expect(confirmed).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalledWith("pages_translated");
    unmount(root);
    registerPageHandle("t0", null);
  });
}
