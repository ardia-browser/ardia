import { StyleSheet } from "react-native";
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

beforeEach(() => {
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

type Root = ReturnType<typeof renderSurface>;

const scrolled = (scrollDirection: "up" | "down", url = "https://site0.example/") =>
  act(() => storeNavigation(currentTabs().open[0]!.id, { url, title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));

const page = (design: Design) => {
  scrolled("up");
  return renderSurface(
    <DesignProvider design={design}>
      <BrowsingScreen tab={currentTabs().open[0]!} />
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

const showToolbar = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Show Toolbar" && typeof node.props.onPress === "function")[0];

test("on iPhone's design, scrolling down with Collapse Bottom Bar on shrinks the bar into a 30 point pill with the page's host, centred on the bar's bottom", () => {
  const root = page("redesigned");
  expect(host(root, "hostPill")).toBeUndefined();
  scrolled("down");
  settle();
  expect(host(root, "hostPillHost")!.props.children).toBe("site0.example");
  expect(StyleSheet.flatten(host(root, "hostPill")!.props.style)).toMatchObject({ height: 30, maxWidth: 240, borderRadius: 15 });
  expect(StyleSheet.flatten(host(root, "hostPillHost")!.props.style)).toMatchObject({ fontSize: 13.5, fontWeight: "500" });
  expect(StyleSheet.flatten(host(root, "hostPillFold")!.props.style)).toMatchObject({ bottom: 0, height: 30, alignItems: "center" });
  expect(moved(host(root, "hostPillFold")!)).toEqual({ opacity: 1, translateY: 0, scale: 1 });
  const bar = moved(host(root, "floatingBarFold")!);
  expect(bar.opacity).toBe(0);
  expect(bar.scale).toBeCloseTo(0.62, 3);
  expect(bar.translateY).toBeCloseTo(24 * 0.38, 3);
  expect(host(root, "floatingBarFold")!.props.pointerEvents).toBe("none");
  expect(host(root, "floatingBarFold")!.props.accessibilityElementsHidden).toBe(true);
  expect(moved(host(root, "pageBar")!)).toEqual({ opacity: 1, translateY: 0, scale: 1 });
  unmount(root);
});

test("the pill grows in from the bar's size while the bar shrinks toward it, on main's barCollapse spring; only its contents fade, so its glass is never under a fading parent", () => {
  const root = page("redesigned");
  scrolled("down");
  act(() => jest.advanceTimersByTime(16));
  const pill = moved(host(root, "hostPillFold")!);
  expect(pill.scale).toBeGreaterThan(1);
  expect(pill.scale).toBeLessThanOrEqual(1 / 0.62 + 1e-6);
  expect(pill.opacity).toBe(1);
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
  expect(host(root, "hostPill")).toBeUndefined();
  scrolled("down");
  settle();
  expect(host(root, "hostPill")).toBeUndefined();
  unmount(root);
});

test("scrolling back up, opening another page or turning the preference off expands the bar again", () => {
  const root = page("redesigned");
  for (const expand of [() => scrolled("up"), () => scrolled("down", "https://other.example/"), () => act(() => setPreference("collapsesBottomBar", false))]) {
    act(() => setPreference("collapsesBottomBar", true));
    scrolled("up");
    scrolled("down");
    settle();
    expect(host(root, "hostPill")).toBeDefined();
    expand();
    settle();
    expect(host(root, "hostPill")).toBeUndefined();
    expect(moved(host(root, "floatingBarFold")!).opacity).toBe(1);
  }
  unmount(root);
});

test("with Collapse Bottom Bar off, scrolling down leaves the full bar in place", () => {
  setPreference("collapsesBottomBar", false);
  const root = page("redesigned");
  scrolled("down");
  settle();
  expect(host(root, "hostPill")).toBeUndefined();
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
  const root = renderSurface(<BrowsingScreen tab={currentTabs().open[0]!} />);
  scrolled("down");
  settle();
  expect(root.root.findAll((node) => node.type === HostPill)).toHaveLength(appDesign === "redesigned" ? 1 : 0);
  expect(moved(host(root, "pageBar")!).opacity).toBe(appDesign === "redesigned" ? 1 : 0);
  unmount(root);
});
