import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { notePicturePainted, noteSnapshotShown } from "../lib/shownSnapshots";
import { pages } from "../platform/pages";
import * as system from "../platform/system";
import { armDeckPull } from "../state/browse/deckPull";
import * as browse from "../state/browse/store";
import * as telemetry from "../state/telemetry/telemetry";
import { currentTabs, useTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const PICTURE = "file:///snapshots/leaving.jpg";

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_790_000_060_000);
  withTabs(3);
  const selected = currentTabs().selectedId!;
  useTabs.setState((state) => ({ open: state.open.map((tab) => (tab.id === selected ? { ...tab, snapshotFileName: PICTURE } : tab)) }));
  noteSnapshotShown(PICTURE);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null });
  jest.spyOn(pages, "snapshot").mockImplementation(() => new Promise(() => undefined) as never);
  jest.spyOn(pages, "close").mockImplementation(async () => undefined);
  jest.spyOn(system, "prefetchImage").mockImplementation(async () => true);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const page = (root: Root) => root.root.findAll((node) => (node.type as { name?: string })?.name === "BrowsingScreen");
const cards = (root: Root) => root.root.findAll((node) => node.props.testID === "deckCards" && typeof node.type === "string")[0]!;
const opacity = (node: ReactTestInstance) => (getAnimatedStyle(node).opacity as number | undefined) ?? 1;
const picture = (root: Root) => cards(root).findAll((node) => node.props.source?.uri === PICTURE && typeof node.props.onLoad === "function" && typeof node.type !== "string")[0]!;

const PAGE_OVER_DECK = true;

async function openDeck(root: Root) {
  armDeckPull(null);
  await act(async () => {
    const opening = browse.showDeck();
    jest.advanceTimersByTime(450);
    await opening;
  });
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(root).toBeDefined();
}

test("when the page can't be pulled into the deck, leaving it keeps the page on screen, with the deck clear, until the leaving card's picture has painted, so no frame is white", async () => {
  const root = renderSurface(<Surfaces />);
  await openDeck(root);
  expect(page(root)).toHaveLength(1);
  expect(opacity(cards(root))).toBe(0);
  const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string" && node.findAll((inner) => inner.props.source?.uri === PICTURE).length > 0)[0]!;
  expect(card).toBeDefined();
  act(() => jest.advanceTimersByTime(120));
  expect(page(root)).toHaveLength(1);
  expect(opacity(cards(root))).toBe(0);
  expect(picture(root).props.fadeDuration).toBe(0);
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => picture(root).props.onLoad({ nativeEvent: { source: { width: 600, height: 1300 } } }));
  act(() => jest.advanceTimersByTime(40));
  expect(opacity(cards(root))).toBe(1);
  expect(StyleSheet.flatten(picture(root).props.style).aspectRatio).toBeCloseTo(600 / 1300);
  expect(page(root)).toHaveLength(PAGE_OVER_DECK ? 0 : 1);
  for (let frame = 0; frame < 150 && browse.useBrowse.getState().leaving !== null; frame++) act(() => jest.advanceTimersByTime(16));
  expect(browse.useBrowse.getState().leaving).toBeNull();
  expect(page(root)).toHaveLength(0);
  expect(counted).not.toHaveBeenCalledWith("deck_pictures_late");
  unmount(root);
});

test("if the picture never reports, the deck still opens after a short cap instead of holding the page, and counts the late picture", async () => {
  const counted = jest.spyOn(telemetry, "countUsage");
  const root = renderSurface(<Surfaces />);
  await openDeck(root);
  act(() => jest.advanceTimersByTime(300));
  expect(opacity(cards(root))).toBe(1);
  expect(counted).toHaveBeenCalledWith("deck_pictures_late");
  unmount(root);
});

test("a tab with no picture shrinks at once, since its placeholder draws in the first frame", async () => {
  useTabs.setState((state) => ({ open: state.open.map((tab) => ({ ...tab, snapshotFileName: null })) }));
  const root = renderSurface(<Surfaces />);
  await openDeck(root);
  expect(opacity(cards(root))).toBe(1);
  unmount(root);
});

test("the bottom bar's thumbnail of the same picture loading first doesn't start the shrink; only the leaving card's own picture does", async () => {
  const root = renderSurface(<Surfaces />);
  await openDeck(root);
  act(() => notePicturePainted(PICTURE));
  act(() => jest.advanceTimersByTime(40));
  expect(opacity(cards(root))).toBe(0);
  act(() => picture(root).props.onLoad({ nativeEvent: { source: { width: 600, height: 1300 } } }));
  act(() => jest.advanceTimersByTime(40));
  expect(opacity(cards(root))).toBe(1);
  unmount(root);
});
