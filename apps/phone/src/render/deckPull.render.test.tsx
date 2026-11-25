import { Platform, StyleSheet } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle, runOnUI } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { DECK_PULL, pullPagePose, pullShrink } from "../lib/deckPull";
import { deckGeometry, deckLeading } from "../lib/deckGeometry";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { framesUntil, landOpeningPage, layOutDeckControls, renderSurface, unmount, withTabs } from "../../test/render/harness";

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
const { currentPhoneGeneration } = require("../state/browse/deckTurn") as typeof import("../state/browse/deckTurn");
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

const onIos = Platform.OS === "android" ? test.skip : test;

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
  act(() => jest.advanceTimersByTime(1500));
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
  layOutDeckControls(root);
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
  expect(target.pull).toBeGreaterThan(target.reach * 1.5);
  const arc = deckGeometry(SCREEN.width, SCREEN.height, 40, 24, 0, Platform.OS, "redesigned", deckHeaderBottom(), 55, "arc");
  expect(Math.abs(target.centerX - (deckLeading(arc, 0) + arc.cardWidth / 2))).toBeLessThan(2);
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
  expect(deck.props.jestAnimatedProps?.value?.pointerEvents ?? deck.props.pointerEvents).toBe("auto");
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

const landingFrames = (root: Root, tapAfter: number | null) => {
  const button = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onPress === "function")[0]!;
  act(() => void button.props.onPress());
  let frames = 0;
  while (surface() !== "deck" && frames < 120) {
    frame();
    frames += 1;
    if (frames === tapAfter) {
      const hit = deckPull.hit.value!;
      const point = { absoluteX: deckLeading(hit.g, -1) + 4, absoluteY: hit.g.cardCenterY, x: 0, y: 0 };
      act(() => fireGestureHandler(getByGestureTestId("landingTap"), [{ state: State.BEGAN, ...point }, { state: State.ACTIVE, ...point }, { state: State.END, ...point }]));
    }
  }
  return frames;
};

test("a tap on a card while the deck is still landing is taken at once: the landing hurries to its end without a jump, the tapped card opens as it lands, the open is counted, and the hurried landing's first callback never acts", () => {
  const root = app();
  const plain = landingFrames(root, null);
  act(() => browse.openTab(currentTabs().selectedId!));
  for (let at = 0; at < 60; at++) frame();
  unmount(mounted.pop()!);
  const again = app();
  const leaving = currentTabs().selectedId!;
  const neighbour = currentTabs().open[currentTabs().open.findIndex((tab) => tab.id === leaving) - 1]!.id;
  counted.mockClear();
  let last = -1;
  const jumps: number[] = [];
  const watch = setInterval(() => {
    const now = deckPull.shrink.value;
    if (last >= 0 && deckPull.stage.value === PULL_STAGE.landing) jumps.push(Math.abs(now - last));
    last = now;
  }, 16);
  const hurried = landingFrames(again, 2);
  clearInterval(watch);
  expect(hurried).toBeLessThan(plain);
  expect(Math.max(...jumps)).toBeLessThan(0.35);
  expect(counted).toHaveBeenCalledWith("deck_opens_while_landing");
  framesUntil(() => browse.useBrowse.getState().surface === "browsing" && currentTabs().selectedId === neighbour, 240);
  expect(currentTabs().selectedId).toBe(neighbour);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
});

test("once the page in front goes quiet its picture is made current, so a Tabs tap finds it current and copies nothing at the press; a picture still current isn't taken again", async () => {
  const id = currentTabs().selectedId!;
  act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  let taken = 0;
  jest.spyOn(pages, "snapshotIsCurrent").mockImplementation(() => taken > 0);
  const snapped = jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: `file:///snapshots/quiet-${++taken}.jpg`, width: 600, height: 1333 }) as never);
  const root = app();
  await promisesSettled();
  frame();
  await promisesSettled();
  expect(snapped).toHaveBeenCalledTimes(1);
  act(() => browse.keepFrontPictureCurrent());
  await promisesSettled();
  expect(snapped).toHaveBeenCalledTimes(1);
  const button = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onPress === "function")[0]!;
  act(() => void button.props.onPress());
  for (let at = 0; at < 4; at++) {
    frame();
    await promisesSettled();
  }
  expect(snapped).toHaveBeenCalledTimes(1);
  expect(counted).not.toHaveBeenCalledWith("deck_pictures_at_press");
});

test("on Android neither a Tabs tap nor a swipe copies the page while it moves, since drawing a moving page with a playing video dropped it for a frame; on iPhone a picture that isn't current is copied at the press", async () => {
  const id = currentTabs().selectedId!;
  act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  act(() => updateTabById(id, { snapshotFileName: "file:///snapshots/before-moving.jpg" }));
  jest.spyOn(browse, "keepFrontPictureCurrent").mockImplementation(() => undefined);
  const snapped = jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: "file:///snapshots/moving.jpg", width: 600, height: 1333 }) as never);
  const root = app();
  act(() => jest.advanceTimersByTime(1600));
  await promisesSettled();
  snapped.mockClear();
  const button = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onPress === "function")[0]!;
  act(() => void button.props.onPress());
  for (let at = 0; at < 240 && surface() !== "deck"; at++) {
    frame();
    await promisesSettled();
  }
  expect(surface()).toBe("deck");
  expect(snapped).toHaveBeenCalledTimes(Platform.OS === "android" ? 0 : 1);
  act(() => browse.openTab(id));
  for (let at = 0; at < 60; at++) frame();
  snapped.mockClear();
  swipe([{ dy: -22 }, { dy: -150 }]);
  for (let at = 0; at < 240 && surface() !== "deck"; at++) {
    frame();
    await promisesSettled();
  }
  if (Platform.OS === "android") expect(snapped).not.toHaveBeenCalled();
});

test("a picture timer already waiting when a Tabs tap or a swipe starts copies nothing while the page moves; on iPhone only the press copy runs", async () => {
  const id = currentTabs().selectedId!;
  const loaded = (isLoading: boolean) => act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading, isLive: true, canGoBack: false, canGoForward: false } as never));
  loaded(false);
  act(() => updateTabById(id, { snapshotFileName: "file:///snapshots/before-load.jpg" }));
  jest.spyOn(browse, "keepFrontPictureCurrent").mockImplementation(() => undefined);
  const snapped = jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: "file:///snapshots/after-load.jpg", width: 600, height: 1333 }) as never);
  const root = app();
  act(() => jest.advanceTimersByTime(1600));
  await promisesSettled();
  const button = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onPress === "function")[0]!;
  const settleThenMove = async (move: () => void) => {
    loaded(true);
    loaded(false);
    act(() => jest.advanceTimersByTime(600));
    await promisesSettled();
    snapped.mockClear();
    move();
    await promisesSettled();
    const atPress = snapped.mock.calls.length;
    expect(atPress).toBe(Platform.OS === "android" ? 0 : 1);
    for (let at = 0; at < 240 && surface() !== "deck"; at++) {
      frame();
      await promisesSettled();
    }
    expect(surface()).toBe("deck");
    expect(snapped.mock.calls.length).toBe(atPress);
  };
  await settleThenMove(() => act(() => void button.props.onPress()));
  act(() => browse.openTab(id));
  for (let at = 0; at < 100; at++) frame();
  await promisesSettled();
  await settleThenMove(() => swipe([{ dy: -22 }, { dy: -150 }]));
});

onIos("on iPhone the handover never waits for the fresh picture of the page: the capture starts with the pull, the deck takes over the frame after the landing, the page is gone with it, and the leaving card keeps its earlier picture under the fresh one until that has loaded", async () => {
  const EARLIER = "file:///snapshots/pulled-earlier.jpg";
  const FRESH = "file:///snapshots/pulled-fresh.jpg";
  const id = currentTabs().selectedId!;
  act(() => updateTabById(id, { snapshotFileName: EARLIER }));
  act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  jest.spyOn(browse, "keepFrontPictureCurrent").mockImplementation(() => undefined);
  const snapped = jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: FRESH, width: 600, height: 1333 }) as never);
  const root = app();
  act(() => pictureOf(root, EARLIER)!.props.onLoad(LOADED));
  frame();
  renders = [];
  swipe([{ dy: -22 }, { dy: -150 }]);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  frame();
  expect(snapped).toHaveBeenCalledTimes(1);
  expect(renders.filter((name) => name === "TabDeck" || name === "DeckCard")).toEqual([]);
  framesUntil(() => deckPull.stage.value !== PULL_STAGE.landing, 240);
  framesUntil(() => surface() === "deck", 2);
  expect(surface()).toBe("deck");
  frame();
  expect(pagesShown(root)).toHaveLength(0);
  const card = () => hosts(root, "deckCard").find((node) => node.findAll((inner) => inner.props.source?.uri === FRESH && typeof inner.type === "string").length > 0)!;
  expect(card()).toBeDefined();
  const sources = () => [...new Set(card().findAll((node) => typeof node.props.onLoad === "function" && typeof node.type !== "string").map((node) => node.props.source?.uri))];
  expect(sources()).toEqual([EARLIER, FRESH]);
  const fresh = card().findAll((node) => node.props.source?.uri === FRESH && typeof node.props.onLoad === "function" && typeof node.type !== "string")[0]!;
  act(() => fresh.props.onLoad({ nativeEvent: { source: { width: 600, height: 1333 } } }));
  frame();
  frame();
  expect(sources()).toEqual([FRESH]);
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

function deferUiWork() {
  const reanimated = require("react-native-reanimated") as typeof import("react-native-reanimated");
  const queued: (() => void)[] = [];
  const spy = jest.spyOn(reanimated, "runOnUI").mockImplementation(((work: (...args: unknown[]) => void) => (...args: unknown[]) => void queued.push(() => work(...args))) as never);
  return {
    queued,
    release: () => spy.mockRestore(),
    runOnUi: () => act(() => queued.splice(0).forEach((work) => work())),
  };
}

test("a pull ended on JS keeps the bar the page's: a bar-cleared report the page sent before that end is dropped when it reaches JS, and the end on the UI thread hands the bar back even after a report sent in between", () => {
  act(() => {
    deckPull.barCleared.value = true;
    pull.setDeckOwnsBar(true);
  });
  const sentBefore = deckPull.barTurn.value;
  const ui = deferUiWork();
  act(() => pull.endDeckPull());
  ui.release();
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  act(() => pull.reportDeckOwnsBar(true, sentBefore));
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  act(() => pull.reportDeckOwnsBar(true, deckPull.barTurn.value));
  expect(pull.usePullBar.getState().deckOwns).toBe(true);
  expect(ui.queued).toHaveLength(1);
  ui.runOnUi();
  frame();
  expect(deckPull.barCleared.value).toBe(false);
  expect(deckPull.barOwned.value).toBe(false);
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
});

test("a card that grows right after a pull ended keeps the bar: the old end's hand-back, reaching JS after the grow took the bar, never gives the bar back to the page mid-grow", () => {
  const target = { id: currentTabs().selectedId!, screenWidth: SCREEN.width, screenHeight: SCREEN.height, width: 160, height: 356, centerX: 100, centerY: 300, corner: 12, screenCorner: 40, reach: 500, pull: 400 };
  const ui = deferUiWork();
  act(() => pull.endDeckPull());
  act(() => void pull.growDeckPull(target, jest.fn(), jest.fn()));
  ui.release();
  expect(pull.usePullBar.getState().deckOwns).toBe(true);
  expect(ui.queued).toHaveLength(2);
  ui.runOnUi();
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.growing);
  expect(deckPull.barOwned.value).toBe(true);
  expect(pull.usePullBar.getState().deckOwns).toBe(true);
});

const onAndroid = Platform.OS === "android" ? test : test.skip;

const PULL_SETTLE_STARTED_MS = 100;
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
    expect(settled).toHaveBeenCalledWith(id, lands, expect.any(Number), "", 0, expect.any(Number));
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
  jest.spyOn(browse, "keepFrontPictureCurrent").mockImplementation(() => undefined);
  const id = currentTabs().selectedId!;
  act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  return { id, snapped: jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: FRESH, width: 600, height: 1333 }) as never) };
}

async function deckTakesOver(root: Root) {
  framesUntil(() => surface() === "deck", 3);
  expect(surface()).toBe("deck");
  frame();
  expect(pagesShown(root)).toHaveLength(0);
  expect(covered(root)).toHaveLength(0);
  await promisesSettled();
  frame();
  if (Platform.OS !== "android") expect(pictureOf(root, FRESH)).toBeDefined();
}

test("with Reduce Motion nothing tracks the finger and nothing waits: over a card whose picture is already painted the swipe starts the cross-fade within two frames, the page fades where it is, and when the fade ends the deck takes over with the card showing its picture", async () => {
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
  act(() => jest.advanceTimersByTime(DECK_PULL.fadeMs / 2 + 16));
  expect(target.width).toBeGreaterThan(0);
  await deckTakesOver(root);
  expect(snapped).toHaveBeenCalledTimes(Platform.OS === "android" ? 0 : 1);
  expect(counted).toHaveBeenCalledWith("deck_bar_swipes");
});

test("with Reduce Motion and with normal motion the waiting deck takes each new picture of the page in front as it lands, so the next request fades over it or lands on a card that already holds it, never on the face or a picture that failed to load", async () => {
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
    expect(pictureOf(root, uri)).toBeDefined();
    expect(renders.includes("TabDeck")).toBe(true);
    mounted.splice(mounted.indexOf(root), 1);
    unmount(root);
    act(() => updateTabById(id, { snapshotFileName: null }));
  }
});

test("with Reduce Motion and no picture in the card there is no fade and still no wait: within a few frames of the tap the deck takes over in a cut, the card draws the fresh picture as it arrives, and a card that never had a picture isn't counted late", async () => {
  const { snapped } = reducedMotionPage();
  const root = app();
  expect(moved(host(root, "tabDeck")!).translateX).toBe(AWAY);
  act(() => void browse.showDeck());
  frame();
  expect(deckPull.stage.value).not.toBe(PULL_STAGE.fading);
  await deckTakesOver(root);
  expect(moved(host(root, "tabDeck")!).translateX).toBe(0);
  expect(hosts(root, "deckCard").length).toBeGreaterThan(1);
  expect(snapped).toHaveBeenCalledTimes(Platform.OS === "android" ? 0 : 1);
  expect(counted).not.toHaveBeenCalledWith("deck_pictures_late");
});

test("the tab view's bar is never seen without its glyphs: when the page lands too low for the deck to have taken the bar, the deck's glyphs are in place from the frame the page is handed over, before the surface changes", () => {
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  reducedMotionPage();
  const root = app();
  act(() => pull.publishDeckStandby({ ...deckPull.target.value!, reach: 8 }));
  frame();
  expect(pull.usePullBar.getState().deckOwns).toBe(false);
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([0, 0, 0]);
  act(() => void browse.showDeck());
  for (let frames = 0; frames < 6 && surface() !== "deck"; frames++) {
    frame();
    if (deckPull.stage.value === PULL_STAGE.handed) expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([1, 1, 1]);
  }
  expect(surface()).toBe("deck");
  expect(DECK_GLYPHS.map((glyphs) => opacity(host(root, glyphs)!))).toEqual([1, 1, 1]);
  expect(deckPull.barCleared.value).toBe(false);
});

test("a second request for the tabs while the page lands is ignored: one landing finishes, the old entrance never starts over it, and the deck takes over once", async () => {
  const id = currentTabs().selectedId!;
  act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: FRESH, width: 600, height: 1333 }) as never);
  const root = app();
  const landing = jest.spyOn(pull, "landDeckPullFromRest");
  act(() => void browse.showDeck());
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.landing);
  act(() => void browse.showDeck());
  frame();
  expect(surface()).toBe("browsing");
  expect(browse.useBrowse.getState().deckEntrance).toBeNull();
  expect(deckPull.stage.value).toBe(PULL_STAGE.landing);
  framesUntil(() => surface() === "deck", 20);
  expect(surface()).toBe("deck");
  expect(browse.useBrowse.getState().deckEntrance).toBeNull();
  expect(landing.mock.calls.length).toBeLessThanOrEqual(1);
  expect(root).toBeDefined();
});

test("a Tabs tap right after a card opened, while its bar is still coming back, ends that open's grow and lands the page in its card, never a cut over an empty deck", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  mounted.push(root);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let landed = false;
  for (let frames = 0; frames < 40 && surface() !== "browsing"; frames++) {
    frame();
    if (!landed && browse.useBrowse.getState().opening !== null) landed = landOpeningPage(root);
  }
  expect(surface()).toBe("browsing");
  expect(pull.deckPullGrowing()).not.toBeNull();
  act(() => void browse.showDeck());
  frame();
  frame();
  expect(pull.deckPullGrowing()).toBeNull();
  expect(deckPull.stage.value).toBe(PULL_STAGE.landing);
  expect(surface()).toBe("browsing");
  framesUntil(() => surface() === "deck", 20);
  expect(surface()).toBe("deck");
  expect(browse.useBrowse.getState().deckEntrance).toBeNull();
});

test("two card taps that land before React commits open only the first: its grow owns the animation, the second is dropped, and the first card's page takes over as its growth lands", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  mounted.push(root);
  const cards = root.root.findAll((node) => (node.type as { name?: string; type?: { name?: string } })?.type?.name === "DeckCard" || (node.type as { name?: string })?.name === "DeckCard");
  const first = cards[cards.length - 1]!;
  const second = cards[0]!;
  expect(first.props.tab.id).not.toBe(second.props.tab.id);
  act(() => {
    first.props.onOpen(first.props.index);
    second.props.onOpen(second.props.index);
  });
  let landed = false;
  let frames = 0;
  for (; frames < 40 && surface() !== "browsing"; frames++) {
    frame();
    if (!landed && browse.useBrowse.getState().opening !== null) landed = landOpeningPage(root);
  }
  expect(surface()).toBe("browsing");
  expect(currentTabs().selectedId).toBe(first.props.tab.id);
  expect(frames * 16).toBeLessThan(DECK_PULL.growLostMs);
});

test("in Grid, two tile taps before React commits open only the first, though a Grid open is immediate and sets no grow", () => {
  withTabs(3);
  act(() => deckGrid.setDeckGrid(true));
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  mounted.push(root);
  const grid = root.root.findAll((node) => (node.type as { name?: string })?.name === "TabGrid")[0]!;
  const [first, second] = currentTabs().open;
  act(() => {
    grid.props.onOpen(first!.id);
    grid.props.onOpen(second!.id);
  });
  for (let at = 0; at < 10; at++) frame();
  expect(surface()).toBe("browsing");
  expect(currentTabs().selectedId).toBe(first!.id);
});

test("a fast flick lands without overshooting the card, even with the finger's tracking spring still moving when it is let go", () => {
  const root = app();
  const id = currentTabs().selectedId!;
  const settled = jest.fn();
  act(() => runOnUI((tab: string) => {
    "worklet";
    pull.beginDeckPull(tab, 0);
  })(id));
  for (let step = 1; step <= 6; step++) {
    act(() => runOnUI((at: number) => {
      "worklet";
      pull.trackDeckPull(at);
    })(-44 * step));
    frame();
  }
  expect(deckPull.shrink.value).toBeLessThan(1);
  act(() => runOnUI((tab: string) => {
    "worklet";
    pull.releaseDeckPull(tab, -6000, true, () => undefined, settled);
  })(id));
  let most = 0;
  for (let step = 0; step < 40; step++) {
    frame();
    most = Math.max(most, deckPull.shrink.value);
  }
  expect(most).toBeLessThanOrEqual(1.002);
  expect(root).toBeDefined();
});

test("a Tabs tap while a long-held pull springs back is still ignored: the pull counts as in flight from its release, not from when the finger came down", () => {
  app();
  const id = currentTabs().selectedId!;
  act(() => runOnUI((tab: string) => {
    "worklet";
    pull.beginDeckPull(tab, 0);
  })(id));
  act(() => browse.deckPullBegan(id));
  for (let step = 1; step <= 120; step++) {
    act(() => runOnUI((at: number) => {
      "worklet";
      pull.trackDeckPull(at);
    })(-Math.min(step, 40)));
    frame();
  }
  act(() => runOnUI((tab: string, settled: typeof browse.deckPullSettled) => {
    "worklet";
    pull.releaseDeckPull(tab, 0, false, () => undefined, settled);
  })(id, browse.deckPullSettled));
  act(() => browse.deckPullReleased(id, false));
  frame();
  expect(deckPull.stage.value).toBe(PULL_STAGE.returning);
  act(() => void browse.showDeck());
  frame();
  frame();
  expect(surface()).toBe("browsing");
  expect(browse.useBrowse.getState().deckEntrance).toBeNull();
  framesUntil(() => deckPull.stage.value === PULL_STAGE.idle, 60);
  expect(surface()).toBe("browsing");
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

test("a request for the tabs that finds no deck waiting for its page never waits for one: it is dropped when another tab comes in front, and with the same page still in front the old entrance starts on the next frame", () => {
  const first = currentTabs().selectedId!;
  const other = currentTabs().open.find((tab) => tab.id !== first)!.id;
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  mounted.push(root);
  expect(pull.deckStandbyId()).toBeNull();
  act(() => {
    void browse.showDeck();
    selectTabById(other);
  });
  frame();
  frame();
  expect(surface()).toBe("browsing");
  expect(currentTabs().selectedId).toBe(other);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  const never = jest.spyOn(pull, "whenDeckStandby").mockImplementation((_id, then) => {
    const next = requestAnimationFrame(() => then(false));
    return () => cancelAnimationFrame(next);
  });
  act(() => void browse.showDeck());
  expect(never).toHaveBeenCalledTimes(1);
  frame();
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
  act(() => browse.deckPullSettled(id, false, DECK_PULL.hitchMs, "", 0, currentPhoneGeneration()));
  expect(counted).not.toHaveBeenCalledWith("deck_pulls_hitched");
  act(() => browse.deckPullSettled(id, false, DECK_PULL.hitchMs + 1, "", 0, currentPhoneGeneration()));
  expect(counted).toHaveBeenCalledWith("deck_pulls_hitched");
  counted.mockClear();
  act(() => useTabs.setState({ incognito: true }));
  act(() => browse.deckPullSettled(id, false, 200, "", 0, currentPhoneGeneration()));
  expect(counted).not.toHaveBeenCalledWith("deck_pulls_hitched");
  expect(root).toBeDefined();
});
