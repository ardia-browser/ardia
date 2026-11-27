import { Profiler } from "react";
import { BackHandler, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { DesignProvider, tabsMotion } from "../components/ui";
import type { Design } from "../lib/design";
import { pages } from "../platform/pages";
import * as system from "../platform/system";
import * as perf from "../state/app/interactionPerf";
import { handleSystemBack } from "../state/page/actions";
import { deckPull, PULL_STAGE } from "../state/browse/deckPull";
import { openTab, pageStateChanged, showDeck, useBrowse } from "../state/browse/store";
import { registerPageHandle, storeNavigation, storeTone, type PageState } from "../state/pages/store";
import { presentSearch, dismissSearch } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { currentTabs, updateTabById, useTabs } from "../state/tabs/store";
import { framesUntil, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";
import { noteSnapshotLoaded, noteSnapshotShown } from "../lib/shownSnapshots";

const DESIGNS: Design[] = ["redesigned", "original"];
const FRESH = "file:///snapshots/leaving-fresh.jpg";
const EARLIER = "file:///snapshots/leaving-earlier.jpg";

let renders: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  dismissSearch();
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null });
  renders = [];
  jest.spyOn(perf, "countRender").mockImplementation((component: string) => {
    renders.push(component);
  });
  jest.spyOn(system, "prefetchImage").mockImplementation(async () => true);
  jest.spyOn(pages, "close").mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const app = (design: Design, onCommit: () => void = () => undefined) =>
  renderSurface(
    <Profiler id="app" onRender={onCommit}>
      <DesignProvider design={design}>
        <Surfaces />
      </DesignProvider>
    </Profiler>,
    { flushTimers: false },
  );

const deck = (root: Root) => root.root.findAll((node) => node.props.testID === "tabDeck" && typeof node.type === "string")[0] ?? null;
const deckCards = (root: Root) => root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");
const cardsLayer = (root: Root) => root.root.findAll((node) => node.props.testID === "deckCards" && typeof node.type === "string")[0]!;
const opacity = (node: ReactTestInstance) => (getAnimatedStyle(node).opacity as number | undefined) ?? 1;
const page = (root: Root) => root.root.findAll((node) => (node.type as { name?: string })?.name === "BrowsingScreen");
const count = (component: string) => renders.filter((name) => name === component).length;
const settle = () => act(() => jest.advanceTimersByTime(tabsMotion.deckStandby + 50));

const loading = (progress: number) => ({ url: "https://slow.example/", title: "Slow", isLive: true, isLoading: true, progress, failure: null, canGoBack: false, canGoForward: false }) as unknown as PageState;

const pulls = (design: Design) => design === "redesigned";
const PARKED = 100_000;
const parkedAt = (node: ReactTestInstance) => ((getAnimatedStyle(node).transform ?? []) as { translateX?: number }[]).find((move) => move.translateX !== undefined)?.translateX;

async function openFromPage(design: Design) {
  await act(async () => {
    const opening = showDeck();
    jest.advanceTimersByTime(16);
    await opening;
  });
  if (pulls(design)) framesUntil(() => useBrowse.getState().surface === "deck", 240);
  expect(useBrowse.getState().surface).toBe("deck");
}

for (const design of DESIGNS) {
  test(`in the ${design} design, once a page has settled the deck waits mounted under it, not drawn, not touchable and hidden from screen readers`, () => {
    const root = app(design);
    act(() => jest.advanceTimersByTime(tabsMotion.deckStandby - 100));
    expect(deck(root)).toBeNull();
    settle();
    const hidden = deck(root)!;
    expect(hidden).not.toBeNull();
    if (pulls(design)) expect(parkedAt(hidden)).toBe(PARKED);
    else expect(StyleSheet.flatten(hidden.props.style).display).toBe("none");
    expect(hidden.props.pointerEvents).toBe("none");
    expect(hidden.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(hidden.props.accessibilityElementsHidden).toBe(true);
    expect(deckCards(root).length).toBeGreaterThanOrEqual(7);
    expect(page(root)).toHaveLength(1);
    unmount(root);
  });

  test(`in the ${design} design, the deck isn't mounted while the tray is up or a card is still opening, only after the page has been quiet for a moment`, () => {
    act(() => presentSearch("page", ""));
    const root = app(design);
    act(() => jest.advanceTimersByTime(2000));
    expect(deck(root)).toBeNull();
    act(() => dismissSearch());
    act(() => useBrowse.setState({ opening: currentTabs().selectedId }));
    act(() => jest.advanceTimersByTime(2000));
    expect(deck(root)).toBeNull();
    act(() => useBrowse.setState({ opening: null }));
    settle();
    expect(deck(root)).not.toBeNull();
    unmount(root);
  });

  test(`in the ${design} design, a Tabs tap shows the waiting deck without mounting a card and never waits for the fresh picture of the page just left: the deck takes taps as soon as its motion lands and the leaving card draws a picture, never the placeholder`, async () => {
    const selected = currentTabs().selectedId!;
    act(() => updateTabById(selected, { snapshotFileName: EARLIER }));
    noteSnapshotShown(EARLIER);
    noteSnapshotLoaded(EARLIER);
    act(() => pageStateChanged(selected, { url: "https://site0.example/", title: "Kernel Archives", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
    jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: FRESH, width: 600, height: 1157 }) as never);
    const root = app(design);
    settle();
    const before = new Set(deckCards(root));
    for (const image of cardsLayer(root).findAll((node) => node.props.source?.uri === EARLIER && typeof node.props.onLoad === "function" && typeof node.type !== "string")) act(() => image.props.onLoad({ nativeEvent: { source: { width: 600, height: 1157 } } }));
    renders = [];
    let frames = 0;
    await act(async () => {
      void showDeck();
      await Promise.resolve();
    });
    while (useBrowse.getState().surface !== "deck" && frames < 40) {
      await act(async () => {
        jest.advanceTimersByTime(16);
        await Promise.resolve();
      });
      frames += 1;
    }
    expect(useBrowse.getState().surface).toBe("deck");
    expect(frames).toBeLessThanOrEqual(pulls(design) ? 16 : 1);
    act(() => jest.advanceTimersByTime(16));
    expect(deck(root)!.props.jestAnimatedProps?.value?.pointerEvents ?? deck(root)!.props.pointerEvents).toBe("auto");
    act(() => jest.advanceTimersByTime(200));
    expect(opacity(cardsLayer(root))).toBe(1);
    expect(deckCards(root).every((card) => before.has(card))).toBe(true);
    const leaving = deckCards(root).find((card) => card.findAll((node) => (node.props.source?.uri === FRESH || node.props.source?.uri === EARLIER) && typeof node.type === "string").length > 0)!;
    expect(leaving).toBeDefined();
    expect(textOf({ root: leaving } as never)).not.toContain("Kernel Archives");
    framesUntil(() => useBrowse.getState().leaving === null, 40);
    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(page(root)).toHaveLength(0);
    expect(deckCards(root).find((card) => card.findAll((node) => node.props.source?.uri === FRESH && typeof node.type === "string").length > 0)).toBeDefined();
    expect(count("DeckCard")).toBeLessThanOrEqual(2);
    unmount(root);
  });
}

async function deckOpenRenders(premounted: boolean) {
  const root = app("redesigned");
  if (premounted) settle();
  renders = [];
  await openFromPage("redesigned");
  framesUntil(() => useBrowse.getState().leaving === null, 150);
  act(() => jest.advanceTimersByTime(32));
  const counted = { deck: count("TabDeck"), cards: count("DeckCard"), mounted: deckCards(root).length };
  unmount(root);
  return counted;
}

test("a deck opened from a page with the deck waiting renders no card at all, where mounting it on the tap renders every card, and TabDeck only updates twice: once to show, once when the shrink lands", async () => {
  setPreference("archiveCardShown", true);
  const cold = await deckOpenRenders(false);
  withTabs(9);
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null });
  const warm = await deckOpenRenders(true);
  expect(cold.mounted).toBe(9);
  expect(cold.cards).toBeGreaterThanOrEqual(cold.mounted);
  expect(warm.mounted).toBe(9);
  expect(warm.cards).toBe(0);
  expect(warm.deck).toBe(2);
});

for (const design of DESIGNS) {
  test(`in the ${design} design, the waiting deck commits nothing while the page reports its progress, and renders nothing for the page's tone or title until it is shown`, () => {
    const selected = currentTabs().selectedId!;
    act(() => storeNavigation(selected, loading(0.1)));
    let commits = 0;
    const root = app(design, () => (commits += 1));
    settle();
    expect(deck(root)).not.toBeNull();
    commits = 0;
    renders = [];
    for (let frame = 1; frame <= 30; frame++) {
      act(() => storeNavigation(selected, loading(Math.min(0.95, 0.1 + frame * 0.02))));
      act(() => jest.advanceTimersByTime(16));
    }
    expect(renders).toEqual([]);
    expect(commits).toBe(0);
    act(() => storeTone(selected, { top: "#203040", bottom: "#203040" }));
    act(() => updateTabById(selected, { title: "Slow Otters" }));
    expect(count("TabDeck")).toBe(0);
    expect(count("DeckCard")).toBe(0);
    act(() => void showDeck());
    act(() => jest.advanceTimersByTime(16));
    if (pulls(design)) framesUntil(() => useBrowse.getState().surface === "deck", 240);
    expect(textOf(root)).toContain("Slow Otters");
    unmount(root);
  });

  test(`in the ${design} design, Back with the deck waiting reaches the page, never the deck, and the waiting deck adds no Back listener`, () => {
    const listening = jest.spyOn(BackHandler, "addEventListener");
    const root = app(design);
    const selected = currentTabs().selectedId!;
    const before = listening.mock.calls.length;
    settle();
    expect(deck(root)).not.toBeNull();
    expect(listening.mock.calls.length).toBe(before);
    const goBack = jest.fn(async () => undefined);
    act(() => storeNavigation(selected, { ...loading(1), isLoading: false, canGoBack: true }));
    registerPageHandle(selected, { goBack } as never);
    let handled = false;
    act(() => void (handled = handleSystemBack()));
    expect(handled).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(useBrowse.getState().surface).toBe("browsing");
    act(() => storeNavigation(selected, { ...loading(1), isLoading: false, canGoBack: false }));
    act(() => void handleSystemBack());
    if (pulls(design)) framesUntil(() => useBrowse.getState().surface === "deck", 240);
    expect(useBrowse.getState().surface).toBe("deck");
    unmount(root);
  });
}

test("Search Tabs starts empty each time the deck is shown: the query and its filtered cards are gone once the deck hides", async () => {
  const root = app("redesigned");
  settle();
  await openFromPage("redesigned");
  framesUntil(() => useBrowse.getState().leaving === null, 150);
  const field = () => root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onChangeText === "function")[0]!;
  const all = deckCards(root).length;
  act(() => field().props.onChangeText("Site 3"));
  act(() => jest.advanceTimersByTime(400));
  expect(deckCards(root).length).toBe(1);
  act(() => openTab(currentTabs().selectedId!));
  act(() => jest.advanceTimersByTime(100));
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(deck(root)).not.toBeNull();
  expect(field().props.value).toBe("");
  settle();
  await openFromPage("redesigned");
  framesUntil(() => useBrowse.getState().leaving === null, 150);
  expect(field().props.value).toBe("");
  expect(deckCards(root).length).toBe(all);
  unmount(root);
});

test("after a card opens, the deck goes back to waiting hidden instead of unmounting, and the next open mounts no card", async () => {
  const root = app("original");
  settle();
  await openFromPage("original");
  framesUntil(() => useBrowse.getState().leaving === null, 150);
  const before = new Set(deckCards(root));
  const other = useTabs.getState().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  act(() => openTab(other.id));
  act(() => jest.advanceTimersByTime(100));
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(StyleSheet.flatten(deck(root)!.props.style).display).toBe("none");
  settle();
  await openFromPage("original");
  expect(deckCards(root).every((card) => before.has(card))).toBe(true);
  expect(useBrowse.getState().deckEntrance).toBeNull();
  framesUntil(() => useBrowse.getState().leaving === null, 150);
  expect(useBrowse.getState().leaving).toBeNull();
  unmount(root);
});
