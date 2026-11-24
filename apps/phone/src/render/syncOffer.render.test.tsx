import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { PageMenu } from "../components/browsing/PageMenu";
import { SettingsView } from "../components/settings/SettingsView";
import { StartScreen } from "../components/search/StartScreen";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { openPageMenu, pinCurrentToMac } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { openSpaces, useBrowse } from "../state/browse/store";
import { offerSyncPages, openSettings, useSettingsNav } from "../state/settings/nav";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

let mockOffered = false;

const onAndroid = Platform.OS === "android" ? test : test.skip;

jest.mock("../platform/system", () => ({ ...jest.requireActual<object>("../platform/system"), syncOffered: () => mockOffered }));

type Root = ReturnType<typeof renderSurface>;

const labelled = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function");
const hosts = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const inDesign = (design: Design, node: React.ReactNode) => renderSurface(<DesignProvider design={design}>{node}</DesignProvider>);

function LiveMenu() {
  const open = usePageUi((s) => s.menuOpen);
  return <PageMenu tabId="t0" open={open} onHidden={() => undefined} />;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockOffered = false;
  offerSyncPages(() => mockOffered);
  withTabs(1);
  usePages.setState((state) => ({ ...state, navigation: { t0: { url: "https://site0.example/", title: "Site 0", canGoBack: false, canGoForward: false, isLoading: false, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } }));
  useBrowse.setState({ surface: "browsing", sheet: null });
  useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false });
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } as never }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  offerSyncPages(() => true);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

onAndroid("where sync isn't offered, Android's Settings has no Sync card and no Spaces shortcut, the Spaces sheet and the sync pages never open, and Appearance offers no Match My Mac", () => {
  act(() => openSettings());
  const root = inDesign("original", <SettingsView />);
  const texts = root.root.findAll((node) => typeof node.type === "string" && typeof node.props.children === "string").map((node) => node.props.children as string);
  expect(texts).toContain("Archive");
  expect(texts).not.toContain("Spaces");
  expect(textOf(root)).not.toContain("Sync With");
  act(() => openSpaces());
  expect(useBrowse.getState().sheet).toBeNull();
  act(() => openSettings({ page: "sync" }));
  expect(useSettingsNav.getState().stack.map((route) => route.page)).toEqual(["root"]);
  act(() => openSettings({ page: "appearance" }));
  expect(textOf(root)).not.toContain("Match My Mac");
  expect(labelled(root, "Glass")[0]!.props.accessibilityState).toEqual({ selected: true });
  expect(labelled(root, "System")[0]!.props.accessibilityState).toEqual({ selected: true });
  unmount(root);
});

test("where sync isn't offered, the start page has no Sync With Your Mac invitation and shows the Ardia mark, and the page menu has no Pin to Mac", async () => {
  act(() => useBrowse.setState({ surface: "start" }));
  const start = inDesign("redesigned", <StartScreen />);
  expect(hosts(start, "startSyncInvitation")).toHaveLength(0);
  expect(hosts(start, "startLogo")).toHaveLength(1);
  unmount(start);
  act(() => useBrowse.setState({ surface: "browsing" }));
  const menu = inDesign("redesigned", <LiveMenu />);
  await act(async () => {
    await openPageMenu();
  });
  act(() => jest.advanceTimersByTime(500));
  expect(labelled(menu, "Pin to Mac")).toHaveLength(0);
  act(() => pinCurrentToMac());
  expect(useSettingsNav.getState().open).toBe(false);
  unmount(menu);
});

test("where sync is offered, the start page still shows only the Ardia mark and keeps Sync in Settings, and the page menu offers Pin to Mac", async () => {
  mockOffered = true;
  act(() => useBrowse.setState({ surface: "start" }));
  const start = inDesign("redesigned", <StartScreen />);
  expect(hosts(start, "startSyncInvitation")).toHaveLength(0);
  expect(hosts(start, "startLogo")).toHaveLength(1);
  unmount(start);
  act(() => useBrowse.setState({ surface: "browsing" }));
  const menu = inDesign("redesigned", <LiveMenu />);
  await act(async () => {
    await openPageMenu();
  });
  act(() => jest.advanceTimersByTime(500));
  expect(labelled(menu, "Pin to Mac").length).toBeGreaterThan(0);
  unmount(menu);
});
