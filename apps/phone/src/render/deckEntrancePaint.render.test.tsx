import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { noteSnapshotShown } from "../lib/shownSnapshots";
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

async function openDeck(root: Root) {
  armDeckPull(null);
  await act(async () => {
    void browse.showDeck();
  });
  expect(browse.useBrowse.getState().surface).toBe("deck");
  act(() => jest.advanceTimersByTime(16));
  expect(root).toBeDefined();
}

test("when the page can't be pulled into the deck, the deck shrinks on the next frame without waiting for the leaving card's picture, and the page leaves as the shrink starts", async () => {
  const root = renderSurface(<Surfaces />);
  await openDeck(root);
  expect(opacity(cards(root))).toBe(1);
  expect(page(root)).toHaveLength(0);
  expect(picture(root).props.fadeDuration).toBe(0);
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => picture(root).props.onLoad({ nativeEvent: { source: { width: 600, height: 1300 } } }));
  act(() => jest.advanceTimersByTime(400));
  expect(StyleSheet.flatten(picture(root).props.style).aspectRatio).toBeCloseTo(600 / 1300);
  expect(browse.useBrowse.getState().leaving).toBeNull();
  expect(counted).not.toHaveBeenCalledWith("deck_pictures_late");
  unmount(root);
});

test("if the leaving card's picture still hasn't painted when the shrink lands, the deck is already open and the late picture is counted", async () => {
  const counted = jest.spyOn(telemetry, "countUsage");
  const root = renderSurface(<Surfaces />);
  await openDeck(root);
  expect(opacity(cards(root))).toBe(1);
  act(() => jest.advanceTimersByTime(400));
  expect(counted).toHaveBeenCalledWith("deck_pictures_late");
  unmount(root);
});

test("a tab with no picture shrinks at once, since its placeholder draws in the first frame, and nothing is counted late", async () => {
  useTabs.setState((state) => ({ open: state.open.map((tab) => ({ ...tab, snapshotFileName: null })) }));
  const counted = jest.spyOn(telemetry, "countUsage");
  const root = renderSurface(<Surfaces />);
  await openDeck(root);
  expect(opacity(cards(root))).toBe(1);
  act(() => jest.advanceTimersByTime(400));
  expect(counted).not.toHaveBeenCalledWith("deck_pictures_late");
  unmount(root);
});
