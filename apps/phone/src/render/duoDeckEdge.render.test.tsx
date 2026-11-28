import { Dimensions, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { DesignProvider } from "../components/ui";
import { deckGeometry, deckLeading, type DeckEdge } from "../lib/deckGeometry";
import { NO_LAUNCH_ARGUMENTS, parseLaunchArguments } from "../lib/launchArguments";
import * as launchFlags from "../state/app/launchFlags";
import { setRootSize } from "../state/app/rootSize";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/lab", () => ({ ...jest.requireActual<object>("../platform/lab"), isLabBuild: true }));

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const PORTRAIT = Dimensions.get("window");

type Pose = { width: number; height: number; insets: { top: number; bottom: number; left: number; right: number }; hinge: ScreenHinge };

const CLOSED: Pose = { width: 466, height: 678, insets: { top: 0, bottom: 34, left: 0, right: 84 }, hinge: "closed" };
const OPEN: Pose = { width: 951, height: 669, insets: { top: 0, bottom: 34, left: 0, right: 84 }, hinge: "fullyOpen" };
const IPHONE: Pose = { width: 402, height: 874, insets: { top: 62, bottom: 34, left: 0, right: 0 }, hinge: "none" };
const IPHONE_SIDE: Pose = { width: 852, height: 393, insets: { top: 0, bottom: 21, left: 59, right: 59 }, hinge: "none" };

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  act(() => setRootSize(0, 0));
  Dimensions.set({ window: PORTRAIT, screen: PORTRAIT });
  act(() => useScreenLayout.setState({ hinge: "none" }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function deckOn(pose: Pose, edge: DeckEdge | null) {
  Dimensions.set({ window: { ...PORTRAIT, width: pose.width, height: pose.height }, screen: { ...PORTRAIT, width: pose.width, height: pose.height } });
  act(() => setRootSize(pose.width, pose.height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => pose.insets);
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => (edge ? parseLaunchArguments({ ArdiaDuoDeckEdge: edge }) : NO_LAUNCH_ARGUMENTS));
  act(() => useScreenLayout.setState({ hinge: pose.hinge }));
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  return renderSurface(
    <DesignProvider design="redesigned">
      <TabDeck />
    </DesignProvider>,
  );
}

const hosts = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const cardStyles = (root: ReactTestRenderer) => hosts(root, "deckCard").map((card) => getAnimatedStyle(card) as { width?: number; opacity: number; transform: Record<string, number>[] });

const geometryOf = (pose: Pose, edge: DeckEdge) => deckGeometry(pose.width, pose.height, pose.insets.top, pose.insets.bottom, pose.insets.right, Platform.OS, "redesigned", deckHeaderBottom(), 55, "arc", { side: "right", inset: pose.insets.right, edge });

for (const [name, pose, end] of [["closed", CLOSED, 374], ["open", OPEN, 859]] as const) {
  test(`on the ${name} Duo the deck fits by default: the next card is a slice ending at ${end}, 8 short of the strip, with no curtain`, () => {
    const root = deckOn(pose, null);
    const g = geometryOf(pose, "fit");
    expect(g.edge).toBe(end);
    const shown = cardStyles(root).filter((style) => style.opacity > 0);
    const widths = shown.map((style) => style.width!);
    expect(widths.every((width) => typeof width === "number" && width <= g.cardWidth + 1e-6)).toBe(true);
    const all = cardStyles(root);
    const slice = shown.find((style) => style.width! < g.cardWidth - 1)!;
    const left = Object.assign({}, ...slice.transform).translateX as number;
    expect(left).toBeCloseTo(deckLeading(g, 1), 3);
    expect(left + slice.width!).toBeCloseTo(end, 3);
    const sliceCard = hosts(root, "deckCard")[all.findIndex((style) => style.width === slice.width && style.opacity > 0)]!;
    expect(StyleSheet.flatten(sliceCard.props.style)).toMatchObject({ overflow: "hidden" });
    expect((getAnimatedStyle(sliceCard) as { borderRadius: number }).borderRadius).toBe(g.cardCorner);
    expect(hosts(root, "deckStripCurtain")).toHaveLength(0);
    unmount(root);
  });
}

test("with -ArdiaDuoDeckEdge fade the closed Duo's cards run under the strip at full width, and a curtain of the deck's backdrop covers 358 to 466, its first 24 points fading in over eight steps", () => {
  const root = deckOn(CLOSED, "fade");
  const g = geometryOf(CLOSED, "fade");
  expect(g.fitsEdge).toBe(false);
  expect(cardStyles(root).map((style) => style.width)).toEqual(cardStyles(root).map(() => g.cardWidth));
  const curtain = hosts(root, "deckStripCurtain");
  expect(curtain).toHaveLength(1);
  const slices = hosts(root, "deckStripCurtainSlice").map((slice) => StyleSheet.flatten(slice.props.style) as { left: number; width: number; opacity: number });
  expect(slices).toHaveLength(9);
  expect(slices[0]).toMatchObject({ left: 358, width: 3 });
  expect(slices[0]!.opacity).toBeCloseTo(1 / 9, 6);
  expect(slices[7]!.opacity).toBeCloseTo(8 / 9, 6);
  expect(slices[8]).toMatchObject({ left: 382, width: 84, opacity: 1 });
  expect(curtain[0]!.findAll((node) => node.props.testID === "backdropBase" || (typeof node.type !== "string" && node.props.baseOutside === true)).length).toBeGreaterThan(0);
  unmount(root);
});

for (const [name, pose] of [["upright", IPHONE], ["on its side", IPHONE_SIDE]] as const) {
  for (const edge of ["fit", "fade"] as const) {
    test(`a plain iPhone ${name} ignores -ArdiaDuoDeckEdge ${edge}: no curtain, and no card animates its width`, () => {
      const root = deckOn(pose, edge);
      expect(hosts(root, "deckStripCurtain")).toHaveLength(0);
      const g = deckGeometry(pose.width, pose.height, pose.insets.top, pose.insets.bottom, Math.max(pose.insets.left, pose.insets.right), Platform.OS, "redesigned", deckHeaderBottom(), 55, "arc");
      const styles = cardStyles(root);
      expect(styles.length).toBeGreaterThan(0);
      expect(styles.map((style) => style.width)).toEqual(styles.map(() => g.cardWidth));
      expect(styles.every((style) => style.opacity > 0)).toBe(true);
      unmount(root);
    });
  }
}
