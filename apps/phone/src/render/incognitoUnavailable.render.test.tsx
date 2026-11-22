import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { dismissSearch, presentSearch, searchState } from "../state/search/store";
import { INCOGNITO_NEEDS_WEBVIEW, PRIVATE_PAGES_UNAVAILABLE } from "../state/tabs/privatePages";
import { currentTabs, useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useToasts } from "../state/toasts/store";
import { renderSurface, someTabs, unmount, withTabs } from "../../test/render/harness";
import { PageSurface } from "../components/browsing/PageSurface";
import { launchTabs } from "../state/tabs/tabsState";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  return {
    ...actual,
    closePage: async () => undefined,
    pages: { ...actual.pages, endPrivateSession: async () => undefined, deleteSnapshots: async () => undefined },
  };
});

type Capabilities = ReturnType<typeof pages.capabilities>;

const engine = (ready: boolean, supportsPrivatePages: boolean): Capabilities => ({
  ready,
  engineName: "test",
  isDevelopmentOnly: true,
  supportsPrivatePages,
  pageZoomLevels: [],
  pageZoomScalesTextOnly: true,
  snapshotsIncludeVideo: false,
});

const webViewWith = (ready: boolean, supportsPrivatePages: boolean) => jest.spyOn(pages, "capabilities").mockReturnValue(engine(ready, supportsPrivatePages));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  act(() => {
    browse.useBrowse.setState({ surface: "start", sheet: null });
    useToasts.setState({ toast: null });
  });
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("a WebView that can't separate private pages keeps every Incognito switch off, says why and counts it once per refusal", () => {
  webViewWith(true, false);
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => browse.newIncognitoTab());
  expect(useTabs.getState().incognito).toBe(false);
  expect(searchState().open).toBe(false);
  expect(useToasts.getState().toast?.message).toBe(INCOGNITO_NEEDS_WEBVIEW);
  act(() => browse.switchDeckIncognito());
  act(() => browse.toggleTrayIncognito());
  act(() => browse.stayIncognito());
  expect(useTabs.getState().incognito).toBe(false);
  const fields = counted.mock.calls.map(([field]) => field);
  expect(fields.filter((field) => field === "incognito_unavailable")).toHaveLength(4);
  expect(fields).not.toContain("deck_incognito_switches");
  expect(fields).not.toContain("tray_incognito_switches");
});

test("tapping the refusal opens Android System WebView in the Play Store, and the web listing when the store can't open", async () => {
  webViewWith(true, false);
  const opened = jest.spyOn(Linking, "openURL").mockRejectedValueOnce(new Error("no store")).mockResolvedValue(undefined);
  act(() => browse.newIncognitoTab());
  expect(useToasts.getState().toast!.action!.label).toBe("Update");
  act(() => useToasts.getState().toast!.action!.run());
  await act(async () => undefined);
  expect(opened.mock.calls.map(([url]) => url)).toEqual(["market://details?id=com.google.android.webview", "https://play.google.com/store/apps/details?id=com.google.android.webview"]);
});

test("Incognito still turns on where private pages are separate, and while the engine isn't ready to say", () => {
  const capabilities = webViewWith(true, true);
  act(() => browse.newIncognitoTab());
  expect(useTabs.getState().incognito).toBe(true);
  expect(searchState().open).toBe(true);
  expect(useToasts.getState().toast).toBeNull();
  act(() => dismissSearch());
  act(() => useTabs.setState({ incognito: false }));
  capabilities.mockReturnValue(engine(false, false));
  act(() => browse.switchDeckIncognito());
  expect(useTabs.getState().incognito).toBe(true);
  expect(useToasts.getState().toast).toBeNull();
});

test("an Incognito page the engine refuses to open closes the Incognito tabs instead of staying blank, and the start page shows", () => {
  webViewWith(true, false);
  act(() => {
    useTabs.setState({ ...launchTabs(someTabs(2), 0), privates: someTabs(2, true), selectedId: "p0", incognito: true, listing: 0 });
    browse.useBrowse.setState({ surface: "browsing" });
  });
  act(() => browse.pageOpenFailed("p0", PRIVATE_PAGES_UNAVAILABLE));
  expect(currentTabs().privates).toHaveLength(0);
  expect(currentTabs().open).toHaveLength(2);
  expect(useTabs.getState().incognito).toBe(false);
  expect(browse.useBrowse.getState().surface).toBe("start");
  expect(useToasts.getState().toast?.message).toBe(INCOGNITO_NEEDS_WEBVIEW);
});

test("other page errors and regular tabs are left alone", () => {
  act(() => browse.useBrowse.setState({ surface: "browsing" }));
  const before = currentTabs();
  act(() => browse.pageOpenFailed(before.open[0]!.id, PRIVATE_PAGES_UNAVAILABLE));
  act(() => browse.pageOpenFailed(before.open[0]!.id, "ERR_SOMETHING_ELSE"));
  expect(currentTabs().open).toHaveLength(2);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(useToasts.getState().toast).toBeNull();
});

const browsingPrivately = () =>
  act(() => {
    useTabs.setState({ ...launchTabs(someTabs(2), 0), privates: someTabs(2, true), selectedId: "p0", incognito: true, listing: 0 });
    browse.useBrowse.setState({ surface: "browsing" });
  });

test("the page view's error event for a refused Incognito page reaches the recovery", () => {
  webViewWith(true, false);
  browsingPrivately();
  const root = renderSurface(<PageSurface tab={currentTabs().privates[0]!} toneBottom={0} />);
  const view = root.root.findAll((node) => typeof node.props.onPageError === "function")[0]!;
  act(() => view.props.onPageError({ code: PRIVATE_PAGES_UNAVAILABLE, message: "refused" }));
  expect(currentTabs().privates).toHaveLength(0);
  expect(useToasts.getState().toast?.message).toBe(INCOGNITO_NEEDS_WEBVIEW);
  unmount(root);
});

test("an Incognito search left open when its page is refused closes with the Incognito tabs, so Go can't open it in a regular tab", () => {
  webViewWith(true, false);
  browsingPrivately();
  act(() => presentSearch("page", "otters"));
  expect(searchState().open).toBe(true);
  act(() => browse.pageOpenFailed("p0", PRIVATE_PAGES_UNAVAILABLE));
  expect(searchState().open).toBe(false);
  expect(useTabs.getState().incognito).toBe(false);
});

test("opening a tab that was closed meanwhile keeps the current selection", () => {
  webViewWith(true, false);
  browsingPrivately();
  act(() => browse.pageOpenFailed("p0", PRIVATE_PAGES_UNAVAILABLE));
  const selected = currentTabs().selectedId;
  act(() => browse.openTab("p1"));
  expect(currentTabs().selectedId).toBe(selected);
  expect(browse.useBrowse.getState().surface).toBe("start");
});

test("opening a tab that now sits in the archive keeps the current selection too", () => {
  const [archived] = someTabs(1).map((tab) => ({ ...tab, id: "a0", archivedAt: 1_790_000_100_000 }));
  act(() => {
    useTabs.setState({ ...launchTabs(someTabs(2), 0), archive: [archived!], incognito: false, listing: 0 });
    browse.useBrowse.setState({ surface: "browsing" });
  });
  const selected = currentTabs().selectedId;
  act(() => browse.openTab("a0"));
  expect(currentTabs().selectedId).toBe(selected);
});

test("opening an Incognito tab while Incognito is refused closes the Incognito tabs and shows the start page instead of a page that can't load", () => {
  webViewWith(true, false);
  act(() => {
    useTabs.setState({ ...launchTabs(someTabs(2), 0), privates: someTabs(2, true), incognito: false, listing: 0 });
    browse.useBrowse.setState({ surface: "deck" });
  });
  act(() => browse.openTab("p0"));
  expect(currentTabs().privates).toHaveLength(0);
  expect(currentTabs().selectedId).not.toBe("p0");
  expect(useTabs.getState().incognito).toBe(false);
  expect(browse.useBrowse.getState().surface).toBe("start");
  expect(useToasts.getState().toast?.message).toBe(INCOGNITO_NEEDS_WEBVIEW);
});

test("a regular tab still opens while Incognito is refused", () => {
  webViewWith(true, false);
  act(() => browse.useBrowse.setState({ surface: "deck" }));
  const id = currentTabs().open[1]!.id;
  act(() => browse.openTab(id));
  expect(currentTabs().selectedId).toBe(id);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(useToasts.getState().toast).toBeNull();
});
