import { getAnimatedStyle, makeMutable } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { DECK_PHASE, DeckCard, type DeckMotion } from "../components/tabs/DeckCard";
import { deckGeometry, deckSlotsNow, type DeckLeave, type DeckLeaving, type DeckSlots } from "../lib/deckGeometry";
import { renderSurface, someTabs, unmount } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const motion = (): DeckMotion => ({
  orderIds: makeMutable<readonly string[]>(["t0", "t1", "t2"]),
  shiftBy: makeMutable(0),
  fromSlots: makeMutable<DeckSlots>({}),
  gap: makeMutable(1),
  phase: makeMutable<number>(DECK_PHASE.settled),
  expandedIndex: makeMutable(-1),
  scroll: makeMutable(1),
  scaleProgress: makeMutable(1),
  positionProgress: makeMutable(1),
  dragIndex: makeMutable(-1),
  dragLift: makeMutable(0),
  leaving: makeMutable<DeckLeaving>({}),
  flyClock: makeMutable(0),
  covering: makeMutable(""),
});

test("a card the order drops is drawn only while it is leaving: never at its old place once it has left, so a closed card can't flash back before React removes it", () => {
  const moves = motion();
  const tab = someTabs(3)[1]!;
  const g = deckGeometry(393, 873, 40, 24);
  const root = renderSurface(
    <DeckCard tab={tab} index={1} geometry={g} motion={moves} onOpen={() => undefined} onClose={() => undefined} onCloseNow={() => undefined} />,
  );
  const card = () => root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")[0]!;
  const opacity = () => (getAnimatedStyle(card()).opacity as number | undefined) ?? 1;
  const y = () => ((getAnimatedStyle(card()).transform as { translateY?: number }[]) ?? []).reduce((sum, step) => sum + (step.translateY ?? 0), 0);
  expect(opacity()).toBe(1);
  const rest = y();
  const leave: DeckLeave = { at: 1, z: 2, t0: 0, lift: 0, away: -(g.cardCenterY + g.cardHeight), push: 0, response: 0.32, fadeMs: 0, last: false };
  act(() => {
    moves.fromSlots.value = deckSlotsNow(moves.orderIds.value, moves.fromSlots.value, moves.shiftBy.value, moves.gap.value);
    moves.orderIds.value = ["t0", "t2"];
    moves.leaving.value = { t1: leave };
  });
  act(() => jest.advanceTimersByTime(16));
  expect(opacity()).toBe(1);
  expect(y()).toBeCloseTo(rest, 3);
  act(() => {
    moves.flyClock.value = 120;
  });
  act(() => jest.advanceTimersByTime(16));
  expect(y()).toBeLessThan(rest - g.cardHeight / 2);
  act(() => {
    moves.leaving.value = {};
  });
  act(() => jest.advanceTimersByTime(16));
  expect(opacity()).toBe(0);
  unmount(root);
});

test("when a card closes, the cards after it read their new place in the list and their offset from the same write, so the frame after the list changes still draws them where they were", () => {
  const moves = motion();
  const tabs = someTabs(3);
  const g = deckGeometry(393, 873, 40, 24);
  const root = renderSurface(
    <>
      {tabs.map((tab, index) => (
        <DeckCard key={tab.id} tab={tab} index={index} geometry={g} motion={moves} onOpen={() => undefined} onClose={() => undefined} onCloseNow={() => undefined} />
      ))}
    </>,
  );
  const x = (id: string) => {
    const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string" && node.parent?.props.tab?.id === id)[0] ?? root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")[tabs.findIndex((tab) => tab.id === id)]!;
    return ((getAnimatedStyle(card).transform as { translateX?: number }[]) ?? []).reduce((sum, step) => sum + (step.translateX ?? 0), 0);
  };
  const before = x("t2");
  act(() => {
    moves.fromSlots.value = deckSlotsNow(moves.orderIds.value, moves.fromSlots.value, moves.shiftBy.value, moves.gap.value);
    moves.shiftBy.value = 0;
    moves.orderIds.value = ["t0", "t2"];
    moves.scroll.value = 1;
    moves.gap.value = 0;
  });
  expect(x("t2")).toBeCloseTo(before, 3);
  act(() => {
    moves.gap.value = 1;
  });
  expect(x("t2")).not.toBeCloseTo(before, 0);
  unmount(root);
});
