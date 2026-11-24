import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { HostPill } from "../components/browsing/HostPill";
import { appDesign, DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { useBrowse } from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { setPreference } from "../state/settings/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false };

jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

beforeEach(() => {
  mockMotion.reduced = false;
  jest.useFakeTimers();
  withTabs(3);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  setPreference("collapsesBottomBar", true);
});

afterEach(() => {
  act(() => usePageUi.setState({ findOpen: false }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  setPreference("collapsesBottomBar", false);
});

const android = Platform.OS === "android";

type Root = ReturnType<typeof renderSurface>;

const scrolled = (scrollDirection: "up" | "down", url = "https://site0.example/") =>
  act(() => storeNavigation(currentTabs().open[0]!.id, { url, title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));

const page = (design: Design) => {
  scrolled("up");
  return renderSurface(
    <DesignProvider design={design}>
      <BrowsingScreen tabId={currentTabs().open[0]!.id} />
    </DesignProvider>,
  );
};

const settle = () => {
  for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
};

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0];

const moved = (node: ReactTestInstance) => {
  const style = { ...StyleSheet.flatten(node.props.style), ...getAnimatedStyle(node) } as { opacity?: number; transform?: Record<string, number>[] };
  const transform = Object.assign({}, ...(style.transform ?? [])) as { translateY?: number; scale?: number };
  return { opacity: style.opacity ?? 1, translateY: transform.translateY ?? 0, scale: transform.scale ?? 1 };
};

const expectPill = (root: Root, shown: boolean) => {
  if (!android) {
    const glass = root.root.findAll((node) => node.props.testID === "hostPill" && node.props.shown !== undefined && typeof node.type !== "string")[0]!;
    expect(host(root, "hostPillFold")!.props.pointerEvents).toBe(shown ? "box-none" : "none");
    expect(host(root, "hostPillFold")!.props.accessibilityElementsHidden).toBe(!shown);
    expect(moved(host(root, "hostPillFold")!).opacity).toBe(1);
    expect(glass.props.shown).toBe(shown);
    expect(moved(host(root, "hostPillContent")!).opacity).toBeCloseTo(shown ? 1 : 0, 3);
    return;
  }
  expect(host(root, "hostPillFold")!.props.pointerEvents).toBe(shown ? "box-none" : "none");
  expect(host(root, "hostPillFold")!.props.accessibilityElementsHidden).toBe(!shown);
  expect(moved(host(root, "hostPillFold")!).opacity).toBe(shown ? 1 : 0);
};

const barGlass = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && node.props.shown !== undefined && typeof node.type !== "string")[0]!.props.shown !== false;

const showToolbar = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Show Toolbar" && typeof node.props.onPress === "function")[0];

test("on iPhone's design, scrolling down with Collapse Bottom Bar on shrinks the bar into a 30 point pill with the page's host, centred on the bar's bottom", () => {
  const root = page("redesigned");
  expectPill(root, false);
  scrolled("down");
  settle();
  expect(host(root, "hostPillHost")!.props.children).toBe("site0.example");
  expect(StyleSheet.flatten(host(root, "hostPill")!.props.style)).toMatchObject({ height: 30, maxWidth: 240, borderRadius: 15 });
  expect(StyleSheet.flatten(host(root, "hostPillHost")!.props.style)).toMatchObject({ fontSize: 13.5, fontWeight: "500" });
  expect(StyleSheet.flatten(host(root, "hostPillFold")!.props.style)).toMatchObject({ bottom: 0, height: 30, alignItems: "center" });
  expect(moved(host(root, "hostPillFold")!)).toEqual({ opacity: 1, translateY: 0, scale: 1 });
  const bar = moved(host(root, "floatingBarFold")!);
  expect(bar.opacity).toBe(android ? 0 : 1);
  expect(moved(host(root, "floatingBarFoldGlyphs")!).opacity).toBe(android ? 1 : 0);
  for (const id of ["floatingBarAddress", "floatingBarTabs", "floatingBarPlus"]) expect(barGlass(root, id)).toBe(android);
  expect(bar.scale).toBeCloseTo(0.62, 3);
  expect(bar.translateY).toBeCloseTo(24 * 0.38, 3);
  expect(host(root, "floatingBarFold")!.props.pointerEvents).toBe("none");
  expect(host(root, "floatingBarFold")!.props.accessibilityElementsHidden).toBe(true);
  expect(moved(host(root, "pageBar")!)).toEqual({ opacity: 1, translateY: 0, scale: 1 });
  unmount(root);
});

test("both phones grow the pill out of the bar on iPhone's spring; Android also fades the pill's surface, which has no glass to fade", () => {
  const root = page("redesigned");
  scrolled("down");
  act(() => jest.advanceTimersByTime(16));
  const pill = moved(host(root, "hostPillFold")!);
  expect(pill.scale).toBeGreaterThan(1);
  expect(pill.scale).toBeLessThanOrEqual(1 / 0.62 + 1e-6);
  if (android) expect(pill.opacity).toBeLessThan(1);
  else expect(pill.opacity).toBe(1);
  expect(moved(host(root, "hostPillContent")!).opacity).toBeLessThan(1);
  settle();
  expect(moved(host(root, "hostPillFold")!).scale).toBeCloseTo(1, 3);
  unmount(root);
});

test("the pill reads Show Toolbar with the host as its value, and a tap on it brings the full bar back and lets the pill go", () => {
  const root = page("redesigned");
  scrolled("down");
  settle();
  const button = showToolbar(root)!;
  expect(button.props.accessibilityRole).toBe("button");
  expect(button.props.accessibilityValue).toEqual({ text: "site0.example" });
  act(() => button.props.onPress());
  settle();
  expect(moved(host(root, "floatingBarFold")!)).toEqual({ opacity: 1, translateY: 0, scale: 1 });
  expect(host(root, "floatingBarFold")!.props.pointerEvents).toBe("box-none");
  expectPill(root, false);
  expect(moved(host(root, "floatingBarFoldGlyphs")!).opacity).toBe(1);
  for (const id of ["floatingBarAddress", "floatingBarTabs", "floatingBarPlus"]) expect(barGlass(root, id)).toBe(true);
  scrolled("down");
  settle();
  expectPill(root, false);
  unmount(root);
});

test("the collapsed pill carries the page's busy state while it loads, as the address it stands in for does, and the progress line stays hidden from screen readers", () => {
  const root = page("redesigned");
  scrolled("down");
  settle();
  const tab = currentTabs().open[0]!;
  const loading = (isLoading: boolean) => act(() => storeNavigation(tab.id, { url: "https://site0.example/", title: "Site", isLive: true, isLoading, progress: isLoading ? 0.4 : 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection: "down" } as unknown as PageState));
  expect(showToolbar(root)!.props.accessibilityState).toEqual({ busy: false });
  loading(true);
  expect(showToolbar(root)!.props.accessibilityState).toEqual({ busy: true });
  expect(host(root, "loadingLine")?.props.accessibilityElementsHidden ?? true).toBe(true);
  loading(false);
  expect(showToolbar(root)!.props.accessibilityState).toEqual({ busy: false });
  unmount(root);
});

test("scrolling back up, opening another page or turning the preference off expands the bar again", () => {
  const root = page("redesigned");
  for (const expand of [() => scrolled("up"), () => scrolled("down", "https://other.example/"), () => act(() => setPreference("collapsesBottomBar", false))]) {
    act(() => setPreference("collapsesBottomBar", true));
    scrolled("up");
    scrolled("down");
    settle();
    expectPill(root, true);
    expand();
    settle();
    expectPill(root, false);
    expect(moved(host(root, "floatingBarFold")!).opacity).toBe(1);
  }
  unmount(root);
});

test("with Collapse Bottom Bar off, scrolling down leaves the full bar in place", () => {
  setPreference("collapsesBottomBar", false);
  const root = page("redesigned");
  scrolled("down");
  settle();
  expectPill(root, false);
  expect(moved(host(root, "floatingBarFold")!).opacity).toBe(1);
  unmount(root);
});

test("Find in Page hides the whole bar, pill included, as main's hidden presentation does", () => {
  const root = page("redesigned");
  scrolled("down");
  settle();
  act(() => usePageUi.setState({ findOpen: true }));
  settle();
  expect(moved(host(root, "pageBar")!)).toMatchObject({ opacity: 0, translateY: 30 });
  expect(host(root, "pageBar")!.props.pointerEvents).toBe("none");
  unmount(root);
});

test("Android's design keeps sliding its bar away with no pill", () => {
  const root = page("original");
  scrolled("down");
  settle();
  expect(root.root.findAll((node) => node.type === HostPill)).toHaveLength(0);
  expect(moved(host(root, "pageBar")!)).toMatchObject({ opacity: 0, translateY: 30 });
  scrolled("up");
  settle();
  expect(moved(host(root, "pageBar")!)).toMatchObject({ opacity: 1, translateY: 0 });
  unmount(root);
});

test("each phone runs its own design's collapse: the pill on iPhone, the slide on Android", () => {
  const root = renderSurface(<BrowsingScreen tabId={currentTabs().open[0]!.id} />);
  scrolled("down");
  settle();
  expect(root.root.findAll((node) => node.type === HostPill)).toHaveLength(appDesign === "redesigned" ? 1 : 0);
  expect(moved(host(root, "pageBar")!).opacity).toBe(appDesign === "redesigned" ? 1 : 0);
  unmount(root);
});

test("Android keeps the same pill mounted through rapid direction reversals and taps, with only the current control accessible", () => {
  if (!android) return;
  const root = page("redesigned");
  const pill = host(root, "hostPill")!;
  for (let turn = 0; turn < 5; turn++) {
    scrolled("down");
    act(() => jest.advanceTimersByTime(48));
    scrolled("up");
    act(() => jest.advanceTimersByTime(32));
  }
  settle();
  expect(host(root, "hostPill")).toBe(pill);
  expectPill(root, false);
  expect(moved(host(root, "floatingBarFold")!)).toEqual({ opacity: 1, translateY: 0, scale: 1 });
  scrolled("down");
  settle();
  expectPill(root, true);
  act(() => showToolbar(root)!.props.onPress());
  settle();
  expectPill(root, false);
  unmount(root);
});

test("Android Remove animations snaps the collapse and Find state without the bar spring", () => {
  if (!android) return;
  mockMotion.reduced = true;
  const root = page("redesigned");
  scrolled("down");
  act(() => jest.advanceTimersByTime(16));
  expectPill(root, true);
  act(() => usePageUi.setState({ findOpen: true }));
  expect(moved(host(root, "pageBar")!)).toMatchObject({ opacity: 0, translateY: 30 });
  unmount(root);
  mockMotion.reduced = false;
});

test("the 30 point pill reaches the 44 point touch target without growing: a tap just above or below it still brings the bar back, and its press dims the host as other bar controls do", () => {
  const root = page("redesigned");
  scrolled("down");
  settle();
  const reach = host(root, "hostPillReach")!;
  const box = StyleSheet.flatten(reach.props.style) as { top: number; bottom: number; position: string };
  expect(box.position).toBe("absolute");
  expect(30 - box.top - box.bottom).toBeGreaterThanOrEqual(44);
  expect(StyleSheet.flatten(host(root, "hostPill")!.props.style)).toMatchObject({ height: 30 });
  expect(reach.props.accessible).toBe(false);
  const reachPress = root.root.findAll((node) => node.props.testID === "hostPillReach" && typeof node.props.onPressIn === "function")[0]!;
  act(() => reachPress.props.onPressIn());
  expect(StyleSheet.flatten(host(root, "hostPillButton")!.props.style).opacity).toBe(0.35);
  act(() => reachPress.props.onPressOut());
  expect(StyleSheet.flatten(host(root, "hostPillButton")!.props.style).opacity).toBeUndefined();
  act(() => reachPress.props.onPress());
  settle();
  expect(host(root, "floatingBarFold")!.props.pointerEvents).toBe("box-none");
  unmount(root);
});

test("on iPhone the bar's glass and the pill's glass cross over the moment the bar turns, however fast scrolls reverse, with no callback from an earlier fold left to flip them later", () => {
  if (android) return;
  const root = page("redesigned");
  const pillGlass = () => root.root.findAll((node) => node.props.testID === "hostPill" && node.props.shown !== undefined && typeof node.type !== "string")[0]!.props;
  const expectHandoff = (collapsed: boolean) => {
    expect(pillGlass().shown).toBe(collapsed);
    expect(pillGlass().shownMs).toBe(150);
    for (const id of ["floatingBarAddress", "floatingBarTabs", "floatingBarPlus"]) expect(barGlass(root, id)).toBe(!collapsed);
  };
  expectHandoff(false);
  scrolled("down");
  expectHandoff(true);
  for (let frame = 0; frame < 3; frame++) act(() => jest.advanceTimersByTime(16));
  scrolled("up");
  expectHandoff(false);
  for (let frame = 0; frame < 3; frame++) act(() => jest.advanceTimersByTime(16));
  scrolled("down");
  expectHandoff(true);
  settle();
  expectHandoff(true);
  scrolled("up");
  expectHandoff(false);
  settle();
  expectHandoff(false);
  unmount(root);
});
