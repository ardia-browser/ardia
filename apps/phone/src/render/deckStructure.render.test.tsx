import type { ReactTestInstance } from "react-test-renderer";
import * as Reanimated from "react-native-reanimated";
import { act } from "react-test-renderer";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { TabDeck } from "../components/tabs/TabDeck";
import { useBrowse } from "../state/browse/store";
import { useTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  useTabs.setState((state) => ({ ...state, open: state.open.map((tab, index) => ({ ...tab, snapshotFileName: `file:///snapshots/card-${index}.jpg` })) }));
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const hostsUnder = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && inner !== node);

function loadedDeck() {
  const root = renderSurface(<TabDeck />);
  const images = root.root.findAll((node) => typeof node.type === "string" && node.type === "Image" && typeof node.props.onLoad === "function");
  act(() => images.forEach((image) => image.props.onLoad({ nativeEvent: { source: { width: 600, height: 1300 } } })));
  act(() => jest.advanceTimersByTime(400));
  return root;
}

const cards = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");

test("once a card's picture has faded in, the placeholder face under it is gone: one image and no text left in each of nine cards", () => {
  const root = loadedDeck();
  expect(cards(root).length).toBeGreaterThanOrEqual(7);
  for (const card of cards(root)) {
    const inside = hostsUnder(card);
    expect(inside.filter((node) => node.type === "Image")).toHaveLength(1);
    expect(inside.filter((node) => node.type === "Text")).toHaveLength(0);
  }
  unmount(root);
});

const LAYOUT_KEYS = ["width", "height", "top", "left", "right", "bottom", "minWidth", "maxWidth", "minHeight", "maxHeight", "margin", "marginTop", "marginLeft", "padding", "paddingTop", "flex", "flexBasis", "aspectRatio"];

test("a deck scroll animates only transforms and opacity, so no animated style asks for a layout pass while nine cards move", () => {
  const animatedKeys = new Set<string>();
  const original = Reanimated.useAnimatedStyle;
  const recording = jest.spyOn(Reanimated, "useAnimatedStyle").mockImplementation(((updater: (() => Record<string, unknown>) & { __closure?: Record<string, unknown> | unknown[] }, deps?: unknown[]) =>
    (original as (...args: unknown[]) => unknown)(() => {
      const out = updater();
      for (const key of Object.keys(out ?? {})) animatedKeys.add(key);
      return out;
    }, deps ?? Object.values(updater.__closure ?? {}))) as never);
  const root = loadedDeck();
  act(() => sendDeckCommand({ kind: "scroll", index: 2 }));
  for (let frame = 0; frame < 30; frame++) act(() => jest.advanceTimersByTime(16));
  recording.mockRestore();
  expect(animatedKeys.has("transform")).toBe(true);
  expect([...animatedKeys].filter((key) => LAYOUT_KEYS.includes(key))).toEqual([]);
  unmount(root);
});

test("each card works out its position once per frame: one derived value per card computes the pose, and no animated style computes it again", () => {
  type Updater = { __initData?: { code: string } };
  const captured = (updater: Updater) => (/const[{[]([^}\]]*)[}\]]=this\.__closure/.exec(updater.__initData?.code ?? "")?.[1] ?? "").split(",").map((part) => part.split(":")[0]!.trim());
  const computes = (updater: Updater) => captured(updater).includes("cardPose");
  const derivedPoses: Updater[] = [];
  const stylePoses: Updater[] = [];
  const originalDerived = Reanimated.useDerivedValue;
  const originalStyle = Reanimated.useAnimatedStyle;
  const derived = jest.spyOn(Reanimated, "useDerivedValue").mockImplementation(((updater: Updater, ...rest: unknown[]) => {
    if (computes(updater)) derivedPoses.push(updater);
    return (originalDerived as (...args: unknown[]) => unknown)(updater, ...rest);
  }) as never);
  const styles = jest.spyOn(Reanimated, "useAnimatedStyle").mockImplementation(((updater: Updater, ...rest: unknown[]) => {
    if (computes(updater)) stylePoses.push(updater);
    return (originalStyle as (...args: unknown[]) => unknown)(updater, ...rest);
  }) as never);
  const root = renderSurface(<TabDeck />);
  derived.mockRestore();
  styles.mockRestore();
  const mounted = cards(root).length;
  expect(mounted).toBeGreaterThanOrEqual(7);
  expect(stylePoses).toHaveLength(0);
  expect(derivedPoses).toHaveLength(mounted);
  unmount(root);
});

test("each card casts one shadow, on the one view that moves and clips it, tinted as Compose's card layer (14 dp, black at 18%)", () => {
  const { Platform, StyleSheet } = require("react-native") as typeof import("react-native");
  const root = loadedDeck();
  const shadowed = (style: Record<string, unknown>) => Boolean(style.elevation || style.boxShadow || style.shadowOpacity);
  for (const card of cards(root)) {
    const own = StyleSheet.flatten(card.props.style) as Record<string, unknown>;
    expect(shadowed(own)).toBe(true);
    expect(own.overflow).toBe("hidden");
    if (Platform.OS === "android") expect(own).toMatchObject({ elevation: 14, shadowColor: "rgba(0,0,0,0.18)" });
    expect(hostsUnder(card).filter((node) => shadowed((StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>))).toHaveLength(0);
  }
  unmount(root);
});

test("dragging the deck two cards renders nothing and mounts no card mid-gesture; the mounting window moves only once the deck has settled", () => {
  const { State } = require("react-native-gesture-handler") as typeof import("react-native-gesture-handler");
  const { fireGestureHandler, getByGestureTestId } = require("react-native-gesture-handler/jest-utils") as typeof import("react-native-gesture-handler/jest-utils");
  const perf = require("../state/app/interactionPerf") as typeof import("../state/app/interactionPerf");
  withTabs(20);
  const lines: string[] = [];
  const root = renderSurface(<TabDeck />);
  const mountedBefore = cards(root).length;
  perf.enableInteractionPerf(true, (line) => lines.push(line));
  act(() => perf.beginInteraction("drag", 5000));
  act(() =>
    fireGestureHandler(getByGestureTestId("deckPan"), [
      { state: State.BEGAN, x: 200, y: 400, absoluteX: 200, absoluteY: 400, translationX: 0, translationY: 0, velocityX: 0 },
      { state: State.ACTIVE, x: 200, y: 400, absoluteX: 200, absoluteY: 400, translationX: 0, translationY: 0, velocityX: 0 },
      { state: State.ACTIVE, x: 320, y: 400, absoluteX: 320, absoluteY: 400, translationX: 120, translationY: 0, velocityX: 300 },
      { state: State.ACTIVE, x: 480, y: 400, absoluteX: 480, absoluteY: 400, translationX: 280, translationY: 0, velocityX: 300 },
    ]),
  );
  act(() => perf.finishInteraction());
  perf.enableInteractionPerf(false, () => undefined);
  expect(lines[0]).toMatch(/renders 0 \| look /);
  expect(cards(root).length).toBe(mountedBefore);
  act(() =>
    fireGestureHandler(getByGestureTestId("deckPan"), [
      { state: State.ACTIVE, x: 480, y: 400, absoluteX: 480, absoluteY: 400, translationX: 280, translationY: 0, velocityX: 300 },
      { state: State.END, x: 480, y: 400, absoluteX: 480, absoluteY: 400, translationX: 280, translationY: 0, velocityX: 300 },
    ]),
  );
  act(() => jest.advanceTimersByTime(2000));
  expect(cards(root).length).toBeGreaterThan(mountedBefore);
  unmount(root);
});
