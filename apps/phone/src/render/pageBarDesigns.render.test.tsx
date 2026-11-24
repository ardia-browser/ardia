import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { BottomBar } from "../components/browsing/BottomBar";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { barAddress, FloatingBar } from "../components/browsing/FloatingBar";
import { appDesign, barGlyphLayout, chromeInk, DesignProvider, Symbol } from "../components/ui";
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
import { privateMark } from "../components/ui/IncognitoSpecs";

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

const page = (design: Design, tab = currentTabs().open[0]!) => {
  useTabs.setState((state) => ({ open: state.open.map((other) => (other.id === tab.id ? tab : other)) }));
  return renderSurface(
    <DesignProvider design={design}>
      <BrowsingScreen tabId={tab.id} />
    </DesignProvider>,
  );
};

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

test("the redesigned bar is a glass pill address between two glass circles, 48 points tall, 8 apart and 24 in from the sides, their bottom 21.5 points above the screen's edge on iPhone and 8 above Android's 3-button bar", () => {
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

test("in the redesign the page runs full screen under the bar, told the top safe area and, on iPhone, the bar's 75 points as obscured insets (none on Android, whose bar collapses by default), the status bar's strip is laid over the page in the page's top colour, nothing is painted between the page and the glass bar, and only the bar's pieces take touches", () => {
  jest.spyOn(pageViewModule, "pageObscuresInsets").mockImplementation(() => true);
  const covered = Platform.OS === "android" ? 75 + 34 + 8 - 21.5 : 75;
  const root = page("redesigned");
  const view = root.root.findAll((node) => node.props.pageId !== undefined && node.props.obscuredInsets !== undefined)[0]!;
  expect(view.props.obscuredInsets).toEqual({ top: 47, bottom: Platform.OS === "android" ? 0 : covered });
  expect(view.props.toneInsets).toEqual({ top: 0, bottom: covered });
  expect(StyleSheet.flatten(host(root, "pageArea")!.props.style).marginBottom).toBe(0);
  const strip = StyleSheet.flatten(host(root, "pageStatusStrip")!.props.style);
  expect(strip).toMatchObject({ position: "absolute", top: 0, left: 0, right: 0, height: 47 });
  expect(host(root, "pageStatusStrip")!.props.pointerEvents).toBe("none");
  expect(host(root, "pageBarBase")).toBeUndefined();
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

test("on Android the page runs under a bar that collapses, so nothing resizes it while scrolling, and stops above one that doesn't; iPhone keeps SwiftUI's 75", () => {
  jest.spyOn(pageViewModule, "pageObscuresInsets").mockImplementation(() => true);
  const android = Platform.OS === "android";
  const tab = currentTabs().open[0]!;
  const pageView = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.pageId !== undefined && node.props.obscuredInsets !== undefined)[0]!;
  const bottom = (root: ReturnType<typeof renderSurface>) => pageView(root).props.obscuredInsets.bottom as number;
  const scrolled = (scrollDirection: "up" | "down") => act(() => storeNavigation(tab.id, { url: "https://site0.example/", title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));
  setPreference("collapsesBottomBar", true);
  scrolled("up");
  const lift = android ? 34 + 8 - 21.5 : 0;
  const root = page("redesigned", tab);
  expect(pageView(root).props.bottomInsetTransitionMs).toBeUndefined();
  expect(bottom(root)).toBe(android ? 0 : 75);
  scrolled("down");
  expect(bottom(root)).toBe(android ? 0 : 75);
  scrolled("up");
  act(() => storeFullscreen(tab.id, true));
  expect(bottom(root)).toBe(android ? 0 : 75);
  act(() => storeFullscreen(tab.id, false));
  act(() => usePageUi.setState({ findOpen: true }));
  expect(bottom(root)).toBe(android ? 0 : 75);
  act(() => usePageUi.setState({ findOpen: false }));
  act(() => useSearch.setState({ open: true }));
  expect(bottom(root)).toBe(android ? 0 : 75);
  act(() => useSearch.setState({ open: false }));
  act(() => setPreference("collapsesBottomBar", false));
  expect(bottom(root)).toBe(75 + lift);
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
  expect(symbols.find((node) => node.props.name === "plus")!.props.size).toBeCloseTo(barGlyphLayout.plus.side);
  expect(symbols.find((node) => node.props.name === privateMark)!.props).toMatchObject({ size: 28, color: "rgba(0,0,0,0.5)" });
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

test("the browsing + is spoken as New Tab, or New Incognito Tab in Incognito, and draws the bars' shared + glyph; the classic bar's + says the same", () => {
  const { BarPlusGlyph } = require("../components/ui") as typeof import("../components/ui");
  const spoken = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => typeof node.props.onPress === "function" && (node.props.accessibilityLabel === "New Tab" || node.props.accessibilityLabel === "New Incognito Tab")).map((node) => node.props.accessibilityLabel as string);
  const plain = page("redesigned");
  expect(new Set(spoken(plain))).toEqual(new Set(["New Tab"]));
  expect(host(plain, "floatingBarPlus")!.findAll((node) => node.type === BarPlusGlyph).length).toBeGreaterThan(0);
  for (const plus of host(plain, "floatingBarPlus")!.findAll((node) => node.type === Symbol && node.props.name === "plus")) expect(plus.props.size).toBe(barGlyphLayout.plus.side);
  unmount(plain);
  const privateTab = { ...currentTabs().open[0]!, isPrivate: true };
  const incognito = page("redesigned", privateTab);
  expect(new Set(spoken(incognito))).toEqual(new Set(["New Incognito Tab"]));
  unmount(incognito);
  const classic = renderSurface(<BottomBar order={currentTabs().open} roles={require("../components/ui").rolesFor(false)} showsPlus incognito onTabs={() => undefined} onTabsMenu={() => undefined} onStep={() => undefined} onPlus={() => undefined} onMore={() => undefined} />);
  expect(spoken(classic)).toContain("New Incognito Tab");
  expect(classic.root.findAll((node) => node.type === BarPlusGlyph)).toHaveLength(1);
  unmount(classic);
});

test("the address answers a press with the shared dim and the bar's tap haptic, as the page menu button beside it does", () => {
  const haptics = require("../state/app/haptics") as typeof import("../state/app/haptics");
  const tapped = jest.spyOn(haptics.haptics, "barPress").mockImplementation(() => undefined as never);
  const root = page("redesigned");
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPressIn === "function")[0]!;
  act(() => address.props.onPressIn());
  expect(tapped).toHaveBeenCalled();
  const style = address.props.style as (state: { pressed: boolean }) => unknown;
  expect(StyleSheet.flatten(style({ pressed: true }) as never)).toMatchObject({ opacity: 0.35 });
  expect(StyleSheet.flatten(style({ pressed: false }) as never).opacity).toBeUndefined();
  unmount(root);
});

test("the page's one busy cue for screen readers is the address: busy while the page loads, not after, and the progress line stays hidden from them", () => {
  const tab = currentTabs().open[0]!;
  const navigation = (isLoading: boolean, progress: number) => act(() => storeNavigation(tab.id, { url: "https://site0.example/", title: "Site", isLive: true, isLoading, progress, failure: null, canGoBack: false, canGoForward: false } as unknown as PageState));
  navigation(true, 0.4);
  const root = page("redesigned", tab);
  const address = () => root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  expect(address().props.accessibilityState).toEqual({ busy: true });
  expect(address().props.accessibilityValue).toEqual({ text: expect.not.stringContaining("%") });
  navigation(true, 0.8);
  expect(address().props.accessibilityState).toEqual({ busy: true });
  navigation(false, 1);
  expect(address().props.accessibilityState).toEqual({ busy: false });
  expect(host(root, "loadingLine")!.props.accessibilityElementsHidden).toBe(true);
  unmount(root);
});

test("the browsing address is the shared address face and the page's progress line is the shared one, set below the status bar", () => {
  const { AddressFace } = require("../components/browsing/AddressFace") as typeof import("../components/browsing/AddressFace");
  const { PageProgressLine } = require("../components/browsing/PageProgressLine") as typeof import("../components/browsing/PageProgressLine");
  const root = page("redesigned");
  const faces = root.root.findAll((node) => node.type === AddressFace);
  expect(faces).toHaveLength(1);
  expect(faces[0]!.props.testIDPrefix).toBe("floatingBar");
  const progress = root.root.findAll((node) => node.type === PageProgressLine);
  expect(progress).toHaveLength(1);
  expect(StyleSheet.flatten(host(root, "pageProgressLine")!.props.style)).toMatchObject({ position: "absolute", left: 0, right: 0, top: progress[0]!.props.top });
  unmount(root);
});
