import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { barAddress, siteHost, withoutPort } from "../components/browsing/FloatingBar";
import { distinctTitle, pageTheme } from "../components/browsing/PageLoadingPlaceholder";
import { DesignProvider } from "../components/ui";
import { openPage, useBrowse } from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { setPreference } from "../state/settings/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import type { BrowserTab } from "../state/tabs/tabModels";
import { launchTabs } from "../state/tabs/tabsState";
import { renderSurface, someTabs, unmount, withTabs } from "../../test/render/harness";
import { privateMark } from "../components/ui/IncognitoSpecs";

const onIPhone = Platform.OS === "ios";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState({ navigation: {}, tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  setPreference("collapsesBottomBar", false);
});

type Root = ReturnType<typeof renderSurface>;

const node = (root: Root, testID: string) => root.root.findAll((found) => found.props.testID === testID && typeof found.type === "string")[0];
const style = (found: ReactTestInstance) => ({ ...StyleSheet.flatten(found.props.style), ...getAnimatedStyle(found) }) as Record<string, unknown>;
const text = (found: ReactTestInstance | undefined) => (found ? [found.props.children].flat().join("") : undefined);

const withTab = (patch: Partial<BrowserTab>) => {
  useTabs.setState({ ...launchTabs([{ ...someTabs(1)[0]!, ...patch }], 0), incognito: false, listing: 0 });
  return currentTabs().open[0]!;
};

const navigation = (patch: Partial<PageState>) => ({ url: "https://site0.example/", title: "Site 0", isLive: true, isLoading: true, progress: 0.3, failure: null, canGoBack: false, canGoForward: false, ...patch }) as unknown as PageState;

const crashed = { kind: "crashed", reason: null, title: "This Page Stopped Working", message: "Try again, or come back to it later." } as unknown as PageState["failure"];

test("a loading page with no saved picture shows main's placeholder centred on the page: a 44 point icon, the title in headline and the host in subheadline", () => {
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  const placeholder = node(root, "pageLoadingPlaceholder")!;
  expect(style(placeholder)).toMatchObject({ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 });
  expect(style(node(root, "pageLoadingContent")!)).toMatchObject({ alignItems: "center", gap: 12 });
  expect(style(node(root, "pageLoadingIcon")!)).toMatchObject({ width: 44, height: 44, boxShadow: "0px 2px 12px rgba(0,0,0,0.08)" });
  expect(text(node(root, "pageLoadingTitle"))).toBe("Site 0");
  expect(style(node(root, "pageLoadingTitle")!)).toMatchObject({ fontSize: 17, fontWeight: "600", textAlign: "center", color: "rgba(14,15,16,0.9)" });
  expect(node(root, "pageLoadingTitle")!.props.numberOfLines).toBe(3);
  expect(text(node(root, "pageLoadingHost"))).toBe("site0.example");
  expect(style(node(root, "pageLoadingHost")!)).toMatchObject({ fontSize: 15, color: "rgba(0,0,0,0.5)" });
  unmount(root);
});

test("the placeholder's contents wait main's delay, then fade in: 250 then 150 ms on both phones", () => {
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  const opacity = () => style(node(root, "pageLoadingContent")!).opacity;
  const [wait, fade] = [250, 150];
  expect(opacity()).toBe(0);
  act(() => jest.advanceTimersByTime(wait - 16));
  expect(opacity()).toBe(0);
  for (let elapsed = 0; elapsed < fade + 64; elapsed += 16) act(() => jest.advanceTimersByTime(16));
  expect(opacity()).toBe(1);
  unmount(root);
});

test("VoiceOver reads the placeholder as main's \"Loading <title>\" on iPhone; Android keeps Compose's silent cover", () => {
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  const placeholder = node(root, "pageLoadingPlaceholder")!;
  expect(placeholder.props.accessibilityLabel).toBe("Loading Site 0");
  expect(placeholder.props.accessible).toBe(onIPhone);
  expect(node(root, "pageCover")!.props.accessibilityElementsHidden).toBe(!onIPhone);
  unmount(root);
});

test("a tab with a saved picture keeps the picture as its cover, not the placeholder", () => {
  const tab = withTab({ snapshotFileName: "file:///snapshots/t0.jpg" });
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(node(root, "pageCover")).toBeDefined();
  expect(node(root, "pageLoadingPlaceholder")).toBeUndefined();
  expect(node(root, "pageCover")!.props.accessibilityElementsHidden).toBe(true);
  unmount(root);
});

test("a page's theme colour fills the placeholder with main's ink, and a title that only repeats the host is left out", () => {
  const tab = withTab({ themeColorHex: "#1A73E8", title: "www.Site0.example" });
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(style(node(root, "pageLoadingPlaceholder")!).backgroundColor).toBe("#1A73E8");
  expect(node(root, "pageLoadingTitle")).toBeUndefined();
  expect(style(node(root, "pageLoadingHost")!)).toMatchObject({ fontSize: 17, fontWeight: "600", color: "rgba(255,255,255,0.92)" });
  unmount(root);
});

test("main's PageTheme and distinctTitle rules", () => {
  expect(pageTheme("#FFFFFF")).toBeNull();
  expect(pageTheme("#F5F5F5")).toBeNull();
  expect(pageTheme("bad")).toBeNull();
  expect(pageTheme("#FFCC00")).toEqual({ color: "#FFCC00", ink: "rgba(0,0,0,0.85)", hostInk: `rgba(0,0,0,${0.85 * 0.65})` });
  expect(pageTheme("202124")).toEqual({ color: "#202124", ink: "rgba(255,255,255,0.92)", hostInk: `rgba(255,255,255,${0.92 * 0.65})` });
  expect(distinctTitle("", null)).toBe("New Tab");
  expect(distinctTitle("  ", "a.example")).toBeNull();
  expect(distinctTitle("https://a.example/x", "a.example")).toBeNull();
  expect(distinctTitle("Docs", null)).toBe("Docs");
  expect(distinctTitle(" Docs ", "a.example")).toBe("Docs");
});

test("on iPhone a failed page's Try Again is the shared action in main's filled large capsule: 50 points tall, 20 point sides, the system's secondary fill and no stroke; Android keeps an outlined one at the 44 point target", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, navigation({ isLoading: false, failure: crashed }));
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  const retry = style(node(root, "pageFailureRetry")!);
  if (onIPhone) {
    expect(retry).toMatchObject({ minHeight: 50, paddingHorizontal: 20, borderRadius: 25, borderCurve: "continuous", backgroundColor: "rgba(120,120,128,0.16)", borderWidth: 0 });
  } else {
    expect(retry).toMatchObject({ minHeight: 44, borderRadius: 22, borderWidth: 1 });
  }
  expect(node(root, "pageFailureRetry")!.props.accessibilityLabel).toBe("Try Again");
  expect(style(node(root, "pageFailureIcon")!)).toMatchObject({ width: 36, height: 36, marginBottom: 4 });
  const glyph = node(root, "pageFailureIcon")!.findAll((found) => typeof found.props.viewBox === "string")[0]!;
  expect(glyph.props.width).toBeCloseTo(onIPhone ? 43.2 : 36, 3);
  unmount(root);
});

test("a failed page fills with the neutral app surface, not the profile's colour", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, navigation({ isLoading: false, failure: crashed }));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <BrowsingScreen tabId={tab.id} />
    </DesignProvider>,
    { flushTimers: false },
  );
  const fill = style(node(root, "pageFailure")!).backgroundColor;
  expect(fill).toBe("#FFFFFF");
  unmount(root);
});

test("while a retry loads, the failure stays on screen and Try Again is busy and takes no second press; it clears once the load ends", () => {
  const tab = currentTabs().open[0]!;
  act(() => storeNavigation(tab.id, navigation({ isLoading: false, failure: crashed })));
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(node(root, "pageFailureRetry")!.props.accessibilityState).toMatchObject({ busy: false, disabled: false });
  act(() => storeNavigation(tab.id, navigation({ isLoading: true, failure: null })));
  expect(node(root, "pageFailure")).toBeDefined();
  expect(node(root, "pageFailureRetry")!.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  expect(node(root, "pageFailureRetryBusy")).toBeDefined();
  act(() => storeNavigation(tab.id, navigation({ isLoading: false, failure: null, progress: 1 })));
  expect(node(root, "pageFailure")).toBeUndefined();
  unmount(root);
});

test("the bar and the host pill show the host without its port, as main's BrowserURL.host does, and keep Not Secure for http", () => {
  const plain = (url: string, title = "") => ({ ...someTabs(1)[0]!, url, title });
  expect(barAddress(plain("http://localhost:8766/page"))).toMatchObject({ host: "localhost", insecure: true });
  expect(barAddress(plain("https://www.Example.com:8443/"))).toMatchObject({ host: "example.com", insecure: false });
  expect(barAddress(plain("https://example.com/a:80"))).toMatchObject({ host: "example.com" });
  expect(withoutPort("[::1]:8080", "http://[::1]:8080/")).toBe("[::1]");
  expect(withoutPort("example.com", "https://user:pw@example.com/")).toBe("example.com");
  expect(withoutPort("example.com:9", "https://user@example.com:9/")).toBe("example.com");
  expect(siteHost("about:blank")).toBeNull();
  expect(siteHost("http://localhost:9/")).toBe("localhost");
});

test("on iPhone's design an http page on a port shows the red open lock and the bare host in both the bar and the collapsed pill, and says Not Secure to a screen reader", () => {
  const tab = withTab({ url: "http://localhost:8766/", title: "Local" });
  setPreference("collapsesBottomBar", true);
  act(() => storeNavigation(tab.id, navigation({ url: tab.url, isLoading: false, progress: 1, scrollDirection: "up" } as Partial<PageState>)));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <BrowsingScreen tabId={tab.id} />
    </DesignProvider>,
  );
  expect(text(node(root, "floatingBarHost"))).toBe("localhost");
  expect(node(root, "floatingBarNotSecure")).toBeDefined();
  expect(root.root.findAll((found) => found.props.accessibilityLabel === "Address" && found.props.accessibilityValue?.text === "Not Secure, localhost")).not.toHaveLength(0);
  act(() => storeNavigation(tab.id, navigation({ url: tab.url, isLoading: false, progress: 1, scrollDirection: "down" } as Partial<PageState>)));
  for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
  expect(text(node(root, "hostPillHost"))).toBe("localhost");
  expect(node(root, "hostPillNotSecure")).toBeDefined();
  expect(root.root.findAll((found) => found.props.accessibilityLabel === "Show Toolbar" && found.props.accessibilityValue?.text === "Not Secure, localhost")).not.toHaveLength(0);
  unmount(root);
});

test("a tab opened directly on an http address shows the red open lock from its first frame, before the page reports anything: the state main's app gets wrong, which ours keeps right", () => {
  act(() => useTabs.setState({ ...launchTabs(someTabs(1), 0), incognito: false, listing: 0 }));
  act(() => openPage("http://neverssl.com/", "typed"));
  const tab = currentTabs().open.find((open) => open.id === currentTabs().selectedId)!;
  expect(tab.url).toBe("http://neverssl.com/");
  expect(usePages.getState().navigation[tab.id]).toBeUndefined();
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <BrowsingScreen tabId={tab.id} />
    </DesignProvider>,
  );
  expect(node(root, "floatingBarNotSecure")).toBeDefined();
  expect(text(node(root, "floatingBarHost"))).toBe("neverssl.com");
  unmount(root);
});

test("the lock sits in the site icon's own slot at the site icon's size, so the address starts at the same x on a secure and an insecure page, in the bar and in the pill", () => {
  const { floatingBarLayout } = require("../components/ui") as typeof import("../components/ui");
  const { hostPillLayout } = require("../components/browsing/hostPillTokens") as typeof import("../components/browsing/hostPillTokens");
  const box = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) as { width?: number; height?: number };
  const faviconSizes = (root: Root) => root.root.findAll((found) => typeof found.type !== "string" && "pageUrl" in found.props && typeof found.props.size === "number").map((found) => found.props.size as number);
  for (const [url, insecure] of [["https://secure.example/", false], ["http://plain.example/", true]] as const) {
    const tab = withTab({ url, title: "Page" });
    setPreference("collapsesBottomBar", true);
    act(() => storeNavigation(tab.id, navigation({ url, isLoading: false, progress: 1, scrollDirection: "up" } as Partial<PageState>)));
    const root = renderSurface(
      <DesignProvider design="redesigned">
        <BrowsingScreen tabId={tab.id} />
      </DesignProvider>,
    );
    if (insecure) expect(box(node(root, "floatingBarNotSecure"))).toMatchObject({ width: floatingBarLayout.siteIcon, height: floatingBarLayout.siteIcon });
    else expect(faviconSizes(root)).toContain(floatingBarLayout.siteIcon);
    act(() => storeNavigation(tab.id, navigation({ url, isLoading: false, progress: 1, scrollDirection: "down" } as Partial<PageState>)));
    for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
    if (insecure) expect(box(node(root, "hostPillNotSecure"))).toMatchObject({ width: hostPillLayout.siteIcon, height: hostPillLayout.siteIcon });
    else expect(faviconSizes(root)).toContain(hostPillLayout.siteIcon);
    unmount(root);
  }
});

test("the bar's icon slot for the four tabs: a normal secure page shows its favicon, a normal insecure one the red lock alone, an Incognito secure one its eyeglasses, and an Incognito insecure one the eyeglasses then the lock; a screen reader hears Incognito, Not Secure, then the host", () => {
  const { spokenAddress } = require("../components/browsing/FloatingBar") as typeof import("../components/browsing/FloatingBar");
  const glyphs = (root: Root) => root.root.findAll((found) => typeof found.type !== "string" && (found.props.name === privateMark || found.props.testID === "floatingBarNotSecure" || ("pageUrl" in found.props && typeof found.props.size === "number"))).map((found) => (found.props.name === privateMark ? "eyeglasses" : found.props.testID === "floatingBarNotSecure" ? "lock" : "favicon"));
  const cases = [
    { url: "https://secure.example/", isPrivate: false, shows: ["favicon"], spoken: "secure.example" },
    { url: "http://plain.example/", isPrivate: false, shows: ["lock"], spoken: "Not Secure, plain.example" },
    { url: "https://secure.example/", isPrivate: true, shows: ["eyeglasses"], spoken: "Incognito, secure.example" },
    { url: "http://plain.example/", isPrivate: true, shows: ["eyeglasses", "lock"], spoken: "Incognito, Not Secure, plain.example" },
  ];
  for (const { url, isPrivate, shows, spoken } of cases) {
    const tab = { ...withTab({ url, title: "Page" }), isPrivate };
    useTabs.setState((state) => ({ open: state.open.map((other) => (other.id === tab.id ? tab : other)) }));
    const root = renderSurface(
      <DesignProvider design="redesigned">
        <BrowsingScreen tabId={tab.id} />
      </DesignProvider>,
    );
    const bar = root.root.findAll((found) => found.props.testID === "floatingBarCentreGlyphs")[0]!;
    const inBar = glyphs({ root: bar } as unknown as Root);
    expect([...new Set(inBar)]).toEqual(shows);
    expect(spokenAddress(barAddress(tab))).toBe(spoken);
    expect(root.root.findAll((found) => found.props.accessibilityLabel === "Address" && found.props.accessibilityValue?.text === spoken)).not.toHaveLength(0);
    unmount(root);
  }
});
