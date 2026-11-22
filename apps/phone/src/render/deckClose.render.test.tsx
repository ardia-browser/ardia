import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

jest.spyOn(pages, "close").mockImplementation(async () => undefined as never);
jest.spyOn(pages, "saveState").mockImplementation(async () => null as never);

let closing: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_790_000_000_000 + 60_000);
  withTabs(4);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  closing = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
});

afterEach(() => {
  closing.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
type Drawn = { x: number; y: number; opacity: number; height: number };

const ownerTab = (card: ReactTestInstance) => {
  let owner: ReactTestInstance | null = card;
  while (owner && !owner.props.tab) owner = owner.parent;
  return (owner?.props.tab as { id: string }).id;
};

const drawn = (root: Root) => {
  const at = new Map<string, Drawn>();
  for (const card of root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")) {
    const style = getAnimatedStyle(card) as { opacity?: number; transform?: { translateX?: number; translateY?: number }[] };
    const steps = style.transform ?? [];
    at.set(ownerTab(card), { x: steps.reduce((sum, step) => sum + (step.translateX ?? 0), 0), y: steps.reduce((sum, step) => sum + (step.translateY ?? 0), 0), opacity: style.opacity ?? 1, height: (card.props.style as { height?: number }[]).find((part) => part && typeof part.height === "number")?.height ?? 0 });
  }
  return at;
};

const frames = (root: Root, count: number) => {
  const seen: Map<string, Drawn>[] = [];
  for (let frame = 0; frame < count; frame++) {
    act(() => jest.advanceTimersByTime(16));
    seen.push(drawn(root));
  }
  return seen;
};

const scrollTo = (index: number) => {
  act(() => sendDeckCommand({ kind: "scroll", index }));
  act(() => jest.advanceTimersByTime(1500));
};

const firstMoved = (path: (number | undefined)[], from: number) => path.findIndex((value) => value !== undefined && Math.abs(value - from) > 0.5);

function closeAndWatch(root: Root, focus: number) {
  scrollTo(focus);
  const ids = currentTabs().open.map((tab) => tab.id);
  const before = drawn(root);
  const order = [...before.keys()].sort((a, b) => before.get(a)!.x - before.get(b)!.x);
  const closed = order[focus]!;
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  return { ids, before, order, closed, seen: frames(root, 60) };
}

test("closing a card from the deck flies it off the top with no dust cloud and closes the tab at once, while the card is drawn whole until it has left the screen", () => {
  const root = renderSurface(<TabDeck />);
  const { before, closed, seen } = closeAndWatch(root, 1);
  expect(closing).toHaveBeenCalledTimes(1);
  expect(closing).toHaveBeenCalledWith(closed);
  expect(root.root.findAll((node) => node.props.testID === "poofBurst")).toHaveLength(0);
  const path = seen.map((frame) => frame.get(closed));
  const shown = path.filter((pose): pose is Drawn => pose !== undefined);
  expect(shown.length).toBeGreaterThan(2);
  for (const pose of shown) expect(pose.opacity).toBe(1);
  for (let i = 1; i < shown.length; i++) expect(shown[i]!.y).toBeLessThanOrEqual(shown[i - 1]!.y + 0.01);
  const last = shown.at(-1)!;
  expect(last.y + last.height).toBeLessThan(0);
  expect(before.get(closed)!.y).toBeGreaterThan(0);
  expect(path.at(-1)).toBeUndefined();
  unmount(root);
});

test("the cards after the closed one close the gap in the same frames as it rises, not after it has gone", () => {
  const root = renderSurface(<TabDeck />);
  const { before, order, closed, seen } = closeAndWatch(root, 1);
  const next = order[2]!;
  const rises = firstMoved(seen.map((frame) => frame.get(closed)?.y), before.get(closed)!.y);
  const slides = firstMoved(seen.map((frame) => frame.get(next)?.x), before.get(next)!.x);
  expect(rises).toBe(0);
  expect(slides).toBe(0);
  const gone = seen.findIndex((frame) => !frame.has(closed));
  const offScreen = seen.findIndex((frame) => frame.has(closed) && frame.get(closed)!.y + frame.get(closed)!.height < 0);
  const travel = before.get(closed)!.x - before.get(next)!.x;
  expect(offScreen).toBeGreaterThan(2);
  expect((seen[offScreen]!.get(next)!.x - before.get(next)!.x) / travel).toBeGreaterThan(0.6);
  expect(gone).toBeGreaterThan(offScreen);
  expect(seen.at(-1)!.get(next)!.x).toBeCloseTo(before.get(closed)!.x, 1);
  unmount(root);
});

test("closing the first card and the last card fly them off the same way, and the others end where the deck rests", () => {
  for (const focus of [0, 3]) {
    withTabs(4);
    const root = renderSurface(<TabDeck />);
    const { before, closed, seen } = closeAndWatch(root, focus);
    const path = seen.map((frame) => frame.get(closed)).filter((pose): pose is Drawn => pose !== undefined);
    expect(path[0]!.y).toBeLessThan(before.get(closed)!.y);
    expect(path.at(-1)!.y + path.at(-1)!.height).toBeLessThan(0);
    expect(seen.at(-1)!.has(closed)).toBe(false);
    for (const [id, pose] of seen.at(-1)!) {
      expect(pose.opacity).toBe(1);
      expect(pose.y).toBeCloseTo(before.get(id)!.y, 1);
    }
    expect(seen.at(-1)!.size).toBe(3);
    unmount(root);
    closing.mockClear();
  }
});

test("closing the deck's only tab lets the card fly away before the deck hands over to the start screen", () => {
  closing.mockRestore();
  withTabs(1);
  const root = renderSurface(<TabDeck />);
  const id = currentTabs().open[0]!.id;
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  act(() => jest.advanceTimersByTime(48));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(drawn(root).get(id)!.y).toBeLessThan(0);
  expect(textOf(root)).not.toContain("No Open Tabs");
  for (let frame = 0; frame < 40; frame++) act(() => jest.advanceTimersByTime(16));
  expect(currentTabs().open).toHaveLength(0);
  expect(browse.useBrowse.getState().surface).toBe("start");
  unmount(root);
  closing = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
});
