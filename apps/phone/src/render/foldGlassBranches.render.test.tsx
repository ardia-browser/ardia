import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { FOLD_REST_EDGE, foldBranchesAttached, foldRestAt } from "../components/browsing/HostPill";
import { DesignProvider } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { setPreference } from "../state/settings/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

const android = Platform.OS === "android";

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  withTabs(3);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  setPreference("collapsesBottomBar", true);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
  setPreference("collapsesBottomBar", false);
});

type Root = ReturnType<typeof renderSurface>;

const scrolled = (scrollDirection: "up" | "down") =>
  act(() => storeNavigation(currentTabs().open[0]!.id, { url: "https://site0.example/", title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));

const page = () => {
  scrolled("up");
  return renderSurface(
    <DesignProvider design="redesigned">
      <BrowsingScreen tabId={currentTabs().open[0]!.id} />
    </DesignProvider>,
  );
};

const settle = () => {
  for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
};

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0];

const within = (node: ReactTestInstance, testID: string) => node.findAll((inner) => inner.props.testID === testID && typeof inner.type === "string").length;

const roles = (root: Root) =>
  root.root
    .findAll((node) => node.type === lookModule.Glass)
    .map((node) => node.props.name as string)
    .sort();

const BAR_ROLES = ["floatingBarAddress", "floatingBarPlus", "floatingBarTabs"];

const branches = (root: Root) => ({
  barBackdrop: within(host(root, "floatingBarFold")!, "glassBehind"),
  pillBackdrop: within(host(root, "hostPillFold")!, "glassBehind"),
  barTexture: host(root, "floatingBarFoldLayer")!.props.renderToHardwareTextureAndroid,
  pillTexture: host(root, "hostPillFoldLayer")!.props.renderToHardwareTextureAndroid,
  roles: roles(root),
});

const expanded = { barBackdrop: 1, pillBackdrop: 0, barTexture: true, pillTexture: false, roles: BAR_ROLES };
const collapsed = { barBackdrop: 0, pillBackdrop: 1, barTexture: false, pillTexture: true, roles: ["hostPill"] };
const folding = { barBackdrop: 1, pillBackdrop: 1, barTexture: true, pillTexture: true, roles: [...BAR_ROLES, "hostPill"].sort() };

const expectBranches = (root: Root, want: typeof expanded) => {
  const now = branches(root);
  expect(now.barBackdrop).toBe(want.barBackdrop);
  expect(now.pillBackdrop).toBe(want.pillBackdrop);
  expect(now.barTexture).toBe(want.barTexture);
  expect(now.pillTexture).toBe(want.pillTexture);
  expect(now.roles.join(",")).toBe(want.roles.join(","));
};

const persistent = ["floatingBarAddressFace", "floatingBarTabsFace", "floatingBarPlusFace", "floatingBarFoldGlyphs", "hostPillFace", "hostPillButton", "hostPillHost"];

const pillProgress = (root: Root) => {
  const style = { ...StyleSheet.flatten(host(root, "hostPillFold")!.props.style), ...getAnimatedStyle(host(root, "hostPillFold")!) } as { opacity?: number };
  return style.opacity ?? 1;
};

test("Android attaches each fold branch's backdrop, glass and texture only while that branch shows, and keeps both through the fold", () => {
  expect(foldBranchesAttached(true, false, "bar")).toMatchObject({ bar: true, pill: false });
  expect(foldBranchesAttached(true, true, "bar")).toMatchObject({ bar: true, pill: true });
  expect(foldBranchesAttached(true, true, null)).toMatchObject({ bar: true, pill: true });
  expect(foldBranchesAttached(true, true, "pill")).toMatchObject({ bar: false, pill: true });
  expect(foldBranchesAttached(true, false, "pill")).toMatchObject({ bar: true, pill: true });
  expect(foldBranchesAttached(false, true, "pill")).toMatchObject({ bar: true, pill: true });
  if (!android) return;
  const root = page();
  expectBranches(root, expanded);
  scrolled("down");
  expectBranches(root, folding);
  act(() => jest.advanceTimersByTime(16));
  expectBranches(root, folding);
  settle();
  expectBranches(root, collapsed);
  scrolled("up");
  expectBranches(root, folding);
  settle();
  expectBranches(root, expanded);
  unmount(root);
});

test("Android's buttons, glyphs and their accessibility nodes stay mounted while their branch's glass comes and goes", () => {
  if (!android) return;
  const root = page();
  const before = persistent.map((id) => host(root, id)!);
  before.forEach((node, index) => expect([persistent[index], node]).not.toContain(undefined));
  scrolled("down");
  settle();
  expect(roles(root)).not.toContain("floatingBarAddress");
  persistent.forEach((id, index) => expect([id, host(root, id) === before[index]]).toEqual([id, true]));
  scrolled("up");
  settle();
  expect(roles(root)).not.toContain("hostPill");
  persistent.forEach((id, index) => expect([id, host(root, id) === before[index]]).toEqual([id, true]));
  expect(host(root, "hostPillButton")!.props.accessibilityLabel).toBe("Show Toolbar");
  unmount(root);
});

test("a fold rests once it is within 2% of an end, so the branch it hid lets go of its glass and page strip without waiting out the spring's tail", () => {
  expect([foldRestAt(1), foldRestAt(0.985), foldRestAt(0.97), foldRestAt(0.5), foldRestAt(0.03), foldRestAt(0.015), foldRestAt(0)]).toEqual([1, 1, -1, -1, -1, 0, 0]);
  if (!android) return;
  const root = page();
  scrolled("down");
  let ms = 0;
  while (ms < 1000 && roles(root).includes("floatingBarAddress")) {
    act(() => jest.advanceTimersByTime(16));
    ms += 16;
  }
  expect(roles(root)).not.toContain("floatingBarAddress");
  expect(pillProgress(root)).toBeGreaterThanOrEqual(1 - FOLD_REST_EDGE);
  expect(ms).toBeLessThan(400);
  unmount(root);
});

test("Android keeps both branches attached through a fold reversed partway, and detaches only once it rests on an end", () => {
  if (!android) return;
  for (const reverseAt of [0.3, 0.7]) {
    const root = page();
    scrolled("down");
    for (let frame = 0; frame < 120 && pillProgress(root) < reverseAt; frame++) act(() => jest.advanceTimersByTime(16));
    expectBranches(root, folding);
    scrolled("up");
    for (let frame = 0; frame < 120; frame++) {
      act(() => jest.advanceTimersByTime(16));
      const now = pillProgress(root);
      if (now > FOLD_REST_EDGE && now < 1 - FOLD_REST_EDGE) expectBranches(root, folding);
    }
    settle();
    expectBranches(root, expanded);
    unmount(root);
  }
});

test("a split glass sits behind its face as the first child, with its role as its name, and iPhone keeps glass as the face's container", () => {
  const root = page();
  if (android) {
    const address = host(root, "floatingBarAddressFace")!;
    const glass = address.findAll((node) => node.type === lookModule.Glass)[0];
    expect(glass!.props.name).toBe("floatingBarAddress");
    expect(glass!.props.testID).toBe("floatingBarAddress");
    expect(StyleSheet.flatten(glass!.props.style)).toMatchObject({ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 });
    expect(address.children[0]).toBe(glass);
  } else {
    expect(host(root, "floatingBarAddressFace")).toBeUndefined();
    const container = root.root.findAll((node) => node.type === lookModule.Glass && node.props.testID === "floatingBarAddress")[0]!;
    expect(container.props.name).toBe("floatingBarAddress");
  }
  unmount(root);
});
