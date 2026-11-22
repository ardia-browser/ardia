import { PixelRatio, Platform, StyleSheet } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { TabDeck } from "../components/tabs/TabDeck";
import { deviceGrid, gridGeometry } from "../components/tabs/ContainedDeck";
import type { DeckMotion } from "../components/tabs/DeckCard";
import { deckLeading, deckSlot, type DeckGeometry } from "../lib/deckGeometry";
import { NO_LAUNCH_ARGUMENTS, parseLaunchArguments } from "../lib/launchArguments";
import * as launchFlags from "../state/app/launchFlags";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { useArchiveCard } from "../state/browse/archiveCard";
import { setPreference } from "../state/settings/store";
import { pages } from "../platform/pages";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/lab", () => ({ ...jest.requireActual<object>("../platform/lab"), isLabBuild: true }));

const look = require("../platform/look") as typeof import("../platform/look");

const onAndroid = Platform.OS === "android" ? test : test.skip;
const oniPhone = Platform.OS === "ios" ? test : test.skip;

const RATIO = 2.75;
const TABS = 26;
const EXPANDED_Z = 100_000;
const SCREEN_WIDTH = 393;
const FRAME_MS = 16;

type Style = { opacity?: number; zIndex?: number; borderRadius?: number; transform?: Record<string, number>[] };

function flagged(on: boolean) {
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => (on ? parseLaunchArguments({ ArdiaOneContainerScroll: "1" }) : NO_LAUNCH_ARGUMENTS));
}

function steady() {
  jest.spyOn(PixelRatio, "get").mockReturnValue(RATIO);
  jest.spyOn(pages, "close").mockImplementation(async () => undefined as never);
  jest.spyOn(pages, "saveState").mockImplementation(async () => null as never);
}

beforeEach(() => {
  jest.useFakeTimers();
  steady();
  setPreference("archiveCardShown", true);
  useArchiveCard.setState({ showing: false });
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

const live = new Set<ReactTestRenderer>();

function done(root: ReactTestRenderer) {
  if (!live.delete(root)) return;
  unmount(root);
}

afterEach(() => {
  for (const root of [...live]) done(root);
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
  steady();
});

const hosts = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const styleOf = (node: ReactTestInstance): Style => (node.props.jestAnimatedStyle ? (getAnimatedStyle(node) as Style) : {});
const shift = (node: ReactTestInstance) => (styleOf(node).transform ?? []).reduce((sum, step) => sum + (step.translateX ?? 0), 0);
const frame = (count = 1) => {
  for (let i = 0; i < count; i++) act(() => jest.advanceTimersByTime(FRAME_MS));
};

function screenLeft(node: ReactTestInstance): number {
  let x = 0;
  for (let at: ReactTestInstance | null = node; at; at = at.parent) if (typeof at.type === "string") x += shift(at);
  return x;
}

type Card = { id: string; title: string; host: ReactTestInstance; reach: ReactTestInstance; header: ReactTestInstance };

const hostKids = (node: ReactTestInstance): ReactTestInstance[] => node.children.flatMap((child) => (typeof child === "string" ? [] : typeof child.type === "string" ? [child] : hostKids(child)));

const cardsOf = (root: ReactTestRenderer): Card[] =>
  root.root
    .findAll((node) => typeof node.type !== "string" && node.props.tab && node.props.motion && node.props.geometry)
    .filter((node, at, all) => all.findIndex((other) => other.props.tab.id === node.props.tab.id) === at)
    .map((node) => {
      const [host, reach, header] = hostKids(node) as [ReactTestInstance, ReactTestInstance, ReactTestInstance];
      return { id: node.props.tab.id as string, title: reach.props.accessibilityLabel as string, host, reach, header };
    });

const hostParent = (node: ReactTestInstance) => {
  let at = node.parent;
  while (at && typeof at.type !== "string") at = at.parent;
  return at!;
};

const motionOf = (root: ReactTestRenderer): DeckMotion => root.root.findAll((node) => typeof node.type !== "string" && node.props.motion?.scroll)[0]!.props.motion as DeckMotion;
const geometryOf = (root: ReactTestRenderer): DeckGeometry => root.root.findAll((node) => typeof node.type !== "string" && node.props.tab && node.props.geometry)[0]!.props.geometry as DeckGeometry;
const onGrid = (g: DeckGeometry) => gridGeometry(g, deviceGrid(g, RATIO));

function deck(on: boolean, tabs = TABS) {
  withTabs(tabs);
  flagged(on);
  const root = renderSurface(<TabDeck />);
  live.add(root);
  act(() => jest.advanceTimersByTime(400));
  return root;
}

function drag(root: ReactTestRenderer, cards: number, steps = 1) {
  const spacing = geometryOf(root).spacing;
  const from = 200;
  const dx = cards * spacing;
  const moves = Array.from({ length: steps }, (_, step) => ({ state: State.ACTIVE, x: from + (dx * (step + 1)) / steps, y: 400, absoluteX: from + (dx * (step + 1)) / steps, absoluteY: 400, translationX: (dx * (step + 1)) / steps, translationY: 0, velocityX: 0 }));
  act(() => fireGestureHandler(getByGestureTestId("deckPan"), [{ state: State.ACTIVE, x: from, y: 400, absoluteX: from, absoluteY: 400, translationX: 0, translationY: 0, velocityX: 0 }, ...moves]));
}

function scrollTo(root: ReactTestRenderer, target: number) {
  drag(root, motionOf(root).scroll.value - target);
  frame();
}

function staysOnRoundedTrueX(root: ReactTestRenderer, where: string) {
  const m = motionOf(root);
  const g = onGrid(geometryOf(root));
  const ids = m.orderIds.value;
  let checked = 0;
  for (const card of cardsOf(root)) {
    const index = ids.indexOf(card.id);
    if (index < 0 || m.phase.value !== 0 || m.dragIndex.value === index) continue;
    const slot = deckSlot(card.id, index, m.fromSlots.value, m.shiftBy.value, m.gap.value);
    const wanted = Math.round(deckLeading(g, slot - m.scroll.value) * RATIO);
    const shown = screenLeft(card.host) * RATIO;
    if (Math.abs(shown - wanted) > 1e-6) throw new Error(`${where}: card ${index} at scroll ${m.scroll.value.toFixed(4)} shows ${shown.toFixed(3)} px, rounded true x is ${wanted} px`);
    checked++;
  }
  return checked;
}

const animatedIn = (root: ReactTestRenderer) => [hosts(root, "deckScrollContainer")[0]!, ...hosts(root, "deckScrollContainer")[0]!.findAll((node) => typeof node.type === "string" && Boolean(node.props.jestAnimatedStyle))];
const shot = (nodes: ReactTestInstance[]) => nodes.map((node) => JSON.stringify(styleOf(node)));
function countRuns() {
  let runs = 0;
  type Fn = ((...args: unknown[]) => unknown) & { __closure?: unknown; __workletHash?: number; __initData?: unknown };
  const counted = (fn: Fn): Fn => {
    const wrapped = ((...args: unknown[]) => {
      runs++;
      return fn(...args);
    }) as Fn;
    wrapped.__closure = fn.__closure;
    return wrapped;
  };
  const style = Reanimated.useAnimatedStyle;
  const derived = Reanimated.useDerivedValue;
  const reaction = Reanimated.useAnimatedReaction;
  const mapper = Reanimated.startMapper;
  const inputs = (fn: Fn, deps?: unknown[]) => deps ?? Object.values((fn.__closure ?? {}) as object);
  jest.spyOn(Reanimated, "useAnimatedStyle").mockImplementation(((fn: Fn, deps?: unknown[]) => (style as (...args: unknown[]) => unknown)(counted(fn), inputs(fn, deps))) as never);
  jest.spyOn(Reanimated, "useDerivedValue").mockImplementation(((fn: Fn, deps?: unknown[]) => (derived as (...args: unknown[]) => unknown)(counted(fn), inputs(fn, deps))) as never);
  jest.spyOn(Reanimated, "useAnimatedReaction").mockImplementation(((prepare: Fn, react: Fn, deps?: unknown[]) => (reaction as (...args: unknown[]) => unknown)(counted(prepare), react, inputs(prepare, deps))) as never);
  jest.spyOn(Reanimated, "startMapper").mockImplementation(((fn: Fn, ...rest: unknown[]) => (mapper as (...args: unknown[]) => number)(counted(fn), ...rest)) as never);
  return { take: () => runs, reset: () => void (runs = 0) };
}

onAndroid("with ArdiaOneContainerScroll, every card's on-screen x is the rounded true x at many scroll positions, and on every frame of each settle after", () => {
  const root = deck(true);
  let frames = 0;
  for (const target of [23.6, 22.3, 21.37, 18, 15.5, 16.85, 19.1, 24.5, 25, 23.02]) {
    scrollTo(root, target);
    expect(staysOnRoundedTrueX(root, `at ${target}`)).toBeGreaterThanOrEqual(10);
    for (let settle = 0; settle < 60; settle++) {
      frame();
      staysOnRoundedTrueX(root, `settling from ${target}, frame ${settle}`);
      frames++;
    }
  }
  expect(frames).toBe(600);
  done(root);
});

onAndroid("with ArdiaOneContainerScroll, every on-screen card is within half a point of where the per-card deck puts it", () => {
  for (const target of [0.3, 7.5, 18, 25]) {
    const lefts: number[][] = [];
    for (const on of [false, true]) {
      const root = deck(on);
      expect(hosts(root, "deckScrollContainer")).toHaveLength(on ? 1 : 0);
      drag(root, 24 - target);
      lefts.push(hosts(root, "deckCard").map(screenLeft));
      done(root);
      jest.restoreAllMocks();
      steady();
    }
    const [plain, contained] = lefts as [number[], number[]];
    expect(contained.length).toBe(plain.length);
    for (let i = 0; i < plain.length; i++) if (plain[i]! < SCREEN_WIDTH) expect(Math.abs(contained[i]! - plain[i]!)).toBeLessThanOrEqual(0.5);
  }
});

function closeWatched(root: ReactTestRenderer, label: string) {
  const last = new Map<string, number>();
  let worst = 0;
  let flew = false;
  for (let f = 0; f < 90; f++) {
    frame();
    staysOnRoundedTrueX(root, `${label}, frame ${f}`);
    const flying = new Set(Object.keys(motionOf(root).leaving.value));
    if (flying.size) flew = true;
    for (const card of cardsOf(root)) {
      if (flying.has(card.id) || motionOf(root).orderIds.value.indexOf(card.id) < 0) continue;
      const x = screenLeft(card.host);
      const was = last.get(card.id);
      if (was !== undefined) worst = Math.max(worst, Math.abs(x - was));
      last.set(card.id, x);
    }
  }
  expect(flew).toBe(true);
  expect(hosts(root, "deckCard").every((card) => styleOf(card).opacity === 1)).toBe(true);
  return worst;
}

onAndroid("with ArdiaOneContainerScroll, closing the last card (the scroll moves back two) never shows the deck off by a spacing for a frame: the container and every card move together", () => {
  const root = deck(true, 9);
  scrollTo(root, 8);
  act(() => jest.advanceTimersByTime(2000));
  expect(motionOf(root).scroll.value).toBe(8);
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  const worst = closeWatched(root, "closing the last of 9");
  expect(motionOf(root).orderIds.value).toHaveLength(8);
  expect(worst).toBeLessThan(60);
  done(root);
});

onAndroid("with ArdiaOneContainerScroll, closing a card in the middle of 26 flies it away and slides the rest along without a jumped frame", () => {
  const root = deck(true);
  scrollTo(root, 20);
  act(() => jest.advanceTimersByTime(2000));
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  const worst = closeWatched(root, "closing card 20 of 26");
  expect(motionOf(root).orderIds.value).toHaveLength(25);
  expect(worst).toBeLessThan(60);
  done(root);
});


onAndroid("with ArdiaOneContainerScroll, between two close scroll positions the cards right of the focus, up to where the right pile begins, keep their place, and stacked cards, out of sight past the left edge, change only their card's x", () => {
  const root = deck(true);
  scrollTo(root, 22);
  const container = () => shift(hosts(root, "deckScrollContainer")[0]!);
  const before = new Map(cardsOf(root).map((card) => [card.id, { screen: screenLeft(card.host), reach: JSON.stringify(styleOf(card.reach)), header: JSON.stringify(styleOf(card.header)), own: shift(card.host) }]));
  const containerBefore = container();
  scrollTo(root, 22.3);
  const moved = container() - containerBefore;
  expect(Math.abs(moved)).toBeGreaterThan(25);
  const ids = motionOf(root).orderIds.value;
  let right = 0;
  let stacked = 0;
  for (const card of cardsOf(root)) {
    const was = before.get(card.id)!;
    const index = ids.indexOf(card.id);
    if (index - 22.3 >= 0 && index - 22 <= 1) {
      right++;
      expect(shift(card.host)).toBe(was.own);
    }
    if (index - 22 <= -6) {
      stacked++;
      expect(screenLeft(card.host)).toBeLessThan(0);
      expect(JSON.stringify(styleOf(card.header))).toBe(was.header);
      expect(JSON.stringify(styleOf(card.reach))).toBe(was.reach);
    }
  }
  expect(right).toBe(1);
  expect(stacked).toBeGreaterThanOrEqual(4);
  done(root);
});

onAndroid("with ArdiaOneContainerScroll, mid-scroll every position is on a device pixel and every opacity on a 1/255 step, and a scroll changes only transforms and opacities", () => {
  const root = deck(true);
  scrollTo(root, 21.37);
  const onPixel = (value: number) => Math.abs(value * RATIO - Math.round(value * RATIO)) < 1e-6;
  const onStep = (value: number) => Math.abs(value * 255 - Math.round(value * 255)) < 1e-6;
  const nodes = animatedIn(root);
  for (const node of nodes) {
    const style = styleOf(node);
    for (const step of style.transform ?? []) for (const [key, value] of Object.entries(step)) if (key.startsWith("translate")) expect(onPixel(value)).toBe(true);
    if (style.opacity !== undefined) expect(onStep(style.opacity)).toBe(true);
  }
  const before = nodes.map((node) => JSON.parse(JSON.stringify(styleOf(node))) as Record<string, unknown>);
  scrollTo(root, 20.6);
  const changed = new Set<string>();
  nodes.forEach((node, at) => {
    const now = styleOf(node) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(now), ...Object.keys(before[at]!)])) if (JSON.stringify(now[key]) !== JSON.stringify(before[at]![key])) changed.add(key);
  });
  expect([...changed].sort()).toEqual(["opacity", "transform"]);
  done(root);
});


function runsPerFrame(on: boolean, tabs: number) {
  const counter = countRuns();
  const root = deck(on, tabs);
  const start = tabs - 4;
  scrollTo(root, start);
  counter.reset();
  drag(root, 0.1, 1);
  frame();
  const one = counter.take();
  counter.reset();
  drag(root, 1, 11);
  frame();
  const eleven = counter.take();
  done(root);
  jest.restoreAllMocks();
  steady();
  return (eleven - one) / 10;
}

onAndroid("with ArdiaOneContainerScroll, a scroll frame runs well under the per-card deck's worklets at 26 tabs and at 9, the right pile's cards moving with the scroll", () => {
  const counts: string[] = [];
  for (const tabs of [26, 9]) {
    const plain = runsPerFrame(false, tabs);
    const contained = runsPerFrame(true, tabs);
    counts.push(`${tabs} tabs: ${plain} worklet runs a scroll frame per-card, ${contained} in one container`);
    expect(contained).toBeLessThan(plain / 1.8);
  }
  console.log(counts.join("; "));
});

onAndroid("with ArdiaOneContainerScroll, the screen reader finds every card, titled, in deck order, with nothing hiding it, a real width and the rightmost included, as it does without the flag", () => {
  const reachable = (root: ReactTestRenderer) => {
    const found: { title: string; left: number; width: number }[] = [];
    for (const node of root.root.findAll((inner) => typeof inner.type === "string" && inner.props.accessible === true && inner.props.accessibilityHint === "Opens the tab.")) {
      for (let at: ReactTestInstance | null = node.parent; at; at = at.parent) {
        expect(at.props.importantForAccessibility === "no-hide-descendants" && at.props.testID !== "tabDeck").toBe(false);
        if (at.props.testID !== "tabDeck") expect(at.props.accessibilityElementsHidden === true).toBe(false);
      }
      const steps = styleOf(node).transform ?? [];
      const scaleX = steps.find((step) => step.scaleX !== undefined)?.scaleX ?? 1;
      const width = (StyleSheet.flatten(node.props.style).width as number) * scaleX;
      found.push({ title: node.props.accessibilityLabel as string, left: screenLeft(node), width });
    }
    return found;
  };
  const read: { title: string; left: number; width: number }[][] = [];
  for (const on of [false, true]) {
    const root = deck(on, 6);
    read.push(reachable(root));
    const titles = cardsOf(root).map((card) => card.title);
    expect(read.at(-1)!.map((card) => card.title)).toEqual(titles);
    done(root);
  }
  const [plain, contained] = read as [typeof read[0], typeof read[0]];
  expect(contained.map((card) => card.title)).toEqual(plain.map((card) => card.title));
  expect(contained).toHaveLength(6);
  contained.forEach((card, at) => {
    expect(card.width).toBeGreaterThanOrEqual(1);
    expect(Math.abs(card.left - plain[at]!.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(card.width - plain[at]!.width)).toBeLessThanOrEqual(1);
    expect(card.left).toBeLessThan(SCREEN_WIDTH);
  });
});

onAndroid("with ArdiaOneContainerScroll, each card is the same three views as without the flag, side by side in one parent, with no wrapper views", () => {
  const layout: string[][] = [];
  for (const on of [false, true]) {
    const root = deck(on, 9);
    const parent = hostParent(cardsOf(root)[0]!.host);
    const kids = hostKids(parent);
    expect(kids).toHaveLength(cardsOf(root).length * 3);
    layout.push(kids.map((kid) => kid.props.testID ?? kid.props.accessibilityHint ?? "header"));
    done(root);
  }
  expect(layout[1]!.map((id) => (id === "deckCardReach" ? "Opens the tab." : id === "deckCardHeader" ? "header" : id))).toEqual(layout[0]);
});

onAndroid("with ArdiaOneContainerScroll, once a scroll has settled nothing more is computed or written, and the deck tells the look budget it is idle", () => {
  const idle: boolean[] = [];
  jest.spyOn(look, "useLookBudgetProbe").mockImplementation((value) => void idle.push(value));
  const counter = countRuns();
  const root = deck(true);
  expect(idle.at(-1)).toBe(true);
  scrollTo(root, 21.6);
  expect(idle.at(-1)).toBe(false);
  act(() => jest.advanceTimersByTime(3000));
  expect(idle.at(-1)).toBe(true);
  expect(motionOf(root).scroll.value).toBe(22);
  act(() => jest.advanceTimersByTime(1000));
  const before = shot(animatedIn(root));
  counter.reset();
  act(() => jest.advanceTimersByTime(2000));
  expect(counter.take()).toBe(0);
  expect(shot(animatedIn(root))).toEqual(before);
  done(root);
});

onAndroid("with ArdiaOneContainerScroll, a card still opens to full screen above the rest", () => {
  const root = deck(true);
  scrollTo(root, 23);
  act(() => jest.advanceTimersByTime(2000));
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let grown = 0;
  let raisedFrames = 0;
  for (let f = 0; f < 40 && useBrowse.getState().surface === "deck"; f++) {
    frame();
    const raised = hosts(root, "deckCard").filter((card) => (styleOf(card).zIndex ?? 0) >= EXPANDED_Z);
    if (!raised.length) continue;
    expect(raised).toHaveLength(1);
    raisedFrames++;
    const scale = (styleOf(raised[0]!).transform ?? []).find((step) => step.scale !== undefined)!.scale!;
    grown = Math.max(grown, scale * (StyleSheet.flatten(raised[0]!.props.style).width as number));
  }
  expect(raisedFrames).toBeGreaterThan(3);
  expect(grown).toBeCloseTo(SCREEN_WIDTH, 0);
  done(root);
});

onAndroid("without ArdiaOneContainerScroll, Android's deck has no container and each card moves itself", () => {
  const root = deck(false);
  expect(hosts(root, "deckScrollContainer")).toHaveLength(0);
  expect(hosts(root, "deckCardReach")).toHaveLength(0);
  done(root);
});

oniPhone("on iPhone, ArdiaOneContainerScroll changes nothing: no container, and every card moves itself as before", () => {
  const root = deck(true);
  expect(hosts(root, "deckScrollContainer")).toHaveLength(0);
  expect(hosts(root, "deckCardReach")).toHaveLength(0);
  expect(hosts(root, "deckCard").length).toBeGreaterThanOrEqual(10);
  done(root);
});
