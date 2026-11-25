import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { framesUntil, landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

const STORED = "#123456";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  useTabs.setState((state) => ({ open: state.open.map((tab) => ({ ...tab, themeColorHex: STORED })) }));
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const background = (node: ReactTestInstance) => {
  let animated: unknown;
  try {
    animated = getAnimatedStyle(node).backgroundColor;
  } catch {
    animated = undefined;
  }
  return animated ?? StyleSheet.flatten(node.props.style)?.backgroundColor;
};

test("while a card opens, before its page reports a colour, the card's strip and the page's status strip and bar take the tab's stored theme colour, not the app's surface", () => {
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  act(() => jest.advanceTimersByTime(16 * 6));
  expect(useBrowse.getState().surface).toBe("deck");
  const cards = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");
  expect(cards.length).toBeGreaterThan(0);
  expect(cards.every((card) => StyleSheet.flatten(card.props.style).backgroundColor === STORED)).toBe(true);
  framesUntil(() => useBrowse.getState().opening !== null);
  expect(useBrowse.getState().opening).toBe(currentTabs().selectedId);
  landOpeningPage(root);
  act(() => jest.advanceTimersByTime(1000));
  const stored = root.root.findAll((node) => typeof node.type === "string" && background(node) === STORED);
  expect(stored.length).toBeGreaterThanOrEqual(2);
  unmount(root);
});
