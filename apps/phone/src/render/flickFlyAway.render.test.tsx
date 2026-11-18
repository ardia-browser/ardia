import { Platform } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { TabDeck } from "../components/tabs/TabDeck";
import { appDesign } from "../components/ui";
import { deckGeometry } from "../lib/deckGeometry";
import * as browse from "../state/browse/store";
import { pages } from "../platform/pages";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const TABS_MADE = 1_790_000_000_000;

jest.spyOn(pages, "close").mockImplementation(async () => undefined as never);
jest.spyOn(pages, "saveState").mockImplementation(async () => null as never);

let closing: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(TABS_MADE + 60_000);
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  closing = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
});

afterEach(() => {
  closing.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const g = deckGeometry(393, 873, 40, 24, 0, Platform.OS, appDesign, deckHeaderBottom());

const ownerTab = (card: ReactTestInstance) => {
  let owner: ReactTestInstance | null = card;
  while (owner && !owner.props.tab) owner = owner.parent;
  return (owner?.props.tab as { id: string }).id;
};

const topOf = (root: Root, id: string): number | null => {
  const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string").find((node) => ownerTab(node) === id);
  if (!card) return null;
  const style = getAnimatedStyle(card) as { opacity?: number; transform?: { translateY?: number }[] };
  return (style.transform ?? []).reduce((sum, step) => sum + (step.translateY ?? 0), 0);
};

const flick = (rise: number, velocityY: number) =>
  act(() =>
    fireGestureHandler(getByGestureTestId("deckPan"), [
      { state: State.BEGAN, x: 200, y: g.cardCenterY, absoluteX: 200, absoluteY: g.cardCenterY, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, x: 200, y: g.cardCenterY - 20, absoluteX: 200, absoluteY: g.cardCenterY - 20, translationX: 0, translationY: -20, velocityX: 0, velocityY },
      { state: State.ACTIVE, x: 200, y: g.cardCenterY - rise, absoluteX: 200, absoluteY: g.cardCenterY - rise, translationX: 0, translationY: -rise, velocityX: 0, velocityY },
      { state: State.END, x: 200, y: g.cardCenterY - rise, absoluteX: 200, absoluteY: g.cardCenterY - rise, translationX: 0, translationY: -rise, velocityX: 0, velocityY },
    ]),
  );

const flickedCard = () => {
  const call = closing.mock.calls[0];
  return call ? (call[0] as string) : null;
};

function watchFlick(rise: number, velocityY: number) {
  withTabs(3);
  const root = renderSurface(<TabDeck />);
  const released = g.cardCenterY - g.cardHeight / 2 - rise;
  flick(rise, velocityY);
  act(() => jest.advanceTimersByTime(1));
  expect(closing).toHaveBeenCalledTimes(1);
  const id = flickedCard()!;
  const path: (number | null)[] = [];
  for (let frame = 0; frame < 40; frame++) {
    act(() => jest.advanceTimersByTime(16));
    path.push(topOf(root, id));
  }
  unmount(root);
  closing.mockClear();
  return { released, path };
}

test("a card flicked up carries on from where the finger let go, with no dust cloud: it only ever rises until it is off the top, then it is gone", () => {
  const { released, path } = watchFlick(160, -1800);
  const shown = path.filter((top): top is number => top !== null);
  expect(shown[0]!).toBeLessThan(released);
  for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeLessThanOrEqual(shown[i - 1]! + 0.01);
  expect(shown.at(-1)! + g.cardHeight).toBeLessThan(0);
  expect(path.at(-1)).toBeNull();
});

test("the flick's speed carries into the fly-away: a fast flick is higher two frames on than a slow release from the same place", () => {
  const fast = watchFlick(g.cardHeight / 2, -2400);
  const slow = watchFlick(g.cardHeight / 2, -100);
  expect(fast.released).toBe(slow.released);
  expect(fast.path[1]!).toBeLessThan(slow.path[1]! - 10);
  expect(fast.path.findIndex((top) => top === null)).toBeLessThanOrEqual(slow.path.findIndex((top) => top === null));
});

test("a card dragged to the top of the screen before its flick still leaves upward from there, with no jump back down", () => {
  const rise = g.cardCenterY - 30;
  const { released, path } = watchFlick(rise, -1800);
  const shown = path.filter((top): top is number => top !== null);
  expect(shown[0]!).toBeLessThanOrEqual(released);
  for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeLessThanOrEqual(shown[i - 1]! + 0.01);
});

test("a flick starts the fly-away and the gap close on the UI thread as the finger lifts, before JavaScript hears of it, so the card never holds still at the release", () => {
  const root = renderSurface(<TabDeck />);
  const motion = root.root.findAll((node) => typeof node.type !== "string" && node.props.motion?.leaving)[0]!.props.motion as import("../components/tabs/DeckCard").DeckMotion;
  const before = motion.orderIds.value.length;
  flick(160, -1800);
  expect(closing).not.toHaveBeenCalled();
  const flying = Object.keys(motion.leaving.value);
  expect(flying).toHaveLength(1);
  expect(motion.orderIds.value).toHaveLength(before - 1);
  expect(motion.orderIds.value).not.toContain(flying[0]);
  expect(motion.gap.value).toBeLessThan(1);
  act(() => jest.advanceTimersByTime(1));
  expect(closing).toHaveBeenCalledWith(flying[0]);
  unmount(root);
});
