import { useDefaultBrowser } from "../state/settings/defaultBrowser";
import { Dimensions, Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import "../platform/copy";
import { PageMenu } from "../components/browsing/PageMenu";
import { blocking } from "../platform/blocking";
import { pages } from "../platform/pages";
import * as pageActions from "../state/page/actions";
import { usePages } from "../state/pages/store";
import { useSettingsNav } from "../state/settings/nav";
import { useBrowse } from "../state/browse/store";
import { useTabs } from "../state/tabs/store";
import { selectedTab } from "../state/tabs/tabsState";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;
const realWindow = Dimensions.get("window");

const page = (url: string) =>
  usePages.setState((state) => ({ ...state, navigation: { t0: { url, title: "Site 0", canGoBack: false, canGoForward: false, isLoading: false, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  page("https://site0.example/");
  useBrowse.setState({ surface: "browsing", sheet: null });
  useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false });
  useDefaultBrowser.setState({ status: { isDefault: false, canAsk: true } });
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "disabled" } as never);
  jest.spyOn(blocking, "isEnabledForSite").mockResolvedValue(true);
});

afterEach(() => {
  Dimensions.set({ window: realWindow, screen: realWindow });
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function openMenu() {
  await act(async () => {
    await pageActions.openPageMenu();
  });
  return renderSurface(<PageMenu tabId={selectedTab(useTabs.getState())!.id} open onHidden={() => undefined} />);
}

const host = (root: ReturnType<typeof renderSurface>, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0]!;
const hiddenFromReaders = (node: ReactTestInstance) => {
  for (let at: ReactTestInstance | null = node; at; at = at.parent) if (at.props.importantForAccessibility === "no-hide-descendants") return true;
  return false;
};
const textSize = (scale: number) => Dimensions.set({ window: { ...realWindow, fontScale: scale }, screen: { ...realWindow, fontScale: scale } });

const BLOCKERS = "Block Ads and Trackers";

test("each toggle row is one switch for screen readers, named and with its state, and its words are hidden so they aren't read twice", async () => {
  const root = await openMenu();
  const row = host(root, `menuToggle:${BLOCKERS}`);
  expect(row.props.accessibilityRole).toBe("switch");
  expect(row.props.accessibilityLabel).toBe(BLOCKERS);
  expect(row.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "switch" && node.props.accessibilityLabel === BLOCKERS)).toHaveLength(1);
  const words = root.root.findAll((node) => typeof node.type === "string" && node.props.children === BLOCKERS)[0]!;
  expect(hiddenFromReaders(words)).toBe(true);
  unmount(root);
});

test("the blockers switch closes the menu and reloads the page and says so in its hint", async () => {
  const flip = jest.spyOn(pageActions, "setBlockersOn").mockImplementation(() => undefined as never);
  const root = await openMenu();
  expect(host(root, `menuToggle:${BLOCKERS}`).props.accessibilityHint).toBe("Closes the menu and reloads the page.");
  act(() => root.root.findAll((node) => node.props.testID === `menuToggle:${BLOCKERS}` && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(flip).toHaveBeenCalledWith(false);
  unmount(root);
});

test("the page menu has no Night Shade, Page Zoom or Desktop Site rows, and no History, Bookmarks or Downloads: those live in Site Settings and the tab switcher's menu", async () => {
  const root = await openMenu();
  const words = textOf(root);
  for (const gone of ["Night Shade", "Page Zoom", "Desktop Site", "History", "Bookmarks", "Downloads"]) expect(words).not.toContain(gone);
  expect(root.root.findAll((node) => typeof node.type === "string" && ["menuToggle:Night Shade", "menuToggle:Desktop Site", "menuZoom"].includes(node.props.testID))).toHaveLength(0);
  expect(words).toContain("Site Settings");
  unmount(root);
});

onAndroid("on Android a tap anywhere on a toggle row flips it, as Compose's toggleable row", async () => {
  const flip = jest.spyOn(pageActions, "setBlockersOn").mockImplementation(() => undefined as never);
  const root = await openMenu();
  const row = root.root.findAll((node) => node.props.testID === `menuToggle:${BLOCKERS}` && typeof node.props.onPress === "function")[0]!;
  expect(textOf({ root: row } as never)).toContain(BLOCKERS);
  act(() => row.props.onPress());
  expect(flip).toHaveBeenCalledWith(false);
  unmount(root);
});

onIos("on iPhone only the switch itself takes a tap, as SwiftUI's Toggle, and it is the one VoiceOver activates", async () => {
  const flip = jest.spyOn(pageActions, "setBlockersOn").mockImplementation(() => undefined as never);
  const root = await openMenu();
  const knob = root.root.findAll((node) => node.props.testID === `menuToggle:${BLOCKERS}` && typeof node.props.onPress === "function")[0]!;
  expect(textOf({ root: knob } as never)).not.toContain(BLOCKERS);
  expect(root.root.findAll((node) => typeof node.props.onPress === "function" && textOf({ root: node } as never).includes(BLOCKERS))).toHaveLength(0);
  act(() => knob.props.onPress());
  expect(flip).toHaveBeenCalledWith(false);
  unmount(root);
});

test("at large text the menu takes its large layout with the title under the navigation capsule: from 1.3× on Android as Compose, at accessibility sizes on iPhone as SwiftUI", async () => {
  textSize(1.4);
  const root = await openMenu();
  const titleBelow = (menu: typeof root) => host(menu, "pageMenuCapsuleRow").findAll((node) => node.props.testID === "pageMenuTitle").length === 0 && host(menu, "pageMenuCapsule").findAll((node) => node.props.testID === "pageMenuTitle").length > 0;
  expect(titleBelow(root)).toBe(Platform.OS === "android");
  unmount(root);
  textSize(1.7);
  const larger = await openMenu();
  expect(titleBelow(larger)).toBe(true);
  unmount(larger);
});

test("Open in Default Browser stays enabled off web pages, as both apps keep it", async () => {
  page("about:blank");
  const root = await openMenu();
  const row = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button" && textOf({ root: node } as never) === "Open in Default Browser")[0];
  expect(row).toBeDefined();
  expect(row!.props.accessibilityState?.disabled).toBe(false);
  unmount(root);
});
