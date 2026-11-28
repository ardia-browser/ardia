import { Dimensions, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle, makeMutable } from "react-native-reanimated";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { DeckStripCurtain } from "../components/tabs/DeckStripCurtain";
import { DesignProvider } from "../components/ui";
import { deckCurtain, deckGeometry } from "../lib/deckGeometry";
import { setRootSize } from "../state/app/rootSize";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

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

function deckOn(pose: Pose) {
  Dimensions.set({ window: { ...PORTRAIT, width: pose.width, height: pose.height }, screen: { ...PORTRAIT, width: pose.width, height: pose.height } });
  act(() => setRootSize(pose.width, pose.height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => pose.insets);
  act(() => useScreenLayout.setState({ hinge: pose.hinge }));
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null }));
  return renderSurface(
    <DesignProvider design="redesigned">
      <TabDeck />
    </DesignProvider>,
  );
}

const hosts = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const order = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string").map((node) => node.props.testID as string);

for (const [name, pose] of [["closed", CLOSED], ["open", OPEN]] as const) {
  test(`on the ${name} Duo the deck's cards run on under the strip at full width, and a curtain of the deck's backdrop covers it from 32 before the strip, under the deck's own buttons`, () => {
    const root = deckOn(pose);
    const g = deckGeometry(pose.width, pose.height, pose.insets.top, pose.insets.bottom, pose.insets.right, Platform.OS, "redesigned", 0, 55, "arc", { side: "right", inset: pose.insets.right });
    const cards = hosts(root, "deckCard").map((card) => getAnimatedStyle(card) as { width: number });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.map((card) => card.width)).toEqual(cards.map(() => g.cardWidth));
    const curtain = hosts(root, "deckStripCurtain");
    expect(curtain).toHaveLength(1);
    expect(StyleSheet.flatten(curtain[0]!.props.style)).toMatchObject({ left: pose.width - 84 - 32, width: 116, height: pose.height, overflow: "hidden" });
    expect(getAnimatedStyle(curtain[0]!).opacity).toBe(1);
    const fade = root.root.findAll((node) => node.props.testID === "deckStripCurtainFade" && typeof node.type !== "string")[0]!;
    expect(fade.props.leading).toEqual({ length: 32 });
    expect(fade.props.trailing).toBeUndefined();
    expect(curtain[0]!.findAll((node) => node.props.testID === "backdropBase" || (typeof node.type !== "string" && node.props.baseOutside === true)).length).toBeGreaterThan(0);
    const ids = order(root);
    for (const above of ["deckBottomBar", "deckStripPlus", "deckStripIncognito", "deckStripMore"]) expect(ids.indexOf("deckStripCurtain")).toBeLessThan(ids.indexOf(above));
    expect(ids.lastIndexOf("deckCard")).toBeLessThan(ids.indexOf("deckStripCurtain"));
    unmount(root);
  });
}

test("with the strip on the left the curtain mirrors, fading on its trailing side", () => {
  const root = deckOn({ ...CLOSED, insets: { top: 0, bottom: 34, left: 84, right: 0 } });
  const curtain = hosts(root, "deckStripCurtain")[0]!;
  expect(StyleSheet.flatten(curtain.props.style)).toMatchObject({ left: 0, width: 116 });
  const fade = root.root.findAll((node) => node.props.testID === "deckStripCurtainFade" && typeof node.type !== "string")[0]!;
  expect(fade.props.trailing).toEqual({ length: 32 });
  expect(fade.props.leading).toBeUndefined();
  unmount(root);
});

for (const [name, pose] of [["upright", IPHONE], ["on its side", IPHONE_SIDE]] as const) {
  test(`a plain iPhone ${name} has no curtain`, () => {
    const root = deckOn(pose);
    expect(hosts(root, "deckStripCurtain")).toHaveLength(0);
    expect(hosts(root, "deckCard").length).toBeGreaterThan(0);
    unmount(root);
  });
}

const closedCurtain = () => deckCurtain(deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", { side: "right", inset: 84 }))!;

test("the curtain's opacity is the expanding card's scale progress: whole at rest, fading as the card grows over the strip, gone at the page's size, and back as it shrinks", () => {
  const expandedIndex = makeMutable(-1);
  const scaleProgress = makeMutable(1);
  const root = renderSurface(<DeckStripCurtain curtain={closedCurtain()} width={466} height={678} expandedIndex={expandedIndex} scaleProgress={scaleProgress} reduceMotion={false} darkDepth={false} incognito={false} />);
  const opacity = () => getAnimatedStyle(hosts(root, "deckStripCurtain")[0]!).opacity;
  expect(opacity()).toBe(1);
  for (const progress of [1, 0.75, 0.4, 0.1, 0, 0.5, 1]) {
    act(() => {
      expandedIndex.value = 1;
      scaleProgress.value = progress;
    });
    act(() => jest.advanceTimersByTime(16));
    expect(opacity()).toBeCloseTo(progress, 6);
  }
  act(() => {
    expandedIndex.value = -1;
    scaleProgress.value = 0;
  });
  act(() => jest.advanceTimersByTime(16));
  expect(opacity()).toBe(1);
  unmount(root);
});

test("under Reduce Motion the curtain fades out and back in plainly, never jumping", () => {
  const expandedIndex = makeMutable(-1);
  const scaleProgress = makeMutable(1);
  const root = renderSurface(<DeckStripCurtain curtain={closedCurtain()} width={466} height={678} expandedIndex={expandedIndex} scaleProgress={scaleProgress} reduceMotion darkDepth={false} incognito={false} />);
  const opacity = () => getAnimatedStyle(hosts(root, "deckStripCurtain")[0]!).opacity as number;
  act(() => {
    expandedIndex.value = 0;
    scaleProgress.value = 0;
  });
  act(() => jest.advanceTimersByTime(60));
  expect(opacity()).toBeGreaterThan(0);
  expect(opacity()).toBeLessThan(1);
  act(() => jest.advanceTimersByTime(1000));
  expect(opacity()).toBe(0);
  act(() => {
    expandedIndex.value = -1;
  });
  act(() => jest.advanceTimersByTime(60));
  expect(opacity()).toBeGreaterThan(0);
  expect(opacity()).toBeLessThan(1);
  act(() => jest.advanceTimersByTime(1000));
  expect(opacity()).toBe(1);
  unmount(root);
});
