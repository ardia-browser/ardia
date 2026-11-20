import { Platform, StyleSheet } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle, runOnUI } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { DECK_PULL, pullPagePose, pullShrink } from "../lib/deckPull";
import { forgetPicturePainted, notePicturePainted, pictureKey } from "../lib/shownSnapshots";
import { framesUntil, landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false };

jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const { Surfaces } = require("../App") as typeof import("../App");
const { tabsMotion } = require("../components/ui") as typeof import("../components/ui");
const { pages } = require("../platform/pages") as typeof import("../platform/pages");
const system = require("../platform/system") as typeof import("../platform/system");
const perf = require("../state/app/interactionPerf") as typeof import("../state/app/interactionPerf");
const pull = require("../state/browse/deckPull") as typeof import("../state/browse/deckPull");
const { runDeckPullScript, DECK_PULL_SCRIPT } = require("../state/browse/deckPullScript") as typeof import("../state/browse/deckPullScript");
const { sendDeckCommand } = require("../state/browse/deckCommands") as typeof import("../state/browse/deckCommands");
const deckGrid = require("../state/browse/deckGrid") as typeof import("../state/browse/deckGrid");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const { setRootSize } = require("../state/app/rootSize") as typeof import("../state/app/rootSize");
const { resizeRoot } = require("../state/browse/deckHold") as typeof import("../state/browse/deckHold");
const { writePreference } = require("../state/store/browserDatabase") as typeof import("../state/store/browserDatabase");
const { browserDatabase } = require("../state/store/database") as typeof import("../state/store/database");
const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
const { currentTabs, selectTabById, updateTabById, useTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

const { deckPull, PULL_STAGE } = pull;


const SCREEN = { width: 393, height: 873 };
const AWAY = 100_000;

const mounted: ReturnType<typeof renderSurface>[] = [];

let counted: jest.SpyInstance;
let renders: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  mockMotion.reduced = false;
  withTabs(5);
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  act(() => setRootSize(SCREEN.width, SCREEN.height));
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, leaving: null });
  renders = [];
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(perf, "countRender").mockImplementation((component: string) => {
    renders.push(component);
  });
  jest.spyOn(system, "prefetchImage").mockImplementation(async () => true);
  jest.spyOn(pages, "close").mockImplementation(async () => undefined);
});

afterEach(() => {
  for (const root of mounted.splice(0)) unmount(root);
  act(() => pull.endDeckPull());
  act(() => jest.runOnlyPendingTimers());
  act(() => jest.advanceTimersByTime(DECK_PULL.captureCapMs + DECK_PULL.paintCapMs + DECK_PULL.paintDeadlineMs + 100));
  act(() => pull.endDeckPull());
  act(() => setRootSize(0, 0));
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, null);
  act(() => deckGrid.forgetDeckGrid());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0] ?? null;
const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const pagesShown = (root: Root) => root.root.findAll((node) => (node.type as { name?: string })?.name === "BrowsingScreen");
const moved = (node: ReactTestInstance) => {
  const transform = (getAnimatedStyle(node).transform ?? []) as Record<string, number>[];
  return Object.assign({}, ...transform) as { translateX?: number; translateY?: number; scale?: number };
};
const opacity = (node: ReactTestInstance) => (getAnimatedStyle(node).opacity as number | undefined) ?? 1;
const frame = () => act(() => jest.advanceTimersByTime(16));
const caughtUp = () => act(() => jest.advanceTimersByTime(320));
const promisesSettled = () =>
  act(async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  });
const travelFor = (target: { reach: number; pull: number }, rise: number) => (rise * target.pull) / target.reach;
const surface = () => browse.useBrowse.getState().surface;

function app() {
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  mounted.push(root);
  act(() => jest.advanceTimersByTime(tabsMotion.deckStandby + 50));
  frame();
  return root;
}

type Step = { dy: number; velocityY?: number };

function swipe(steps: Step[], finish: State = State.END) {
  const last = steps[steps.length - 1]!;
  act(() =>
    fireGestureHandler(getByGestureTestId("barSwipeUp"), [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      ...steps.map((step) => ({ state: State.ACTIVE, translationX: 0, translationY: step.dy, velocityX: 0, velocityY: step.velocityY ?? -300 })),
      { state: finish, translationX: 0, translationY: last.dy, velocityX: 0, velocityY: last.velocityY ?? -300 },
    ]),
  );
  frame();
}

const order = (root: Root) =>
  root.root.findAll((node) => typeof node.type === "string" && (node.props.testID === "tabDeck" || node.props.testID === "pageBar")).map((node) => node.props.testID as string);

test("a Duo opened or closed while the deck waits hidden republishes the pull target at the new size, so the next swipe shrinks the page into a card of the current screen", () => {
  app();
  const before = deckPull.target.value!;
  expect(before.screenWidth).toBe(SCREEN.width);
  act(() => resizeRoot(951, 669));
  frame();
  const after = deckPull.target.value!;
  expect(after.id).toBe(before.id);
  expect(after.screenWidth).toBe(951);
  expect(after.screenHeight).toBe(669);
  expect(after.width).not.toBe(before.width);
});

test("on both phones the deck waits under the page, laid out and parked off screen rather than undrawn, so a swipe can show it without a layout pass", () => {
  const root = app();
  const deck = host(root, "tabDeck")!;
  expect(order(root)).toEqual(["tabDeck", "pageBar"]);
  expect(StyleSheet.flatten(deck.props.style).display).toBeUndefined();
  expect(StyleSheet.flatten(deck.props.style).opacity).toBeUndefined();
  expect(moved(deck).translateX).toBe(AWAY);
  expect(deck.props.pointerEvents).toBe("none");
  expect(deck.props.accessibilityElementsHidden).toBe(true);
  expect(host(root, "pageLayer")).not.toBeNull();
  expect(host(root, "pagePull")).not.toBeNull();
  expect(deckPull.target.value?.id).toBe(currentTabs().selectedId);
});

test("the page follows the finger with no React render: every move sets where the live page is heading, it eases there over a few frames instead of jumping, its bottom edge rising with the finger's travel and its frame heading for its own card's, over the deck's backdrop alone", () => {
  const root = app();
  const id = currentTabs().selectedId!;
  const target = deckPull.target.value!;
  renders = [];
  act(() => void expect(pull.beginDeckPull(id, -22)).toBe(true));
  expect(target.pull).toBeGreaterThan(target.reach * 2);
  expect(Math.abs(target.centerX - SCREEN.width / 2)).toBeLessThan(2);
  expect(target.centerX - target.width / 2).toBeGreaterThan(0);
  expect(target.centerX + target.width / 2).toBeLessThan(SCREEN.width);
  let last = 1;
  for (const travel of [6, 18, 40, 64, 90, 180, target.pull]) {
    act(() => pull.trackDeckPull(-22 - travel));
    frame();
    const pose = pullPagePose(target, pullShrink(travel, target.pull));
    const soon = moved(host(root, "pagePull")!).scale ?? 1;
    expect(soon).toBeLessThan(last);
    expect(soon).toBeGreaterThan(pose.scale);
    caughtUp();
    const page = moved(host(root, "pagePull")!);
    expect(page.scale).toBeCloseTo(pose.scale, 4);
    expect(page.translateX).toBeCloseTo(pose.x - SCREEN.width / 2, 3);
    const bottom = SCREEN.height / 2 + (page.translateY ?? 0) + (SCREEN.height * (page.scale ?? 1)) / 2;
    expect(bottom).toBeCloseTo(SCREEN.height - (travel * target.reach) / target.pull, 2);
    last = page.scale ?? 1;
  }
  expect(last * SCREEN.width).toBeCloseTo(target.width, 2);
  expect(renders).toEqual([]);
  expect(surface()).toBe("browsing");
  expect(moved(host(root, "tabDeck")!).translateX).toBe(0);
  expect(opacity(host(root, "deckCards")!)).toBe(1);
  const tucked = hosts(root, "deckCard").filter((card) => opacity(card) === 1);
  expect(hosts(root, "deckCard").filter((card) => opacity(card) === 0)).toHaveLength(1);
  expect(tucked.length).toBeGreaterThan(0);
  for (const card of tucked) expect(moved(card).scale).toBeCloseTo(DECK_PULL.tuckScale, 5);
  expect(new Set(tucked.map((card) => moved(card).translateX)).size).toBe(1);
  expect(moved(host(root, "pagePullBlocker")!).translateX).toBe(0);
  act(() => pull.resetDeckPull());
  frame();
  expect(moved(host(root, "tabDeck")!).translateX).toBe(AWAY);
  expect(moved(host(root, "pagePullBlocker")!).translateX).toBe(AWAY);
});

test("let go past the commit point, the page lands in its own card and only then does the deck take over: the page stays mounted through the landing, the swipe is counted, and the card it lands on is the selected one", () => {
  const root = app();
  const id = currentTabs().selectedId!;
  const before = new Set(hosts(root, "deckCard"));
  swipe([{ dy: -22 }, { dy: -60 }, { dy: -150 }]);
  expect(surface()).toBe("browsing");
  expect(pagesShown(root)).toHaveLength(1);
  expect(deckPull.stage.value).toBe(PULL_STAGE.landing);
  expect(counted).toHaveBeenCalledWith("deck_bar_swipes");
  expect(counted).not.toHaveBeenCalledWith("deck_bar_swipes_returned");
  framesUntil(() => surface() === "deck", 240);
  expect(surface()).toBe("deck");
  frame();
  frame();
  expect(pagesShown(root)).toHaveLength(0);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  const deck = host(root, "tabDeck")!;
  expect(moved(deck).translateX).toBe(0);
  expect(deck.props.pointerEvents).toBe("auto");
  expect(opacity(host(root, "deckCards")!)).toBe(1);
  expect(hosts(root, "deckCard").every((card) => before.has(card))).toBe(true);
  expect(hosts(root, "deckCard").every((card) => opacity(card) === 1)).toBe(true);
  expect(currentTabs().selectedId).toBe(id);
  expect(browse.useBrowse.getState().leaving).toBeNull();
  expect(browse.useBrowse.getState().deckEntrance).toBeNull();
});

test("let go early, or dragged back down, the page grows back and nothing on the browsing surface has changed: the same screen, no render, the deck parked again, and the swipe counted as returned", () => {
  for (const steps of [[{ dy: -22 }, { dy: -70, velocityY: 0 }], [{ dy: -22 }, { dy: -190 }, { dy: -170, velocityY: 420 }]] as Step[][]) {
    const root = app();
    const screen = pagesShown(root)[0]!;
    counted.mockClear();
    renders = [];
    swipe(steps);
    expect([PULL_STAGE.returning, PULL_STAGE.idle]).toContain(deckPull.stage.value);
    framesUntil(() => deckPull.stage.value === PULL_STAGE.idle, 240);
    frame();
    expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
    expect(surface()).toBe("browsing");
    expect(pagesShown(root)[0]).toBe(screen);
    expect(renders.filter((name) => name === "BrowsingScreen" || name === "PageCover" || name === "TabDeck" || name === "DeckCard")).toEqual([]);
    const page = moved(host(root, "pagePull")!);
    expect(page.scale).toBe(1);
    expect(page.translateY).toBe(0);
    expect(opacity(host(root, "pagePull")!)).toBe(1);
    expect(moved(host(root, "tabDeck")!).translateX).toBe(AWAY);
    expect(counted).toHaveBeenCalledWith("deck_bar_swipes_returned");
    expect(counted).not.toHaveBeenCalledWith("deck_bar_swipes");
    unmount(mounted.pop()!);
  }
});

test("a cancelled long swipe returns, and an accepted long swipe with no finite release velocity still lands", () => {
  app();
  swipe([{ dy: -22 }, { dy: -170, velocityY: 0 }], State.CANCELLED);
  framesUntil(() => deckPull.stage.value === PULL_STAGE.idle, 240);
  expect(surface()).toBe("browsing");
  swipe([{ dy: -22 }, { dy: -170, velocityY: Number.NaN }]);
  framesUntil(() => surface() === "deck", 240);
  expect(surface()).toBe("deck");
});

test("a swipe in Incognito follows the finger too, and neither its landing nor its return is counted", () => {
  act(() => useTabs.setState({ incognito: true }));
  const root = app();
  swipe([{ dy: -22 }, { dy: -60, velocityY: 0 }]);
  framesUntil(() => deckPull.stage.value === PULL_STAGE.idle, 240);
  swipe([{ dy: -22 }, { dy: -150 }]);
  framesUntil(() => surface() === "deck", 240);
  expect(surface()).toBe("deck");
  expect(counted).not.toHaveBeenCalledWith("deck_bar_swipes");
  expect(counted).not.toHaveBeenCalledWith("deck_bar_swipes_returned");
});

test("a tap on the tabs button ends in the same landing as a released swipe, starting from rest, and isn't counted as a swipe", () => {
  const root = app();
  const button = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onPress === "function")[0]!;
  act(() => void button.props.onPress());
  frame();
  expect(surface()).toBe("browsing");
  expect(deckPull.stage.value).toBe(PULL_STAGE.landing);
  expect(deckPull.shrink.value).toBeLessThan(0.5);
  framesUntil(() => surface() === "deck", 240);
  expect(surface()).toBe("deck");
  expect(counted).not.toHaveBeenCalledWith("deck_bar_swipes");
});

test("the handover waits for the fresh picture of the page: the capture starts with the pull, the waiting deck takes the new picture only once the landing has ended so its render can't stall the pull, and the deck takes over once it has painted in the card", async () => {
  const FRESH = "file:///snapshots/pulled-fresh.jpg";
  const id = currentTabs().selectedId!;
  act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  const snapped = jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: FRESH, width: 600, height: 1333 }) as never);
  const root = app();
  renders = [];
  swipe([{ dy: -22 }, { dy: -150 }]);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  frame();
  expect(snapped).toHaveBeenCalledTimes(1);
  const picture = () => host(root, "deckCards")!.findAll((node) => node.props.source?.uri === FRESH && typeof node.props.onLoad === "function" && typeof node.type !== "string")[0];
  expect(picture()).toBeUndefined();
  expect(renders.filter((name) => name === "TabDeck" || name === "DeckCard")).toEqual([]);
  framesUntil(() => deckPull.stage.value === PULL_STAGE.landed, 240);
  await act(async () => {
    jest.advanceTimersByTime(16);
    await Promise.resolve();
    await Promise.resolve();
  });
  frame();
  expect(picture()).toBeDefined();
  expect(surface()).toBe("browsing");
  expect(pagesShown(root)).toHaveLength(1);
  act(() => picture()!.props.onLoad({ nativeEvent: { source: { width: 600, height: 1333 } } }));
  framesUntil(() => surface() === "deck", 12);
  expect(surface()).toBe("deck");
});

const BROWSING_GLASS = ["floatingBarTabs", "floatingBarAddress", "floatingBarPlus"];
const DECK_GLASS = ["deckBarIncognito", "deckSearchTabs", "deckBarPlus"];
const DECK_GLYPHS = ["deckBarIncognitoGlyph", "deckSearchTabsContent", "deckBarPlusGlyph"];

test("the bar is one bar throughout: its three glass shapes stay while the browsing glyphs cross-fade into the tab view's on them, the deck's bar takes the glass over in one commit once the page's bottom edge has cleared it, and gives it back if the finger comes down again", () => {
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  const root = app();
  const id = currentTabs().selectedId!;
  const target = deckPull.target.value!;
  const glass = (ids: string[]) => root.root.findAll((node) => node.type === lookModule.Glass && ids.includes(node.props.testID)).map((node) => [node.props.shown !== false, node.props.shownMs]);
  const shown = (ids: string[]) => glass(ids).map(([on]) => on);
  expect(hosts(root, "pullGhost")).toHaveLength(3);
  expect(hosts(root, "pullGhost").map(opacity)).toEqual([0, 0, 0]);
  expect(shown(BROWSING_GLASS)).toEqual([true, true, true]);
  expect(shown(DECK_GLASS)).toEqual([false, false, false]);
  act(() => void pull.beginDeckPull(id, 0));
  act(() => pull.trackDeckPull(-travelFor(target, 40)));
  caughtUp();
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  for (const glyphs of hosts(root, "pullGlyphs")) {
    expect(opacity(glyphs)).toBeGreaterThan(0);
    expect(opacity(glyphs)).toBeLessThan(1);
  }
  for (const ghost of hosts(root, "pullGhost")) {
    expect(opacity(ghost)).toBeGreaterThan(0);
    expect(opacity(ghost)).toBeLessThan(1);
  }
  act(() => pull.trackDeckPull(-travelFor(target, DECK_PULL.ghostsWholeAt + 1)));
  caughtUp();
  expect(hosts(root, "pullGlyphs").map(opacity)).toEqual(hosts(root, "pullGlyphs").map(() => 0));
  expect(hosts(root, "pullGhost").map(opacity)).toEqual([1, 1, 1]);
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  expect(shown(BROWSING_GLASS)).toEqual([true, true, true]);
  expect(shown(DECK_GLASS)).toEqual([false, false, false]);
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([0, 0, 0]);
  act(() => pull.trackDeckPull(-travelFor(target, Math.min(target.reach, 100))));
  caughtUp();
  frame();
  expect(pull.usePullBar.getState().deckOwns).toBe(true);
  expect(glass(BROWSING_GLASS)).toEqual([[false, 0], [false, 0], [false, 0]]);
  expect(glass(DECK_GLASS)).toEqual([[true, 0], [true, 0], [true, 0]]);
  expect(hosts(root, "pullGhost")).toHaveLength(0);
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([1, 1, 1]);
  act(() => pull.trackDeckPull(-travelFor(target, 30)));
  caughtUp();
  frame();
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  expect(glass(BROWSING_GLASS)).toEqual([[true, 0], [true, 0], [true, 0]]);
  expect(shown(DECK_GLASS)).toEqual([false, false, false]);
  expect(hosts(root, "pullGhost")).toHaveLength(3);
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([0, 0, 0]);
  act(() => pull.resetDeckPull());
  frame();
});

const onAndroid = Platform.OS === "android" ? test : test.skip;

const PULL_SETTLE_STARTED_MS = 150;
const PULL_SETTLE_CAP_MS = 1000;

for (const lands of [true, false]) {
  test(`a deck pull ${lands ? "lands" : "returns"} on the iPhone's springs after release on both phones`, () => {
    app();
    const id = currentTabs().selectedId!;
    const settled = jest.fn();
    act(() => {
      pull.beginDeckPull(id, 0);
      pull.trackDeckPull(-150);
    });
    caughtUp();
    act(() => pull.settleDeckPull(lands, -300, settled));
    frame();
    act(() => void jest.advanceTimersByTime(PULL_SETTLE_STARTED_MS));
    expect(settled).not.toHaveBeenCalled();
    act(() => void jest.advanceTimersByTime(PULL_SETTLE_CAP_MS));
    expect(settled).toHaveBeenCalledWith(id, lands, expect.any(Number));
  });
}

const barCenterFromTop = (root: Root, testID: string) => {
  let at: ReactTestInstance | null = host(root, testID);
  let y = 0;
  let bottom: number | undefined;
  let top: number | undefined;
  while (at) {
    if (typeof at.type === "string") {
      y += moved(at).translateY ?? 0;
      const flat = StyleSheet.flatten(at.props.style) ?? {};
      if (top === undefined && bottom === undefined && (typeof flat.top === "number" || typeof flat.bottom === "number")) {
        top = typeof flat.top === "number" ? flat.top : undefined;
        bottom = typeof flat.bottom === "number" ? flat.bottom : undefined;
      }
    }
    at = at.parent;
  }
  return (top !== undefined ? top : SCREEN.height - bottom! - 48) + 24 + y;
};

onAndroid("on Android, whose bar has no glass to hand over, the page's bar stays the one bar from the first move to the swap: it never moves, never empties, takes the tab view's glyphs as the page lands and holds them until the deck's identical bar replaces it in place, with no React hand-over mid-landing", () => {
  const root = app();
  const id = currentTabs().selectedId!;
  const pageBar = barCenterFromTop(root, "floatingBar");
  expect(barCenterFromTop(root, "deckBottomBar")).toBe(pageBar);
  const owned: boolean[] = [];
  const watch = pull.usePullBar.subscribe((state) => owned.push(state.deckOwns));
  swipe([{ dy: -22 }, { dy: -60 }, { dy: -150 }]);
  let frames = 0;
  while (surface() !== "deck" && frames < 240) {
    expect(barCenterFromTop(root, "floatingBar")).toBe(pageBar);
    expect(hosts(root, "pullGhost")).toHaveLength(3);
    if (deckPull.stage.value === PULL_STAGE.landed || deckPull.stage.value === PULL_STAGE.handed) {
      expect(hosts(root, "pullGhost").map(opacity)).toEqual([1, 1, 1]);
      expect(hosts(root, "pullGlyphs").every((glyphs) => opacity(glyphs) === 0)).toBe(true);
    }
    frame();
    frames += 1;
  }
  watch();
  expect(surface()).toBe("deck");
  expect(owned).not.toContain(true);
  expect(barCenterFromTop(root, "deckBottomBar")).toBe(pageBar);
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([1, 1, 1]);
  expect(currentTabs().selectedId).toBe(id);
});

const CACHED = "file:///snapshots/cached.jpg";
const FRESH = "file:///snapshots/fresh.jpg";
const LOADED = { nativeEvent: { source: { width: 600, height: 1333 } } };
const pictureOf = (root: Root, uri: string) => host(root, "deckCards")!.findAll((node) => node.props.source?.uri === uri && typeof node.props.onLoad === "function" && typeof node.type !== "string")[0];
const covered = (root: Root) => hosts(root, "deckCard").filter((card) => opacity(card) === 0);

function reducedMotionPage() {
  mockMotion.reduced = true;
  const id = currentTabs().selectedId!;
  act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  return { id, snapped: jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: FRESH, width: 600, height: 1333 }) as never) };
}

async function freshPictureTakesOver(root: Root) {
  expect(surface()).toBe("browsing");
  expect(pictureOf(root, FRESH)).toBeUndefined();
  await promisesSettled();
  frame();
  expect(pictureOf(root, FRESH)).toBeDefined();
  expect(surface()).toBe("browsing");
  act(() => pictureOf(root, FRESH)!.props.onLoad(LOADED));
  framesUntil(() => surface() === "deck", 12);
  expect(surface()).toBe("deck");
}

test("with Reduce Motion nothing tracks the finger and nothing waits: over a card whose picture is already painted the swipe starts the cross-fade within two frames, the page fades where it is, and when the fade ends the live page stands in its own card until its fresh picture has painted under it", async () => {
  const { id, snapped } = reducedMotionPage();
  act(() => updateTabById(id, { snapshotFileName: CACHED }));
  const root = app();
  act(() => pictureOf(root, CACHED)!.props.onLoad(LOADED));
  frame();
  const target = deckPull.target.value!;
  expect(pull.deckPullFades()).toBe(true);
  swipe([{ dy: -22 }, { dy: -150 }]);
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.fading);
  expect(deckPull.reveal.value).toBe(1);
  expect(moved(host(root, "tabDeck")!).translateX).toBe(0);
  expect(opacity(host(root, "deckCards")!)).toBe(1);
  expect(covered(root)).toHaveLength(0);
  act(() => jest.advanceTimersByTime(DECK_PULL.fadeMs / 2));
  const fading = host(root, "pagePull")!;
  expect(opacity(fading)).toBeGreaterThan(0);
  expect(opacity(fading)).toBeLessThan(1);
  expect(moved(fading).scale).toBe(1);
  expect(moved(fading).translateY).toBe(0);
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  for (const ghost of hosts(root, "pullGhost")) {
    expect(opacity(ghost)).toBeGreaterThan(0);
    expect(opacity(ghost)).toBeLessThan(1);
  }
  act(() => jest.advanceTimersByTime(DECK_PULL.fadeMs / 2 + 32));
  expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
  const standing = host(root, "pagePull")!;
  expect(opacity(standing)).toBe(1);
  expect((moved(standing).scale ?? 1) * SCREEN.width).toBeCloseTo(target.width, 2);
  expect(covered(root)).toHaveLength(1);
  await freshPictureTakesOver(root);
  expect(snapped).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("deck_bar_swipes");
});

test("with Reduce Motion the waiting deck takes each new picture of the page in front as it lands, so the next request can fade over it; with normal motion it doesn't re-render for one", async () => {
  for (const reduced of [true, false]) {
    mockMotion.reduced = reduced;
    const id = currentTabs().selectedId!;
    act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
    const uri = `file:///snapshots/landed-${reduced}.jpg`;
    jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri, width: 600, height: 1333 }) as never);
    const root = app();
    expect(pull.deckPullFades()).toBe(reduced);
    renders = [];
    await act(async () => {
      await browse.captureSnapshot(id);
    });
    frame();
    expect(currentTabs().open.find((tab) => tab.id === id)!.snapshotFileName).toBe(uri);
    expect(pictureOf(root, uri) !== undefined).toBe(reduced);
    expect(renders.includes("TabDeck")).toBe(reduced);
    mounted.splice(mounted.indexOf(root), 1);
    unmount(root);
    act(() => updateTabById(id, { snapshotFileName: null }));
  }
});

test("with Reduce Motion and no painted picture in the card there is no fade and still no wait: within two frames of the tap the live page stands in its own card with the tabs around it, a cut as before the swipe followed the finger, and the card is never seen empty", async () => {
  const { snapped } = reducedMotionPage();
  const root = app();
  const target = deckPull.target.value!;
  expect(moved(host(root, "tabDeck")!).translateX).toBe(AWAY);
  act(() => void browse.showDeck());
  frame();
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
  const standing = host(root, "pagePull")!;
  expect(opacity(standing)).toBe(1);
  expect((moved(standing).scale ?? 1) * SCREEN.width).toBeCloseTo(target.width, 2);
  expect(moved(host(root, "tabDeck")!).translateX).toBe(0);
  expect(covered(root)).toHaveLength(1);
  expect(hosts(root, "deckCard").length).toBeGreaterThan(1);
  await freshPictureTakesOver(root);
  expect(snapped).toHaveBeenCalledTimes(1);
});

test("the tab view's bar is never seen without its glyphs: when the page lands too low for the deck to have taken the bar, the deck's glyphs are in place from the frame the page is handed over, before the surface changes", () => {
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  reducedMotionPage();
  const root = app();
  act(() => pull.publishDeckStandby({ ...deckPull.target.value!, reach: 8 }));
  frame();
  act(() => void browse.showDeck());
  frame();
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  expect(deckPull.barCleared.value).toBe(false);
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([0, 0, 0]);
  act(() => runOnUI(pull.handOverDeckPull)());
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.handed);
  expect(surface()).toBe("browsing");
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([1, 1, 1]);
});

const landed = () => {
  frame();
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
};

test("a second request for the tabs while the landed page waits for its picture is ignored: the first one finishes and the old entrance never starts over it", async () => {
  reducedMotionPage();
  const root = app();
  act(() => void browse.showDeck());
  landed();
  act(() => void browse.showDeck());
  frame();
  frame();
  expect(surface()).toBe("browsing");
  expect(browse.useBrowse.getState().deckEntrance).toBeNull();
  expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
  await freshPictureTakesOver(root);
});

test("a pull's wait for its picture gives up only its own capture: one begun for another tab meanwhile is still held when the first pull hands over", async () => {
  const { snapped } = reducedMotionPage();
  const other = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!.id;
  act(() => browse.pageStateChanged(other, { url: "https://site1.example/", title: "Site 1", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  const root = app();
  act(() => void browse.showDeck());
  landed();
  await promisesSettled();
  frame();
  expect(pictureOf(root, FRESH)).toBeDefined();
  snapped.mockImplementation(() => new Promise(() => undefined));
  act(() => browse.deckPullBegan(other, false));
  act(() => pictureOf(root, FRESH)!.props.onLoad(LOADED));
  framesUntil(() => surface() === "deck", 12);
  expect(surface()).toBe("deck");
  expect(browse.deckPullInFlight()).toBe(true);
  act(() => browse.deckPullSettled(other, false));
  expect(browse.deckPullInFlight()).toBe(false);
});

test("a pull whose picture arrives after a card has really begun to open stands down without ending that open: the card is growing on the UI thread before the stale wait is answered and still is after", async () => {
  reducedMotionPage();
  const root = app();
  act(() => void browse.showDeck());
  landed();
  await promisesSettled();
  frame();
  expect(pictureOf(root, FRESH)).toBeDefined();
  act(() => pull.endDeckPull());
  act(() => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, leaving: null }));
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  frame();
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.growing);
  const opening = pull.deckPullGrowing();
  expect(opening).not.toBeNull();
  const picture = pictureOf(root, FRESH);
  expect(picture).toBeDefined();
  act(() => picture!.props.onLoad(LOADED));
  frame();
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.growing);
  expect(pull.deckPullGrowing()).toBe(opening);
  expect(surface()).toBe("deck");
});

test("the waits for a late picture share one deadline: a first picture that never paints and a replacement that never paints either still hand the page over about a second after the wait began, counted once", async () => {
  const OLD = "file:///snapshots/older.jpg";
  const { id, snapped } = reducedMotionPage();
  const captures: ((snapshot: unknown) => void)[] = [];
  snapped.mockImplementation(() => new Promise((resolve) => captures.push(resolve)) as never);
  act(() => updateTabById(id, { snapshotFileName: OLD }));
  const root = app();
  act(() => void browse.showDeck());
  landed();
  await promisesSettled();
  expect(captures.length).toBeGreaterThan(0);
  act(() => jest.advanceTimersByTime(DECK_PULL.captureCapMs));
  const began = Date.now();
  expect(pictureOf(root, OLD)).toBeDefined();
  act(() => jest.advanceTimersByTime(100));
  await act(async () => {
    captures.forEach((captured) => captured({ uri: FRESH, width: 600, height: 1333 }));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  });
  act(() => jest.advanceTimersByTime(began + DECK_PULL.paintDeadlineMs - 120 - Date.now()));
  expect(pictureOf(root, FRESH)).toBeDefined();
  expect(surface()).toBe("browsing");
  expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
  expect(counted).not.toHaveBeenCalledWith("deck_pictures_late");
  act(() => jest.advanceTimersByTime(began + DECK_PULL.paintDeadlineMs + 60 - Date.now()));
  expect(surface()).toBe("deck");
  expect(counted.mock.calls.filter(([name]) => name === "deck_pictures_late")).toHaveLength(1);
});

test("a replacement picture that has painted by the deadline is not counted late, even when the wait that ran out was for the picture it replaced", async () => {
  const OLD = "file:///snapshots/older.jpg";
  const { id, snapped } = reducedMotionPage();
  const captures: ((snapshot: unknown) => void)[] = [];
  snapped.mockImplementation(() => new Promise((resolve) => captures.push(resolve)) as never);
  act(() => updateTabById(id, { snapshotFileName: OLD }));
  app();
  act(() => void browse.showDeck());
  landed();
  await promisesSettled();
  act(() => jest.advanceTimersByTime(DECK_PULL.captureCapMs));
  const began = Date.now();
  act(() => jest.advanceTimersByTime(DECK_PULL.paintDeadlineMs - 150));
  expect(surface()).toBe("browsing");
  await act(async () => {
    captures.forEach((captured) => captured({ uri: FRESH, width: 600, height: 1333 }));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  });
  const replacement = pictureKey(`deck:${id}`, FRESH);
  act(() => notePicturePainted(replacement));
  expect(surface()).toBe("browsing");
  act(() => jest.advanceTimersByTime(began + DECK_PULL.paintDeadlineMs + 60 - Date.now()));
  forgetPicturePainted(replacement);
  expect(surface()).toBe("deck");
  expect(counted).not.toHaveBeenCalledWith("deck_pictures_late");
});

test("with Reduce Motion an overtaken card open is cleared when what overtook it left it recorded: a page opened from a link while the page fades in stays in front, and no opening is left behind", () => {
  mockMotion.reduced = true;
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  mounted.push(root);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  framesUntil(() => browse.useBrowse.getState().opening !== null, 14);
  const opened = browse.useBrowse.getState().opening!;
  expect(landOpeningPage(root)).toBe(true);
  framesUntil(() => deckPull.pageLive.value, 4);
  act(() => browse.openPage("https://example.org/from-a-link", "link"));
  const linked = currentTabs().selectedId;
  expect(linked).not.toBe(opened);
  expect(browse.useBrowse.getState().opening).toBe(opened);
  act(() => jest.advanceTimersByTime(DECK_PULL.barBackMs + DECK_PULL.barBackCapMs + 100));
  expect(currentTabs().selectedId).toBe(linked);
  expect(surface()).toBe("browsing");
  expect(browse.useBrowse.getState().opening).toBeNull();
  expect(pull.deckPullGrowing()).toBeNull();
});

test("with Reduce Motion a card open that has been overtaken doesn't come back: when another tab is put in front while the page fades in, the fade's end clears the open and leaves that tab selected and in front", () => {
  mockMotion.reduced = true;
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  mounted.push(root);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  framesUntil(() => browse.useBrowse.getState().opening !== null, 14);
  const opened = browse.useBrowse.getState().opening!;
  expect(landOpeningPage(root)).toBe(true);
  framesUntil(() => deckPull.pageLive.value, 4);
  expect(deckPull.pageLive.value).toBe(true);
  expect(surface()).toBe("deck");
  const other = currentTabs().open.find((tab) => tab.id !== opened)!.id;
  act(() => browse.openTab(other));
  expect(currentTabs().selectedId).toBe(other);
  expect(surface()).toBe("browsing");
  act(() => jest.advanceTimersByTime(DECK_PULL.barBackMs + DECK_PULL.barBackCapMs + 100));
  expect(currentTabs().selectedId).toBe(other);
  expect(surface()).toBe("browsing");
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  expect(pull.deckPullGrowing()).toBeNull();
});

test("with normal motion an overtaken card open doesn't come back either: another tab put in front while the card grows, before its page is made, stays selected and in front", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  mounted.push(root);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  frame();
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.growing);
  const opened = pull.deckPullGrowing()!;
  const other = currentTabs().open.find((tab) => tab.id !== opened)!.id;
  act(() => browse.openTab(other));
  expect(surface()).toBe("browsing");
  act(() => jest.advanceTimersByTime(2000));
  expect(currentTabs().selectedId).toBe(other);
  expect(surface()).toBe("browsing");
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
});

test("the deck takes over only when the picture that is current at the handover has painted: a newer one that lands while an older one is awaited is drawn and awaited instead", async () => {
  const OLD = "file:///snapshots/older.jpg";
  const { id, snapped } = reducedMotionPage();
  const captures: ((snapshot: unknown) => void)[] = [];
  snapped.mockImplementation(() => new Promise((resolve) => captures.push(resolve)) as never);
  act(() => updateTabById(id, { snapshotFileName: OLD }));
  const root = app();
  act(() => void browse.showDeck());
  landed();
  await promisesSettled();
  expect(captures.length).toBeGreaterThan(0);
  act(() => jest.advanceTimersByTime(DECK_PULL.captureCapMs + 16));
  expect(pictureOf(root, OLD)).toBeDefined();
  expect(surface()).toBe("browsing");
  await act(async () => {
    captures.forEach((captured) => captured({ uri: FRESH, width: 600, height: 1333 }));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  });
  expect(currentTabs().open.find((tab) => tab.id === id)!.snapshotFileName).toBe(FRESH);
  act(() => pictureOf(root, OLD)!.props.onLoad(LOADED));
  frame();
  frame();
  frame();
  expect(surface()).toBe("browsing");
  expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
  expect(pictureOf(root, FRESH)).toBeDefined();
  act(() => pictureOf(root, FRESH)!.props.onLoad(LOADED));
  framesUntil(() => surface() === "deck", 12);
  expect(surface()).toBe("deck");
});

test("a picture that hasn't painted when the paint cap runs out doesn't uncover an empty card: the live page keeps standing in the card for the longer cap, the deck takes over the moment the picture paints, and only if it never does is the page handed over and the late picture counted", async () => {
  for (const paints of [true, false]) {
    reducedMotionPage();
    const root = app();
    act(() => void browse.showDeck());
    landed();
    await promisesSettled();
    frame();
    expect(pictureOf(root, FRESH)).toBeDefined();
    act(() => jest.advanceTimersByTime(DECK_PULL.paintCapMs + 100));
    expect(surface()).toBe("browsing");
    expect(deckPull.stage.value).toBe(PULL_STAGE.landed);
    expect(opacity(host(root, "pagePull")!)).toBe(1);
    expect(counted).not.toHaveBeenCalledWith("deck_pictures_late");
    if (paints) act(() => pictureOf(root, FRESH)!.props.onLoad(LOADED));
    else act(() => jest.advanceTimersByTime(DECK_PULL.paintDeadlineMs));
    framesUntil(() => surface() === "deck", 12);
    expect(surface()).toBe("deck");
    expect(counted.mock.calls.filter(([name]) => name === "deck_pictures_late")).toHaveLength(paints ? 0 : 1);
    mounted.splice(mounted.indexOf(root), 1);
    unmount(root);
    act(() => pull.endDeckPull());
    act(() => jest.runOnlyPendingTimers());
    counted.mockClear();
    withTabs(5);
    browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, leaving: null });
  }
});

test("a request for the tabs that is still waiting for the deck is dropped when another tab comes in front, not answered over that tab; with the same page still in front it falls back to the old entrance", () => {
  const first = currentTabs().selectedId!;
  const other = currentTabs().open.find((tab) => tab.id !== first)!.id;
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  mounted.push(root);
  expect(pull.deckStandbyId()).toBeNull();
  act(() => {
    void browse.showDeck();
    selectTabById(other);
  });
  act(() => jest.advanceTimersByTime(DECK_PULL.standbyCapMs + 100));
  expect(surface()).toBe("browsing");
  expect(currentTabs().selectedId).toBe(other);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  const never = jest.spyOn(pull, "whenDeckStandby").mockImplementation((_id, then) => {
    const cap = setTimeout(() => then(false), DECK_PULL.standbyCapMs);
    return () => clearTimeout(cap);
  });
  act(() => void browse.showDeck());
  expect(never).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(DECK_PULL.standbyCapMs - 50));
  expect(surface()).toBe("browsing");
  act(() => jest.advanceTimersByTime(100));
  expect(surface()).toBe("deck");
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  expect(pull.peekDeckPullEntrance()).toBeNull();
});

test("with Reduce Motion a card opens as a cross-fade too: the deck holds still, can't be dragged and stays the surface, the page is made under it unseen, and once it is laid out it fades in over the cards and the deck lets go when the fade has ended", () => {
  mockMotion.reduced = true;
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  mounted.push(root);
  const placed = () => hosts(root, "deckCard").map((card) => ({ ...moved(card), opacity: opacity(card) }));
  const before = placed();
  expect(before.length).toBeGreaterThan(1);
  type Detected = { toGestureArray?: () => { config: { testId?: string; enabled?: boolean } }[] };
  const deckPanEnabled = () =>
    root.root
      .findAll((node) => typeof (node.props.gesture as Detected | undefined)?.toGestureArray === "function")
      .flatMap((node) => (node.props.gesture as Required<Detected>).toGestureArray())
      .filter((gesture) => gesture.config.testId === "deckPan")
      .map((gesture) => gesture.config.enabled !== false)
      .pop();
  expect(deckPanEnabled()).toBe(true);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  act(() => jest.advanceTimersByTime(32));
  expect(surface()).toBe("deck");
  expect(deckPull.stage.value).toBe(PULL_STAGE.growing);
  expect(deckPull.steady.value).toBe(true);
  expect(placed()).toEqual(before);
  framesUntil(() => browse.useBrowse.getState().opening !== null, 12);
  expect(surface()).toBe("deck");
  expect(opacity(host(root, "pagePull")!)).toBe(0);
  expect(placed()).toEqual(before);
  expect(deckPanEnabled()).toBe(false);
  const scrolls = root.root.findAll((node) => typeof node.props.onScrollAction === "function")[0]!;
  expect(scrolls.props.canScrollForward || scrolls.props.canScrollBackward).toBe(true);
  act(() => scrolls.props.onScrollAction(scrolls.props.canScrollBackward ? "backward" : "forward"));
  frame();
  frame();
  frame();
  expect(placed()).toEqual(before);
  expect(landOpeningPage(root)).toBe(true);
  framesUntil(() => deckPull.pageLive.value, 4);
  expect(deckPull.pageLive.value).toBe(true);
  act(() => jest.advanceTimersByTime(DECK_PULL.fadeMs / 2));
  const page = host(root, "pagePull")!;
  expect(opacity(page)).toBeGreaterThan(0);
  expect(opacity(page)).toBeLessThan(1);
  expect(moved(page).scale).toBe(1);
  expect(moved(page).translateY).toBe(0);
  expect(surface()).toBe("deck");
  expect(placed()).toEqual(before);
  framesUntil(() => deckPull.stage.value === PULL_STAGE.idle, 60);
  expect(surface()).toBe("browsing");
  expect(opacity(host(root, "pagePull")!)).toBe(1);
});

test("with Grid chosen the waiting deck holds the grid, the page's target is its own tile, and the swipe lands there", () => {
  writePreference(browserDatabase(), deckGrid.DECK_GRID_KEY, "true");
  act(() => deckGrid.forgetDeckGrid());
  const root = app();
  expect(hosts(root, "deckCard")).toHaveLength(0);
  const cells = hosts(root, "tabGridCell");
  expect(cells).toHaveLength(5);
  const viewport = host(root, "tabGridScroll")!;
  act(() => viewport.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: SCREEN.width, height: 700 } } }));
  act(() => viewport.props.onContentSizeChange(SCREEN.width, 1400));
  const width = StyleSheet.flatten(cells[0]!.props.style).width as number;
  cells.forEach((cell, index) => act(() => cell.props.onLayout({ nativeEvent: { layout: { x: 16 + (index % 2) * (width + 14), y: 14 + Math.floor(index / 2) * 440, width, height: 420 } } })));
  frame();
  const target = deckPull.target.value!;
  expect(target.id).toBe(currentTabs().selectedId);
  expect(target.width).toBeCloseTo(width, 5);
  expect(target.height).toBeCloseTo(width / (SCREEN.width / SCREEN.height), 3);
  swipe([{ dy: -22 }, { dy: -150 }]);
  expect(deckPull.stage.value).toBe(PULL_STAGE.landing);
  framesUntil(() => surface() === "deck", 240);
  expect(surface()).toBe("deck");
  expect(hosts(root, "tabGridCell")).toHaveLength(5);
});

test("the scripted pull replays a fixed finger path through the gesture's own worklets: each pull commits and reopens the same tab, the last is let go early, and the log gets a line for tracking, one for landing and a last line", async () => {
  const lines: string[] = [];
  perf.enableInteractionPerf(true, (line) => lines.push(line));
  const root = app();
  const id = currentTabs().selectedId!;
  let done = false;
  act(() => void runDeckPullScript(2, (line) => lines.push(line)).then(() => (done = true)));
  for (let step = 0; step < 4000 && !done; step++) {
    await act(async () => {
      jest.advanceTimersByTime(16);
      await Promise.resolve();
    });
  }
  perf.enableInteractionPerf(false, () => undefined);
  expect(done).toBe(true);
  expect(lines.filter((line) => line.includes("script"))).toEqual(["PAGELAB deck pull script: pull 1 of 2", "PAGELAB deck pull script: pull 2 of 2", "PAGELAB deck pull script: early release", "PAGELAB deck pull script done: 2 of 2 committed, 1 returned"]);
  expect(lines.filter((line) => line.startsWith("PAGELAB perf deck pull ") && !line.includes("landing") && !line.includes("return"))).toHaveLength(3);
  expect(lines.filter((line) => line.startsWith("PAGELAB perf deck pull landing "))).toHaveLength(2);
  expect(lines[lines.length - 1]).toBe("PAGELAB deck pull script done: 2 of 2 committed, 1 returned");
  expect(surface()).toBe("browsing");
  expect(currentTabs().selectedId).toBe(id);
  expect(currentTabs().open).toHaveLength(5);
  expect(DECK_PULL_SCRIPT.commits.ms).toBe(350);
}, 60_000);

test("the scripted pull only logs when no page is showing", async () => {
  browse.useBrowse.setState({ surface: "start" });
  const lines: string[] = [];
  let done = false;
  act(() => void runDeckPullScript(1, (line) => lines.push(line)).then(() => (done = true)));
  for (let step = 0; step < 4000 && !done; step++) {
    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });
  }
  expect(done).toBe(true);
  expect(lines).toEqual(["PAGELAB deck pull script done: 0 of 1 committed, 0 returned, no page was showing with the deck waiting"]);
  expect(surface()).toBe("start");
});

test("a pull whose frames stalled is counted once it settles, and not in Incognito; a pull at the display's pace isn't", () => {
  const root = app();
  const id = currentTabs().selectedId!;
  swipe([{ dy: -22 }, { dy: -60, velocityY: 0 }]);
  framesUntil(() => deckPull.stage.value === PULL_STAGE.idle, 240);
  frame();
  expect(counted).not.toHaveBeenCalledWith("deck_pulls_hitched");
  act(() => browse.deckPullSettled(id, false, DECK_PULL.hitchMs));
  expect(counted).not.toHaveBeenCalledWith("deck_pulls_hitched");
  act(() => browse.deckPullSettled(id, false, DECK_PULL.hitchMs + 1));
  expect(counted).toHaveBeenCalledWith("deck_pulls_hitched");
  counted.mockClear();
  act(() => useTabs.setState({ incognito: true }));
  act(() => browse.deckPullSettled(id, false, 200));
  expect(counted).not.toHaveBeenCalledWith("deck_pulls_hitched");
  expect(root).toBeDefined();
});
