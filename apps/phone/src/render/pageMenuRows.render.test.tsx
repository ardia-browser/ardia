import { useDefaultBrowser } from "../state/settings/defaultBrowser";
import { Dimensions, Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import "../platform/copy";
import { PageMenu } from "../components/browsing/PageMenu";
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

test("each toggle row is one switch for screen readers, named and with its state, and its own switch is hidden from them", async () => {
  const root = await openMenu();
  const row = host(root, "menuToggle:Night Shade");
  expect(row.props.accessibilityRole).toBe("switch");
  expect(row.props.accessibilityLabel).toBe("Night Shade");
  expect(row.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  const inner = row.findAll((node) => typeof node.props.onChange === "function" && node.props.label === "Night Shade")[0]!;
  expect(hiddenFromReaders(inner)).toBe(true);
  unmount(root);
});

onAndroid("on Android a tap anywhere on a toggle row flips it, as Compose's toggleable row", async () => {
  const flip = jest.spyOn(pageActions, "setNightShadeOn").mockImplementation(() => undefined as never);
  const root = await openMenu();
  act(() => root.root.findAll((node) => node.props.testID === "menuToggle:Night Shade" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(flip).toHaveBeenCalledWith(true);
  unmount(root);
});

onIos("on iPhone the row itself takes no tap, as SwiftUI's Toggle, but VoiceOver's double tap flips it", async () => {
  const flip = jest.spyOn(pageActions, "setNightShadeOn").mockImplementation(() => undefined as never);
  const root = await openMenu();
  const row = host(root, "menuToggle:Night Shade");
  expect(row.props.onPress).toBeUndefined();
  act(() => row.props.onAccessibilityTap());
  expect(flip).toHaveBeenCalledWith(true);
  unmount(root);
});

test("at large text the menu takes its large layout, the title under the navigation capsule and the zoom controls stacked under their label: from 1.3× on Android as Compose, at accessibility sizes on iPhone as SwiftUI", async () => {
  textSize(1.4);
  const root = await openMenu();
  const zoomStacked = (menu: typeof root) => StyleSheet.flatten(host(menu, "menuZoom").props.style).flexDirection !== "row";
  const titleBelow = (menu: typeof root) => host(menu, "pageMenuCapsuleRow").findAll((node) => node.props.testID === "pageMenuTitle").length === 0 && host(menu, "pageMenuCapsule").findAll((node) => node.props.testID === "pageMenuTitle").length > 0;
  expect(zoomStacked(root)).toBe(Platform.OS === "android");
  expect(titleBelow(root)).toBe(Platform.OS === "android");
  unmount(root);
  textSize(1.7);
  const larger = await openMenu();
  expect(zoomStacked(larger)).toBe(true);
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
