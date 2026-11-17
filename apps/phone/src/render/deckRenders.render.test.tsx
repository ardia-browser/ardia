import { Platform, StyleSheet } from "react-native";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import * as perf from "../state/app/interactionPerf";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let renders: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  renders = [];
  jest.spyOn(perf, "countRender").mockImplementation((component: string) => {
    renders.push(component);
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const cardRenders = () => renders.filter((component) => component === "DeckCard").length;

type Root = ReturnType<typeof renderSurface>;

const cardZ = (root: Root) =>
  root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string").map((card) => (getAnimatedStyle(card).zIndex as number | undefined) ?? 0);

test("opening one card from the deck renders no card again: the opened card's role, its place on top and its neighbours' slide all run on the UI thread", () => {
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />);
  const mounted = cardRenders();
  expect(mounted).toBeGreaterThan(0);
  expect(Math.max(...cardZ(root))).toBeLessThan(100_000);
  renders = [];
  act(() => sendDeckCommand({ kind: "openFocused" }));
  act(() => jest.advanceTimersByTime(16 * 18));
  expect(cardRenders()).toBe(0);
  expect(Math.max(...cardZ(root))).toBeGreaterThanOrEqual(100_000);
  expect(cardZ(root).filter((z) => z >= 100_000)).toHaveLength(1);
  unmount(root);
});

test("opening the deck from a page renders each mounted card once, and its spring settling renders none again", () => {
  const entrance = currentTabs().selectedId!;
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: entrance, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />, { flushTimers: false });
  const mounted = cardRenders();
  act(() => jest.advanceTimersByTime(16));
  expect(cardZ(root).filter((z) => z >= 100_000)).toHaveLength(1);
  act(() => jest.advanceTimersByTime(3000));
  expect(cardRenders()).toBe(mounted);
  expect(Math.max(...cardZ(root))).toBeLessThan(100_000);
  expect(root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")).toHaveLength(mounted);
  unmount(root);
});

test("a deck open never resizes the cards' container, and once it has settled nothing about the cards changes for two seconds: no card renders and no card style, so the phone redraws no card late", () => {
  const entrance = currentTabs().selectedId!;
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: entrance, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />, { flushTimers: false });
  const cards = () => root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");
  const containerHeight = () => StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "deckCards" && typeof node.type === "string")[0]!.props.style).height;
  const cardStyles = () => JSON.stringify(cards().map((card) => [StyleSheet.flatten(card.props.style), getAnimatedStyle(card)]));
  const heights = new Set([containerHeight()]);
  let settledAt = -1;
  for (let frame = 0; frame < 300; frame++) {
    act(() => jest.advanceTimersByTime(16));
    heights.add(containerHeight());
    if (settledAt < 0 && frame > 2 && Math.max(...cardZ(root)) < 100_000) settledAt = frame;
    if (settledAt >= 0 && frame === settledAt + 1) {
      const rendersAtRest = cardRenders();
      const atRest = cardStyles();
      for (let later = 0; later < 125; later++) {
        act(() => jest.advanceTimersByTime(16));
        heights.add(containerHeight());
      }
      expect(cardRenders()).toBe(rendersAtRest);
      expect(cardStyles()).toBe(atRest);
      break;
    }
  }
  expect(settledAt).toBeGreaterThan(0);
  expect([...heights]).toEqual([873]);
  unmount(root);
});

test("a touch in the band above the deck bar starts no card gesture, the clearance the cards' container used to give by ending there", () => {
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />);
  const slop = (getByGestureTestId("deckPan") as unknown as { config: { hitSlop?: { bottom?: number } } }).config.hitSlop;
  expect(slop?.bottom).toBeLessThan(-40);
  unmount(root);
});

(Platform.OS === "ios" ? test : test.skip)("on iPhone, an opening card grows as one Core Animation move from its deck place to full screen; the page is prepared two frames after it starts, and takes over only once the card has landed", () => {
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  const overlay = () => root.root.findAll((node) => node.props.testID === "openingCard" && typeof node.type === "string")[0];
  act(() => jest.advanceTimersByTime(16));
  const first = overlay();
  expect(first).toBeTruthy();
  let preparedAt = -1;
  let switchedAt = -1;
  for (let frame = 2; frame <= 40 && switchedAt < 0; frame++) {
    act(() => jest.advanceTimersByTime(16));
    if (preparedAt < 0 && useBrowse.getState().opening !== null) preparedAt = frame * 16;
    if (useBrowse.getState().surface === "browsing") switchedAt = frame * 16;
  }
  const [landed, rest] = Platform.OS === "ios" ? [168, 216] : [280, 336];
  expect(preparedAt).toBeGreaterThan(0);
  expect(preparedAt).toBeLessThanOrEqual(96);
  expect(switchedAt).toBeGreaterThanOrEqual(landed);
  expect(switchedAt).toBeLessThanOrEqual(Math.max(rest, 250 + 64));
  unmount(root);
});

(Platform.OS === "android" ? test : test.skip)("on Android, a card hands over to its page once it is within 2% of full size, not when its spring comes to rest, so the page takes over as the card lands", () => {
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let handedAt = -1;
  for (let frame = 1; frame <= 30 && handedAt < 0; frame++) {
    act(() => jest.advanceTimersByTime(16));
    if (useBrowse.getState().opening !== null) handedAt = frame * 16;
  }
  expect(useBrowse.getState().opening).toBeTruthy();
  const [landed, rest] = Platform.OS === "ios" ? [192, 216] : [304, 336];
  expect(handedAt).toBeGreaterThan(120);
  expect(handedAt).toBeLessThanOrEqual(landed);
  expect(handedAt).toBeLessThan(rest);
  unmount(root);
});
