import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { BottomBar } from "../components/browsing/BottomBar";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { barAddress, FloatingBar } from "../components/browsing/FloatingBar";
import { appDesign, chromeInk, DesignProvider, Symbol } from "../components/ui";
import { storeFullscreen, storeNavigation, storeTone, usePages, type PageState } from "../state/pages/store";
import { usePageUi } from "../state/page/store";
import { setPreference } from "../state/settings/store";
import { useSearch } from "../state/search/store";
import { DESIGNS, designFor, type Design } from "../lib/design";
import * as pageActions from "../state/page/actions";
import { useBrowse } from "../state/browse/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { renderSurface, someTabs, unmount, withTabs } from "../../test/render/harness";
import type { BrowserTab } from "../state/tabs/tabModels";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 47, bottom: 34, left: 0, right: 0 }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const page = (design: Design, tab = currentTabs().open[0]!) =>
  renderSurface(
    <DesignProvider design={design}>
      <BrowsingScreen tab={tab} />
    </DesignProvider>,
  );

const host = (root: ReturnType<typeof renderSurface>, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0];

test("the design is chosen in one place: the redesign on both phones, as the owner decided on 2026-11-15, and the app runs the one its phone gets", () => {
  expect(designFor("ios")).toBe("redesigned");
  expect(designFor("android")).toBe("redesigned");
  expect(appDesign).toBe(designFor(Platform.OS));
});

test.each(DESIGNS)("the %s design draws its own page bar and only that one", (design) => {
  const root = page(design);
  expect(root.root.findAll((node) => node.type === FloatingBar)).toHaveLength(design === "redesigned" ? 1 : 0);
  expect(root.root.findAll((node) => node.type === BottomBar)).toHaveLength(design === "original" ? 1 : 0);
  unmount(root);
});

test("the redesigned bar is three glass pieces, 48 points tall, 8 apart and 24 in from the sides, their bottom 21.5 points above the screen's edge on iPhone and 8 above Android's 3-button bar", () => {
  const root = page("redesigned");
  const row = StyleSheet.flatten(host(root, "floatingBar")!.props.style);
  expect(row).toMatchObject({ gap: 8, paddingHorizontal: 24, height: 48 });
  let place = host(root, "floatingBar")!.parent;
  while (place && (typeof place.type !== "string" || StyleSheet.flatten(place.props.style)?.bottom === undefined)) place = place.parent;
  expect(StyleSheet.flatten(place!.props.style).bottom).toBe(Platform.OS === "android" ? 34 + 8 : 21.5);
  for (const piece of ["floatingBarTabs", "floatingBarPlus"]) expect(StyleSheet.flatten(host(root, piece)!.props.style)).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
  expect(StyleSheet.flatten(host(root, "floatingBarAddress")!.props.style)).toMatchObject({ flex: 1, height: 48, borderRadius: 24 });
  unmount(root);
});

test("the redesigned bar's tabs button and its recent-tabs menu hold only the tabs of the page's own mode, so a normal page never shows an Incognito page's picture; the original bar keeps them all", () => {
  act(() => useTabs.setState((state) => ({ ...state, privates: someTabs(2, true) })));
  const modes = (root: ReturnType<typeof renderSurface>, bar: typeof FloatingBar | typeof BottomBar) => (root.root.findAll((node) => node.type === bar)[0]!.props.order as BrowserTab[]).map((tab) => tab.isPrivate);
  const normal = page("redesigned");
  expect(modes(normal, FloatingBar)).toEqual([false, false, false]);
  unmount(normal);
  const incognito = page("redesigned", currentTabs().privates[0]!);
  expect(modes(incognito, FloatingBar)).toEqual([true, true]);
  unmount(incognito);
  const original = page("original");
  expect(modes(original, BottomBar)).toHaveLength(5);
  unmount(original);
});

test("the address capsule shows the page's host, and a tap on it searches with the page's address while the dots open the page menu", () => {
  const edit = jest.spyOn(pageActions, "editPageQuery").mockImplementation(() => undefined);
  const menu = jest.spyOn(pageActions, "openPageMenu").mockImplementation(async () => undefined);
  const root = page("redesigned");
  expect(host(root, "floatingBarHost")!.props.children).toBe("site0.example");
  act(() => {
    root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!.props.onPress();
  });
  expect(edit).toHaveBeenCalledTimes(1);
  act(() => {
    root.root.findAll((node) => node.props.accessibilityLabel === "Page Menu" && typeof node.props.onPress === "function")[0]!.props.onPress();
  });
  expect(menu).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("a page loaded over plain http shows a red open lock in place of its icon, the owner's choice over SwiftUI's words, and still says Not Secure to a screen reader", () => {
  const tab = { ...currentTabs().open[0]!, url: "http://plain.example/" };
  useTabs.setState((state) => ({ open: state.open.map((t) => (t.id === tab.id ? tab : t)) }));
  expect(barAddress(tab)).toMatchObject({ host: "plain.example", insecure: true });
  const root = page("redesigned", tab);
  expect(host(root, "floatingBarNotSecure")).toBeDefined();
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Address" && node.props.accessibilityValue?.text === "Not Secure, plain.example")).not.toHaveLength(0);
  unmount(root);
});

const pageViewModule = require("@ardia/phone-native/src/PageView") as typeof import("@ardia/phone-native/src/PageView");

test("in the redesign the page runs full screen under the bar, told the top safe area and the bar's 75 points (more where Android lifts it over a 3-button bar) as obscured insets, and only the bar's pieces take touches", () => {
  jest.spyOn(pageViewModule, "pageObscuresInsets").mockImplementation(() => true);
  const covered = Platform.OS === "android" ? 75 + 34 + 8 - 21.5 : 75;
  const root = page("redesigned");
  const view = root.root.findAll((node) => node.props.pageId !== undefined && node.props.obscuredInsets !== undefined)[0]!;
  expect(view.props.obscuredInsets).toEqual({ top: 47, bottom: covered });
  expect(view.props.toneInsets).toEqual({ top: 0, bottom: covered });
  expect(StyleSheet.flatten(host(root, "pageArea")!.props.style).marginBottom).toBe(0);
  expect(host(root, "pageStatusStrip")).toBeUndefined();
  let bar = host(root, "floatingBar")!.parent;
  while (bar && bar.props.pointerEvents === undefined) bar = bar.parent;
  expect(bar!.props.pointerEvents).toBe("box-none");
  unmount(root);
});

test("the bands under the bars take the colours the bars use: the page's sampled tones, and the profile's surface before a page has one", () => {
  jest.spyOn(pageViewModule, "pageObscuresInsets").mockImplementation(() => true);
  const tab = currentTabs().open[0]!;
  const fresh = page("redesigned", tab);
  const before = fresh.root.findAll((node) => node.props.pageId !== undefined && node.props.obscuredColors !== undefined)[0]!;
  expect(before.props.obscuredColors).toEqual({ top: before.props.surfaceColor, bottom: before.props.surfaceColor });
  unmount(fresh);
  act(() => storeTone(tab.id, { top: "#F2F4F6", bottom: "#101418" }));
  const toned = page("redesigned", tab);
  const view = toned.root.findAll((node) => node.props.pageId !== undefined && node.props.obscuredColors !== undefined)[0]!;
  expect(view.props.obscuredColors).toEqual({ top: "#F2F4F6", bottom: "#101418" });
  unmount(toned);
});

test("on Android the page's obscured bottom is the bar's current height: the pill's when the bar collapses, and nothing under full-screen video, Find or the search tray; iPhone keeps SwiftUI's 75", () => {
  jest.spyOn(pageViewModule, "pageObscuresInsets").mockImplementation(() => true);
  const follows = Platform.OS === "android";
  const tab = currentTabs().open[0]!;
  const bottom = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.pageId !== undefined && node.props.obscuredInsets !== undefined)[0]!.props.obscuredInsets.bottom as number;
  const scrolled = (scrollDirection: "up" | "down") => act(() => storeNavigation(tab.id, { url: "https://site0.example/", title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));
  setPreference("collapsesBottomBar", true);
  scrolled("up");
  const lift = follows ? 34 + 8 - 21.5 : 0;
  const root = page("redesigned", tab);
  expect(bottom(root)).toBe(75 + lift);
  scrolled("down");
  expect(bottom(root)).toBe(follows ? 51.5 + lift : 75);
  scrolled("up");
  act(() => storeFullscreen(tab.id, true));
  expect(bottom(root)).toBe(follows ? 0 : 75);
  act(() => storeFullscreen(tab.id, false));
  act(() => usePageUi.setState({ findOpen: true }));
  expect(bottom(root)).toBe(follows ? 0 : 75);
  act(() => usePageUi.setState({ findOpen: false }));
  act(() => useSearch.setState({ open: true }));
  expect(bottom(root)).toBe(follows ? 0 : 75);
  act(() => useSearch.setState({ open: false }));
  expect(bottom(root)).toBe(75 + lift);
  setPreference("collapsesBottomBar", false);
  unmount(root);
});

test("where the page view can't take obscured insets, and in the original design, the page stops above the bar as before", () => {
  jest.spyOn(pageViewModule, "pageObscuresInsets").mockImplementation(() => false);
  for (const design of DESIGNS) {
    const root = page(design);
    expect(root.root.findAll((node) => node.props.pageId !== undefined && node.props.obscuredInsets !== undefined)).toHaveLength(0);
    expect(host(root, "pageStatusStrip")).toBeDefined();
    expect(StyleSheet.flatten(host(root, "pageArea")!.props.style).marginBottom).toBeGreaterThan(0);
    unmount(root);
  }
});

test("the bar's glass and glyphs follow the page's sampled bottom colour, not the app's scheme or a private tab, and its glyphs are SF's sizes", () => {
  const tab = currentTabs().open[0]!;
  act(() => storeTone(tab.id, { top: "#FFFFFF", bottom: "#FFFFFF" }));
  const light = page("redesigned", { ...tab, isPrivate: true });
  expect(StyleSheet.flatten(host(light, "floatingBarTabs")!.props.style).backgroundColor).toBe("#FFFFFF");
  const symbols = light.root.findAll((node) => node.type === Symbol);
  expect(symbols.find((node) => node.props.name === "ellipsis")!.props.size).toBeCloseTo(23.3);
  expect(symbols.find((node) => node.props.name === "plus")!.props.size).toBeCloseTo(23.6);
  expect(symbols.find((node) => node.props.name === "eyeglassesThin")!.props).toMatchObject({ size: 28, color: "rgba(0,0,0,0.5)" });
  unmount(light);
  act(() => storeTone(tab.id, { top: "#101418", bottom: "#101418" }));
  const dark = page("redesigned", tab);
  expect(StyleSheet.flatten(host(dark, "floatingBarTabs")!.props.style).backgroundColor).toBe(chromeInk.dark.surface);
  unmount(dark);
});

test("before a page has reported a colour, the redesigned bar takes the app's own light or dark, as SwiftUI's barScheme does", () => {
  const tab = { ...currentTabs().open[0]!, themeColorHex: null };
  for (const scheme of ["light", "dark"] as const) {
    const spy = jest.spyOn(require("react-native"), "useColorScheme").mockReturnValue(scheme);
    const root = page("redesigned", tab);
    expect(StyleSheet.flatten(host(root, "floatingBarTabs")!.props.style).backgroundColor).toBe(scheme === "dark" ? chromeInk.dark.surface : chromeInk.light.surface);
    unmount(root);
    spy.mockRestore();
  }
});

test("the page view is given the profile's surface for what shows behind a swipe to navigate, as Compose's look.surface", () => {
  const root = page("original");
  const view = root.root.findAll((node) => node.props.pageId !== undefined && node.props.surfaceColor !== undefined)[0]!;
  const screen = root.root.findAll((node) => (node.type as { name?: string })?.name === "BrowsingScreen")[0]!;
  const surface = StyleSheet.flatten(screen.findAll((node) => typeof node.type === "string")[0]!.props.style).backgroundColor;
  expect(view.props.surfaceColor).toBe(surface);
  unmount(root);
});
