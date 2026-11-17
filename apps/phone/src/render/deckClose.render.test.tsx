import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { POOF } from "../lib/poof";
import * as browse from "../state/browse/store";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let closing: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null });
  closing = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
});

afterEach(() => {
  closing.mockRestore();
  jest.useRealTimers();
});

test("closing a card from the deck plays the poof on the UI thread to its end and closes the tab", () => {
  const root = renderSurface(<TabDeck />);
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  const puffs = () => root.root.findAll((node) => typeof node.type === "string" && node.props.pointerEvents === "none" && node.props.accessibilityElementsHidden === true && node.children.length === POOF.count + 1);
  expect(puffs()).toHaveLength(1);
  for (let frame = 0; frame < 40; frame++) act(() => jest.advanceTimersByTime(16));
  act(() => jest.advanceTimersByTime(1000));
  expect(closing).toHaveBeenCalledTimes(1);
  expect(puffs()).toHaveLength(0);
  unmount(root);
});
