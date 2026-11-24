import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import "../platform/copy";
import { blocking } from "../platform/blocking";
import { pages } from "../platform/pages";
import { SystemPageMenuHost } from "../components/browsing/SystemPageMenu";
import { ExpoLibrarySheet } from "../components/library/ExpoLibrary";
import { DesignProvider } from "../components/ui";
import { askTranslation, closePageMenu, confirmTranslation, openPageMenu, openSiteSettingsSheet, pageMenuHidden, pageMenuPresentation, printCurrentPage, setBlockersOn, setNightShadeOn, showFind } from "../state/page/actions";
import { useSettingsNav } from "../state/settings/nav";
import { registerPageHandle } from "../state/pages/store";
import { menuModel } from "../state/page/pageMenu";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { useBrowse } from "../state/browse/store";
import * as library from "../state/library/store";
import { useLibrary } from "../state/library/store";
import { useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { pressButton, renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const navigation = (url: string, isLoading: boolean) => ({ url, title: "Site", canGoBack: false, canGoForward: false, isLoading, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 }) as never;
const page = (url: string, isLoading: boolean) => act(() => usePages.setState((state) => ({ ...state, navigation: { t0: navigation(url, isLoading) } })));
const twoPages = (first: string, second: string) => act(() => usePages.setState((state) => ({ ...state, navigation: { t0: navigation(first, false), t1: navigation(second, false) } })));
const select = (id: string) => act(() => useTabs.setState({ selectedId: id }));

const flush = () => act(async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
});

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  act(() => usePageUi.setState({ menuOpen: false, menuPage: "main", menuSite: null, findOpen: false, readerTabId: null, press: null }));
  act(() => useBrowse.setState({ surface: "browsing", sheet: null }));
  act(() => useLibrary.setState({ open: false, section: "history", path: [], history: [], historyLoaded: false, files: [], filesLoaded: false }));
  jest.spyOn(library, "loadHistory").mockImplementation(() => undefined);
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "always" } as never);
  jest.spyOn(blocking, "isEnabledForSite").mockResolvedValue(false);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const sheetIn = (root: Root, testID: string) => {
  const anchor = hosts(root.root, (props) => props.testID === testID)[0];
  return anchor ? hosts(anchor, (props) => typeof props.isPresented === "boolean")[0]! : null;
};
const menuSheet = (root: Root) => sheetIn(root, "systemPageMenuSheet");
const showing = () => usePageUi.getState().menuOpening;
const titled = (node: ReactTestInstance, title: string) => hosts(node, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string; title?: string }[]).some((modifier) => modifier.$type === "navigationTitle" && modifier.title === title));

function menu() {
  return renderSurface(
    <DesignProvider design="redesigned">
      <SystemPageMenuHost tabId="t0" />
      <ExpoLibrarySheet />
    </DesignProvider>,
  );
}

const menuRows = (root: Root) => hosts(root.root, (props) => props.testID === "pageMenuWords");

onIos("the iPhone page menu mounts its rows once the page is quiet, before the first open, and keeps them mounted after it closes, so opening it only presents", async () => {
  page("https://site0.example/", true);
  const root = menu();
  expect(menuSheet(root)).toBeNull();
  page("https://site0.example/", false);
  expect(menuSheet(root)!.props.isPresented).toBe(false);
  const rows = menuRows(root)[0]!;
  expect(rows).toBeDefined();
  await act(async () => void openPageMenu());
  expect(menuSheet(root)!.props.isPresented).toBe(true);
  expect(menuRows(root)[0]).toBe(rows);
  act(() => menuSheet(root)!.props.onIsPresentedChange({ nativeEvent: { isPresented: false, token: showing() } }));
  expect(usePageUi.getState().menuOpen).toBe(false);
  act(() => menuSheet(root)!.props.onDismiss({ nativeEvent: { token: showing() } }));
  expect(menuSheet(root)!.props.isPresented).toBe(false);
  expect(menuRows(root)[0]).toBe(rows);
  unmount(root);
});

onIos("a settled page's Night Shade and blocker state is read ahead, so the menu opens with its real switches instead of flipping them as it rises", async () => {
  page("https://site0.example/", false);
  await flush();
  act(() => void openPageMenu());
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "site0.example", nightShade: "always", blockersEnabled: false });
  await flush();
});

onIos("Find on Page closes the menu at once and starts on the next frame, so the sheet begins leaving first and Find never waits for it to finish", async () => {
  page("https://site0.example/", false);
  jest.spyOn(pages, "hasSystemFind").mockReturnValue(true);
  const find = jest.spyOn(pages, "presentSystemFind").mockResolvedValue(undefined as never);
  const root = menu();
  await act(async () => void openPageMenu());
  act(() => showFind());
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(find).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(16));
  await flush();
  expect(find).toHaveBeenCalledWith("t0");
  unmount(root);
});

onIos("Print waits for the menu to be gone, runs once from the first of the sheet's disappearing or dismissal, and still runs if the menu's host goes first", async () => {
  page("https://site0.example/", false);
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  const print = jest.spyOn(pages, "print").mockResolvedValue(true);
  const root = menu();
  await act(async () => void openPageMenu());
  act(() => printCurrentPage());
  expect(print).not.toHaveBeenCalled();
  act(() => pageMenuHidden());
  act(() => menuSheet(root)!.props.onDismiss({ nativeEvent: { token: showing() } }));
  await flush();
  expect(print).toHaveBeenCalledTimes(1);
  await act(async () => void openPageMenu());
  act(() => printCurrentPage());
  unmount(root);
  await flush();
  expect(print).toHaveBeenCalledTimes(2);
});

onIos("a follow-up asked for on one tab is dropped when another tab is shown before the menu has gone", async () => {
  withTabs(2);
  select("t0");
  twoPages("https://site-a.example/", "https://site-b.example/");
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  const print = jest.spyOn(pages, "print").mockResolvedValue(true);
  await act(async () => void openPageMenu());
  act(() => printCurrentPage());
  select("t1");
  act(() => pageMenuHidden());
  await flush();
  expect(print).not.toHaveBeenCalled();
});

onIos("a late site read from one tab's menu never lands in another tab's menu, and its switches write to the site they show", async () => {
  withTabs(2);
  select("t0");
  let answerA: (mode: { mode: string }) => void = () => undefined;
  jest.spyOn(pages, "nightShade").mockImplementation((host) => (host === "late-a.example" ? new Promise((resolve) => (answerA = resolve as never)) : Promise.resolve({ mode: "disabled" })) as never);
  const write = jest.spyOn(pages, "setNightShade").mockResolvedValue(undefined as never);
  twoPages("https://late-a.example/", "https://late-b.example/");
  act(() => void openPageMenu());
  select("t1");
  await act(async () => void openPageMenu());
  await flush();
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "late-b.example", nightShade: "disabled" });
  answerA({ mode: "always" });
  await flush();
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "late-b.example", nightShade: "disabled" });
  act(() => setNightShadeOn(true));
  await flush();
  expect(write).toHaveBeenCalledWith("always", "late-b.example", false);
  select("t0");
  act(() => setNightShadeOn(false));
  await flush();
  expect(write).toHaveBeenCalledTimes(1);
});

onIos("History opens inside the page menu's own sheet at full height instead of waiting for the menu to close, and closing either closes both", async () => {
  page("https://site0.example/", false);
  const root = menu();
  await act(async () => void openPageMenu());
  await pressButton(root, "History");
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "library" });
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "history" });
  expect(sheetIn(root, "expoLibrarySheet")!.props.isPresented).toBe(false);
  expect(menuSheet(root)!.props.isPresented).toBe(true);
  expect(titled(menuSheet(root)!, "History")).not.toHaveLength(0);
  act(() => menuSheet(root)!.props.onIsPresentedChange({ nativeEvent: { isPresented: false, token: showing() } }));
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(useLibrary.getState().open).toBe(false);
  expect(sheetIn(root, "expoLibrarySheet")!.props.isPresented).toBe(false);
  await act(async () => void openPageMenu());
  await pressButton(root, "Bookmarks");
  act(() => library.closeLibrary());
  expect(usePageUi.getState().menuOpen).toBe(false);
  unmount(root);
});

onIos("a site read that started before a switch was turned never replaces what the switch wrote, in the menu or in the next opening", async () => {
  page("https://rewritten.example/", false);
  await flush();
  let answerLate: (mode: { mode: string }) => void = () => undefined;
  jest.spyOn(pages, "nightShade")
    .mockImplementationOnce(() => new Promise((resolve) => (answerLate = resolve as never)) as never)
    .mockResolvedValueOnce({ mode: "disabled" } as never)
    .mockImplementation(() => new Promise(() => undefined) as never);
  jest.spyOn(pages, "setNightShade").mockResolvedValue(undefined as never);
  const first = openPageMenu();
  act(() => closePageMenu());
  await act(async () => void (await openPageMenu()));
  act(() => setNightShadeOn(true));
  answerLate({ mode: "disabled" });
  await act(async () => void (await first));
  act(() => closePageMenu());
  act(() => void openPageMenu());
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "rewritten.example", nightShade: "always" });
});

onIos("turning blockers off reloads only the page it was turned off for: if the tab has moved on by then, nothing reloads", async () => {
  page("https://first-site.example/", false);
  let finishWrite: () => void = () => undefined;
  jest.spyOn(blocking, "setEnabledForSite").mockImplementation(() => new Promise<void>((resolve) => (finishWrite = resolve)) as never);
  const reload = jest.fn(() => Promise.resolve());
  registerPageHandle("t0", { reload } as never);
  await act(async () => void (await openPageMenu()));
  await flush();
  act(() => setBlockersOn(false));
  await flush();
  page("https://second-site.example/", false);
  finishWrite();
  await flush();
  expect(reload).not.toHaveBeenCalled();
  registerPageHandle("t0", null);
});

onIos("Print asked for on one page doesn't run on the page the tab moved to while the menu left", async () => {
  page("https://print-a.example/", false);
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  const print = jest.spyOn(pages, "print").mockResolvedValue(true);
  await act(async () => void openPageMenu());
  act(() => printCurrentPage());
  page("https://print-b.example/", false);
  act(() => pageMenuHidden());
  await flush();
  expect(print).not.toHaveBeenCalled();
});

onIos("a late dismissal from an earlier showing of the sheet can't spend a follow-up asked for in a newer one", async () => {
  page("https://tokens.example/", false);
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  const print = jest.spyOn(pages, "print").mockResolvedValue(true);
  await act(async () => void openPageMenu());
  const earlier = usePageUi.getState().menuOpening;
  act(() => pageMenuPresentation({ phase: "appear", token: earlier }));
  act(() => closePageMenu());
  await act(async () => void openPageMenu());
  const newer = usePageUi.getState().menuOpening;
  act(() => printCurrentPage());
  act(() => pageMenuPresentation({ phase: "disappear", token: earlier }));
  act(() => pageMenuPresentation({ phase: "dismiss", token: earlier }));
  act(() => pageMenuPresentation({ phase: "release", token: earlier }));
  await flush();
  expect(print).not.toHaveBeenCalled();
  act(() => pageMenuPresentation({ phase: "appear", token: newer }));
  act(() => pageMenuPresentation({ phase: "disappear", token: newer }));
  await flush();
  expect(print).toHaveBeenCalledTimes(1);
});

onIos("sheet reports without a known showing are dropped before they touch the menu", async () => {
  page("https://unknown-token.example/", false);
  await act(async () => void openPageMenu());
  act(() => pageMenuPresentation({ phase: "release", token: 0 }));
  act(() => pageMenuPresentation({ phase: "release", token: usePageUi.getState().menuOpening + 5 }));
  expect(usePageUi.getState().menuOpen).toBe(true);
});

onIos("a swipe-down reported for an earlier showing of the sheet doesn't close the newer one", async () => {
  page("https://release.example/", false);
  await act(async () => void openPageMenu());
  const earlier = usePageUi.getState().menuOpening;
  act(() => closePageMenu());
  await act(async () => void openPageMenu());
  act(() => pageMenuPresentation({ phase: "release", token: earlier }));
  expect(usePageUi.getState().menuOpen).toBe(true);
  act(() => pageMenuPresentation({ phase: "release", token: usePageUi.getState().menuOpening }));
  expect(usePageUi.getState().menuOpen).toBe(false);
});

onIos("a site read that lands while the opening still waits for translation details shows at once, and a switch turned after it stays where it was turned", async () => {
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "disabled" } as never);
  jest.spyOn(pages, "setNightShade").mockResolvedValue(undefined as never);
  let answerTranslation: (value: null) => void = () => undefined;
  jest.spyOn(pages, "translation").mockImplementation(() => new Promise((resolve) => (answerTranslation = resolve as never)) as never);
  page("https://deferred-menu.example/", false);
  await flush();
  const opened = openPageMenu();
  await flush();
  act(() => setNightShadeOn(true));
  answerTranslation(null);
  await act(async () => void (await opened));
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "deferred-menu.example", nightShade: "always" });
});

onIos("when the page under an open menu moves to another site, its switches wait for that site's own state", async () => {
  let answer: (mode: { mode: string }) => void = () => undefined;
  page("https://before-move.example/", false);
  await act(async () => void (await openPageMenu()));
  jest.spyOn(pages, "nightShade").mockImplementation(() => new Promise((resolve) => (answer = resolve as never)) as never);
  page("https://after-move.example/", false);
  await flush();
  expect(usePageUi.getState().menuSite?.host).toBe("before-move.example");
  answer({ mode: "always" });
  await flush();
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "after-move.example", nightShade: "always" });
});

onIos("a Translate button kept from a question that was already cleared does nothing, and a granted translation that finds the tab on another page by the time its address is ready doesn't load", async () => {
  page("https://stale-ask.example/", false);
  const load = jest.fn(() => Promise.resolve());
  registerPageHandle("t0", { loadUrl: load } as never);
  let answerUrl: (url: string) => void = () => undefined;
  jest.spyOn(pages, "translationUrl").mockImplementation(() => new Promise((resolve) => (answerUrl = resolve as never)) as never);
  jest.spyOn(pages, "confirmTranslation").mockResolvedValue(undefined as never);
  await act(async () => void openPageMenu());
  act(() => usePageUi.setState({ menuTranslation: { languageName: "English", confirmed: false } }));
  act(() => askTranslation());
  const kept = usePageUi.getState().translationAsk;
  act(() => usePageUi.setState({ translationAsk: null }));
  act(() => confirmTranslation(kept));
  answerUrl("https://translate.example/kept");
  await flush();
  expect(load).not.toHaveBeenCalled();
  await act(async () => void openPageMenu());
  act(() => usePageUi.setState({ menuTranslation: { languageName: "English", confirmed: false } }));
  act(() => askTranslation());
  act(() => confirmTranslation(usePageUi.getState().translationAsk));
  page("https://moved-on.example/", false);
  answerUrl("https://translate.example/late");
  await flush();
  expect(load).not.toHaveBeenCalled();
  registerPageHandle("t0", null);
});

onIos("the translation question belongs to the page it was asked on: closing the menu clears it, and accepting after the page changed sends nothing to Google", async () => {
  page("https://translate-a.example/", false);
  const load = jest.fn(() => Promise.resolve());
  registerPageHandle("t0", { loadUrl: load } as never);
  jest.spyOn(pages, "translationUrl").mockResolvedValue(null as never);
  await act(async () => void openPageMenu());
  act(() => usePageUi.setState({ menuTranslation: { languageName: "English", confirmed: false } }));
  act(() => askTranslation());
  const ask = usePageUi.getState().translationAsk;
  expect(ask).toMatchObject({ tabId: "t0", url: "https://translate-a.example/" });
  act(() => closePageMenu());
  expect(usePageUi.getState().translationAsk).toBeNull();
  page("https://translate-b.example/", false);
  act(() => confirmTranslation(ask));
  await flush();
  expect(load).not.toHaveBeenCalled();
  registerPageHandle("t0", null);
});

test("the menu's site switches stay off until the site's own state has loaded", () => {
  const base = { url: "https://a.example/", hasPage: true, canGoBack: false, canGoForward: false, isLoading: false, pageZoom: 1, zoomLevels: [], isDesktopSite: false, nightShade: "disabled" as const, systemDark: false, blockersEnabled: true, blockedRequests: 0 };
  expect(menuModel({ ...base, siteKnown: false }).siteSwitches).toBe(false);
  expect(menuModel({ ...base, siteKnown: true }).siteSwitches).toBe(true);
});

onIos("Share in the iPhone menu opens the page's own Share sheet over the menu, counts a print made from it, and closes the menu once it's done", async () => {
  page("https://share-print.example/", false);
  jest.spyOn(pages, "sharesWithPrint").mockReturnValue(true);
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  let finish: (activity: string | null) => void = () => undefined;
  const shared = jest.spyOn(pages, "sharePage").mockImplementation(() => new Promise((resolve) => (finish = resolve)) as never);
  const root = menu();
  await act(async () => void openPageMenu());
  await pressButton(root, "Share");
  expect(shared).toHaveBeenCalledWith("t0", "https://site0.example/", expect.any(String));
  expect(usePageUi.getState().menuOpen).toBe(true);
  finish("com.apple.UIKit.activity.Print");
  await flush();
  expect(counted).toHaveBeenCalledWith("pages_printed");
  expect(usePageUi.getState().menuOpen).toBe(false);
  unmount(root);
});

onIos("the menu sheet takes one detent as tall as its rows, measured only once the rows have a real width, and keeps it for the next open", async () => {
  page("https://measured.example/", false);
  const root = menu();
  await act(async () => void openPageMenu());
  const rows = () => hosts(root.root, (props) => props.testID === "pageMenuWords" && typeof props.onContentSizeChange === "function")[0]!;
  const detents = () => {
    const group = hosts(menuSheet(root)!, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "presentationDetents"))[0]!;
    return (group.props.modifiers as { $type: string; detents?: unknown }[]).find((modifier) => modifier.$type === "presentationDetents")!.detents;
  };
  expect(detents()).toEqual(["medium", "large"]);
  act(() => rows().props.onContentSizeChange(0, 4000));
  expect(detents()).toEqual(["medium", "large"]);
  act(() => rows().props.onContentSizeChange(393, 611.4));
  expect(detents()).toEqual([{ height: 612 }]);
  unmount(root);
  const again = menu();
  await act(async () => void openPageMenu());
  const group = hosts(sheetIn(again, "systemPageMenuSheet")!, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "presentationDetents"))[0]!;
  expect((group.props.modifiers as { $type: string; detents?: unknown }[]).find((modifier) => modifier.$type === "presentationDetents")!.detents).toEqual([{ height: 612 }]);
  unmount(again);
});

onIos("a site read that fails leaves the switches without a value instead of showing defaults, and nothing is remembered from it", async () => {
  jest.spyOn(pages, "nightShade").mockRejectedValue(new Error("gone"));
  page("https://read-fails.example/", false);
  await flush();
  act(() => usePageUi.setState({ menuSite: null }));
  await act(async () => void (await openPageMenu()));
  expect(usePageUi.getState().menuSite).toBeNull();
  act(() => closePageMenu());
  act(() => void openPageMenu());
  expect(usePageUi.getState().menuSite).toBeNull();
  await flush();
});

onIos("a Night Shade write that fails forgets the value it hoped for and shows the site's real state again", async () => {
  page("https://write-fails.example/", false);
  await act(async () => void (await openPageMenu()));
  jest.spyOn(pages, "setNightShade").mockRejectedValue(new Error("refused"));
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "disabled" } as never);
  act(() => setNightShadeOn(true));
  expect(usePageUi.getState().menuSite).toMatchObject({ nightShade: "always" });
  await flush();
  await flush();
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "write-fails.example", nightShade: "disabled" });
});

onIos("Site Settings asked for from the menu still opens if the page moves on while the menu leaves", async () => {
  page("https://settings-a.example/", false);
  act(() => useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false }));
  await act(async () => void openPageMenu());
  act(() => openSiteSettingsSheet());
  page("https://settings-b.example/", false);
  act(() => pageMenuHidden());
  expect(useSettingsNav.getState().open).toBe(true);
});
