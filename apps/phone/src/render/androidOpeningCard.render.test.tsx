import { PixelRatio, Platform, StyleSheet } from "react-native";
import * as reanimated from "react-native-reanimated";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Surfaces } from "../App";
import { usePreferences } from "../state/settings/store";
import { BottomBar } from "../components/browsing/BottomBar";
import { MaterialBottomBar } from "../components/ui/MaterialBottomBar";
import { DECK, deckGeometry } from "../lib/deckGeometry";

import { coverFrame } from "../components/tabs/DeckCard";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { NO_LAUNCH_ARGUMENTS, parseLaunchArguments } from "../lib/launchArguments";
import * as launchFlags from "../state/app/launchFlags";
import { sendDeckCommand } from "../state/browse/deckCommands";
import * as browseStore from "../state/browse/store";
import { useBrowse } from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

let mockReportsDrawn = true;
let mockNearEnd = false;
let mockHoldsGrowing = false;
let mockHeldGrowing: (() => void) | null = null;

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return {
    ...actual,
    pageReportsDrawn: () => mockReportsDrawn,
    motionReportsNearEnd: () => mockNearEnd,
    MotionView: (props: import("@ardia/phone-native").MotionViewProps) => createElement(actual.MotionView, { ...props, onMotionEnd: undefined }),
  };
});
jest.mock("../platform/lab", () => ({ ...jest.requireActual<object>("../platform/lab"), isLabBuild: true }));
jest.mock("../components/tabs/DeckCard", () => {
  const actual = jest.requireActual<typeof import("../components/tabs/DeckCard")>("../components/tabs/DeckCard");
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return {
    ...actual,
    OpeningCard: (props: Parameters<typeof actual.OpeningCard>[0]) =>
      createElement(actual.OpeningCard, { ...props, onGrowing: () => (mockHoldsGrowing ? (mockHeldGrowing = props.onGrowing) : props.onGrowing()) }),
  };
});

const onAndroid = Platform.OS === "android" ? test : test.skip;

const LANDS_MS = 167;
const EXPANDED_Z = 100_000;

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  mockReportsDrawn = true;
  mockNearEnd = false;
  mockHoldsGrowing = false;
  mockHeldGrowing = null;
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => parseLaunchArguments({ ArdiaOpeningCard: "1" }));
  counted = jest.spyOn(telemetry, "countUsage");
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Placed = { x: number; y: number; scale: number; opacity: number; z: number; width: number; height: number };

const placed = (card: ReactTestInstance): Placed => {
  const style = getAnimatedStyle(card) as { opacity?: number; zIndex?: number; transform?: { translateX?: number; translateY?: number; scale?: number }[] };
  const steps = style.transform ?? [];
  const flat = StyleSheet.flatten(card.props.style) as { width: number; height: number };
  return {
    x: steps.reduce((sum, step) => sum + (step.translateX ?? 0), 0),
    y: steps.reduce((sum, step) => sum + (step.translateY ?? 0), 0),
    scale: steps.reduce((value, step) => (step.scale === undefined ? value : step.scale), 1),
    opacity: style.opacity ?? 1,
    z: style.zIndex ?? 0,
    width: flat.width,
    height: flat.height,
  };
};

const deckCards = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string").map(placed);
const motionView = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type !== "string" && node.props.to !== undefined)[0];
const pageView = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.props.pageId === "string" && typeof node.props.onPageEvent === "function")[0];
const pageOpacity = (root: ReactTestRenderer) => (StyleSheet.flatten(pageView(root)!.props.style) as { opacity?: number }).opacity ?? 1;
const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));
const waited = () => counted.mock.calls.filter(([name]) => name === "card_opens_waited").length;
const cardStops = (root: ReactTestRenderer, finished = true) => act(() => motionView(root, "openingCard")!.props.onMotionEnd(finished));
const openedId = () => {
  const id = useBrowse.getState().opening;
  expect(typeof id).toBe("string");
  return id!;
};
const reportCover = (root: ReactTestRenderer, reason: "drawn" | "cap" = "drawn") => act(() => pageView(root)!.props.onPageEvent({ nativeEvent: { name: "coverHidden", reason, found: true } }));

onAndroid("with ArdiaOpeningCard, the opening card mounts in the tap's own commit already growing, from the card's place in the deck to full screen, and ends square-cornered with its bar band shown", () => {
  const root = renderSurface(<Surfaces />);
  const before = deckCards(root);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  const card = motionView(root, "openingCard")!;
  expect(card).toBeDefined();
  const { from, to } = card.props;
  const centerX = from.translateX + 393 / 2;
  const centerY = from.translateY + 873 / 2;
  const tapped = before.reduce((best, now) => (Math.abs(now.x + now.width / 2 - centerX) < Math.abs(best.x + best.width / 2 - centerX) ? now : best));
  expect(tapped.x + tapped.width / 2).toBeCloseTo(centerX, 3);
  expect(tapped.y + tapped.height / 2).toBeCloseTo(centerY, 3);
  const frame = StyleSheet.flatten(card.props.style) as { width: number; height: number; borderWidth?: number };
  expect(from.scale).toBeLessThanOrEqual(1);
  expect(frame.width * from.scale).toBeCloseTo(tapped.width, 5);
  expect(from.cornerRadius * from.scale).toBeCloseTo(DECK.cardRadius, 5);
  expect(to).toMatchObject({ translateX: 0, translateY: 0, cornerRadius: 0 });
  expect(frame.width * to.scale).toBeCloseTo(393, 5);
  expect(frame.height * to.scale).toBeCloseTo(873, 5);
  expect(card.props.nativeID).toBe("openingCover");
  expect(frame.borderWidth).toBeUndefined();
  expect(motionView(root, "openingCardEdge")!.props.from).toEqual({ opacity: 1 });
  expect(motionView(root, "openingCardEdge")!.props.to).toEqual({ opacity: 0 });
  expect(typeof card.props.onMotionEnd).toBe("function");
  const band = motionView(root, "openingCardBand")!;
  const bandFrame = StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "openingCardBandFill" && typeof node.type === "string")[0]!.props.style);
  expect(bandFrame).toMatchObject({ position: "absolute", left: 0, width: frame.width });
  expect(bandFrame.top + bandFrame.height).toBeCloseTo(frame.height, 5);
  expect(bandFrame.right).toBeUndefined();
  expect(bandFrame.bottom).toBeUndefined();
  expect(band.props.from.translateY).toBeGreaterThan(0);
  expect(band.props.to).toEqual({ translateY: 0 });
  expect(motionView(root, "openingCardFace")!.props.from).toEqual({ translateY: 0 });
  expect(motionView(root, "openingCardFace")!.props.to.translateY).toBeGreaterThan(0);
  expect(motionView(root, "deckChromeFade")!.props.to.opacity).toBe(0);
  unmount(root);
});

onAndroid("with ArdiaOpeningCard, the tap leaves every deck card's pose alone (no expanded card yet), and the opening card's mount hides the tapped card and gives it the expanded role in one worklet, before any spring", () => {
  mockHoldsGrowing = true;
  const root = renderSurface(<Surfaces />);
  const before = deckCards(root);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  expect(motionView(root, "openingCard")).toBeDefined();
  expect(mockHeldGrowing).not.toBeNull();
  expect(deckCards(root)).toEqual(before);
  advance(64);
  expect(deckCards(root)).toEqual(before);
  expect(useBrowse.getState().opening).toBeNull();
  const worklets = jest.spyOn(reanimated, "runOnUI");
  act(() => mockHeldGrowing!());
  expect(worklets).toHaveBeenCalledTimes(1);
  worklets.mockRestore();
  for (let frame = 0; frame < 8; frame++) {
    advance(16);
    for (const card of deckCards(root)) expect(card.z >= EXPANDED_Z).toBe(card.opacity === 0);
  }
  const now = deckCards(root);
  const hidden = now.filter((card) => card.opacity === 0);
  expect(hidden).toHaveLength(1);
  expect(hidden[0]!.z).toBeGreaterThanOrEqual(EXPANDED_Z);
  expect(now.some((card, index) => card.opacity > 0 && card.x !== before[index]!.x)).toBe(true);
  unmount(root);
});

onAndroid("with ArdiaOpeningCard, the page isn't made in the tap's commit but a frame after the growth starts, veiled at opacity 0", () => {
  const root = renderSurface(<Surfaces />);
  const selected = currentTabs().selectedId;
  act(() => sendDeckCommand({ kind: "openFocused" }));
  expect(motionView(root, "openingCard")).toBeDefined();
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", opening: null });
  expect(currentTabs().selectedId).toBe(selected);
  expect(pageView(root)).toBeUndefined();
  advance(16);
  const id = openedId();
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", opening: id, veiled: id });
  expect(pageView(root)!.props.pageId).toBe(id);
  expect(pageOpacity(root)).toBe(0);
  unmount(root);
});

onAndroid("with ArdiaOpeningCard, the page is unveiled when the opening card's motion ends, not on a timer, and the deck's cards go straight to their end then", () => {
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(LANDS_MS + 100);
  const id = openedId();
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", veiled: id });
  expect(pageOpacity(root)).toBe(0);
  cardStops(root, false);
  expect(useBrowse.getState().veiled).toBe(id);
  cardStops(root);
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", veiled: null });
  expect(pageOpacity(root)).toBe(1);
  const landed = deckCards(root);
  advance(48);
  expect(deckCards(root)).toEqual(landed);
  unmount(root);
});

onAndroid("with ArdiaOpeningCard, an opening card whose motion end never comes still unveils the page at twice the landing time", () => {
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(2 * LANDS_MS - 8);
  const id = openedId();
  expect(useBrowse.getState().veiled).toBe(id);
  advance(16);
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", veiled: null });
  unmount(root);
});

onAndroid("with ArdiaOpeningCard, the page view is handed the opening card to hide, and takes over in the same call as its report that it hid it on its first drawn frame; that open isn't counted as waited", () => {
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(LANDS_MS);
  cardStops(root);
  advance(100);
  expect(useBrowse.getState().surface).toBe("deck");
  expect(root.root.findAll((node) => node.props.coverNativeId === "openingCover" && typeof node.props.onPageCoverHidden === "function")).not.toHaveLength(0);
  reportCover(root);
  expect(useBrowse.getState()).toMatchObject({ surface: "browsing", opening: null, veiled: null, covered: null });
  expect(waited()).toBe(0);
  unmount(root);
});

onAndroid("with ArdiaOpeningCard, a page whose view hid the card at its 200 ms cap takes over then and that open is counted as waited; with no report at all the deck still gives way after 500 ms, also counted", () => {
  let root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(LANDS_MS);
  cardStops(root);
  reportCover(root, "cap");
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(waited()).toBe(1);
  unmount(root);
  act(() => useBrowse.setState({ surface: "deck", deckEntrance: null, opening: null, veiled: null, covered: null }));
  root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(LANDS_MS);
  cardStops(root);
  advance(499);
  expect(useBrowse.getState().surface).toBe("deck");
  advance(1);
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(waited()).toBe(2);
  unmount(root);
});

onAndroid("with ArdiaOpeningCard where MotionView reports its near end, the opening card asks for the last 2 device pixels and the page is unveiled there instead of at the motion's end", () => {
  mockNearEnd = true;
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(LANDS_MS - 60);
  const id = openedId();
  const card = motionView(root, "openingCard")!;
  expect(card.props.nearEndPx).toBe(2);
  expect(useBrowse.getState().veiled).toBe(id);
  act(() => card.props.onMotionNearEnd(2));
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", veiled: null, covered: id });
  reportCover(root);
  expect(useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});

onAndroid("with ArdiaOpeningCard, a card that stops before the page is made still makes it, shown, and hands over on drawn", () => {
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  expect(useBrowse.getState().opening).toBeNull();
  cardStops(root);
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", opening: openedId(), veiled: null });
  advance(16);
  expect(useBrowse.getState().veiled).toBeNull();
  reportCover(root);
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(waited()).toBe(0);
  unmount(root);
});

onAndroid("with ArdiaOpeningCard where the page view can't report drawn, the page takes over when the card stops once it has laid out, as without it", () => {
  mockReportsDrawn = false;
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(16);
  landOpeningPage(root);
  advance(LANDS_MS + 100);
  expect(useBrowse.getState().surface).toBe("deck");
  cardStops(root);
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(waited()).toBe(0);
  unmount(root);
});

onAndroid("without ArdiaOpeningCard, Android opens a card as before: no opening card and no page while the card grows", () => {
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => NO_LAUNCH_ARGUMENTS);
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  for (let frame = 0; frame < 6; frame++) {
    advance(16);
    expect(motionView(root, "openingCard")).toBeUndefined();
    expect(useBrowse.getState().opening).toBeNull();
  }
  unmount(root);
});

test("while a deck card grows into the page, neither phone draws a second page bar: the deck's own bar stays until the page's bar takes over", () => {
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => NO_LAUNCH_ARGUMENTS);
  const root = renderSurface(<Surfaces />);
  const ghost = () => root.root.findAll((node) => node.props.testID === "pageBarGhost" && typeof node.type !== "string")[0];
  expect(ghost()).toBeUndefined();
  act(() => sendDeckCommand({ kind: "openFocused" }));
  for (let frame = 0; frame < 12; frame++) {
    advance(16);
    expect(ghost()).toBeUndefined();
  }
  unmount(root);
});

onAndroid("opening the Material tab switcher retains the permanent bar and never draws a ghost or classic BottomBar", () => {
  usePreferences.setState({ materialYou: true });
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => NO_LAUNCH_ARGUMENTS);
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, leaving: null });
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  const ghost = () => root.root.findAll((node) => node.props.testID === "pageBarGhost" && typeof node.type !== "string")[0];
  expect(ghost()).toBeUndefined();
  act(() => void browseStore.showDeck());
  advance(16);
  expect(ghost()).toBeUndefined();
  expect(root.root.findAll((node) => node.type === MaterialBottomBar)).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === BottomBar)).toHaveLength(0);
  unmount(root);
  usePreferences.setState({ materialYou: false });
});

onAndroid("after an open through the opening card, the deck reopens settled and opens another card the same way", () => {
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(LANDS_MS);
  cardStops(root);
  reportCover(root);
  expect(useBrowse.getState().surface).toBe("browsing");
  act(() => useBrowse.setState({ surface: "deck", deckEntrance: null, opening: null, veiled: null }));
  advance(1000);
  expect(motionView(root, "openingCard")).toBeUndefined();
  expect(deckCards(root).every((card) => card.opacity === 1 && card.z < EXPANDED_Z)).toBe(true);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  expect(motionView(root, "openingCard")).toBeDefined();
  advance(LANDS_MS);
  cardStops(root);
  reportCover(root);
  expect(useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});

test("the covering card lays out in the screen's own shape on whole pixels, so one scale lands it on the POCO F4's 1080 by 2400 exactly, and it starts at the deck card's width", () => {
  const ratio = 2.75;
  const g = deckGeometry(1080 / ratio, 2400 / ratio, 80 / ratio, 130 / ratio, 0, "android", "redesigned", deckHeaderBottom());
  const frame = coverFrame(g, ratio);
  const px = (dp: number) => dp * ratio;
  expect(px(frame.width)).toBeCloseTo(Math.round(px(frame.width)), 6);
  expect(px(frame.height)).toBeCloseTo(Math.round(px(frame.height)), 6);
  expect(px(frame.left)).toBeCloseTo(Math.round(px(frame.left)), 6);
  expect(px(frame.top)).toBeCloseTo(Math.round(px(frame.top)), 6);
  expect([Math.round(px(frame.width)), Math.round(px(frame.height))]).toEqual([756, 1680]);
  expect(px(frame.width) * frame.scale).toBeCloseTo(1080, 6);
  expect(px(frame.height) * frame.scale).toBeCloseTo(2400, 6);
  expect(px(frame.left) + px(frame.width) / 2).toBeCloseTo(540, 6);
  expect(frame.width * frame.startScale).toBeCloseTo(g.cardWidth, 6);
  const tall = coverFrame(deckGeometry(1080 / ratio, 2412 / ratio, 80 / ratio, 130 / ratio, 0, "android", "redesigned", deckHeaderBottom()), ratio);
  expect(px(tall.width) * tall.scale).toBeCloseTo(1080, 6);
  expect(px(tall.height) * tall.scale).toBeCloseTo(2412, 6);
});

onAndroid("with ArdiaOpeningCard, the deck moves off screen on the UI thread in the cover report's own call (a move, never a fade, so its glass is never under a fading parent), before React switches to browsing, so the page and its bar under it show at once", () => {
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  advance(LANDS_MS);
  cardStops(root);
  advance(100);
  const deckAway = () => ((getAnimatedStyle(root.root.findAll((node) => node.props.testID === "tabDeck" && typeof node.type === "string")[0]!) as { transform?: { translateX?: number }[] }).transform ?? [])[0]?.translateX ?? 0;
  expect(deckAway()).toBe(0);
  const switched = jest.spyOn(browseStore, "openTab").mockImplementation(() => undefined);
  reportCover(root);
  expect(switched).toHaveBeenCalledTimes(1);
  expect(useBrowse.getState().surface).toBe("deck");
  expect(deckAway()).toBeGreaterThan(10_000);
  switched.mockRestore();
  unmount(root);
});
