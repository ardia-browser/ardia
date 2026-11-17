import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import * as browse from "../state/browse/store";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let closing: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_790_000_000_000 + 60_000);
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  closing = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  closing.mockRestore();
  jest.useRealTimers();
});

test("a closing card fades as one layer while it rises and shrinks, as Compose's does, with no blur of its own and no faster fade, so no pale hard-edged rectangle is left around the puff", () => {
  const root = renderSurface(<TabDeck />);
  const cards = () => root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");
  for (const card of cards()) expect(card.props.needsOffscreenAlphaCompositing).toBe(true);
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  const seen: number[] = [];
  let blurred = false;
  for (let frame = 0; frame < 7; frame++) {
    act(() => jest.advanceTimersByTime(16));
    for (const card of cards()) {
      const style = getAnimatedStyle(card) as { opacity?: number; filter?: unknown[] };
      if ((style.filter?.length ?? 0) > 0) blurred = true;
      const opacity = style.opacity ?? 1;
      if (opacity < 1) seen.push(opacity);
    }
  }
  expect(blurred).toBe(false);
  expect(seen.some((opacity) => opacity > 0.1 && opacity < 0.9)).toBe(true);
  for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]! + 1e-6);
  unmount(root);
});
