import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { pages } from "../platform/pages";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.spyOn(pages, "close").mockImplementation(async () => undefined as never);
jest.spyOn(pages, "saveState").mockImplementation(async () => null as never);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_790_000_000_000 + 60_000);
  withTabs(5);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const positions = (root: Root) => {
  const at = new Map<string, number>();
  for (const card of root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")) {
    const style = getAnimatedStyle(card) as { opacity?: number; transform?: { translateX?: number }[] };
    if ((style.opacity ?? 1) <= 0) continue;
    let owner: typeof card | null = card;
    while (owner && !owner.props.tab) owner = owner.parent;
    const key = (owner?.props.tab as { id: string }).id;
    at.set(key, (style.transform ?? []).reduce((sum, step) => sum + (step.translateX ?? 0), 0));
  }
  return at;
};

test("closing a card moves every remaining card only toward its new place, frame by frame: no frame shows the closed card back or the others jumped ahead and pulled back", () => {
  const root = renderSurface(<TabDeck />);
  const before = positions(root);
  const openBefore = currentTabs().open.map((tab) => tab.id);
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  const frames: Map<string, number>[] = [];
  for (let frame = 0; frame < 90; frame++) {
    act(() => jest.advanceTimersByTime(16));
    frames.push(positions(root));
  }
  const after = frames.at(-1)!;
  expect(openBefore.length - currentTabs().open.length).toBe(1);
  expect(after.size).toBe(before.size - 1);
  for (const [title, end] of after) {
    const start = before.get(title);
    if (start === undefined) continue;
    const path = [start, ...frames.map((frame) => frame.get(title)).filter((x): x is number => x !== undefined)];
    const direction = Math.sign(end - start);
    for (let step = 1; step < path.length; step++) {
      const moved = path[step]! - path[step - 1]!;
      expect(direction === 0 ? Math.abs(moved) < 0.5 : moved * direction >= -0.5).toBe(true);
    }
  }
  unmount(root);
});
