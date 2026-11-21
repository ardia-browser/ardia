import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { useBrowse } from "../state/browse/store";
import { currentTabs, receiveSentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(5);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const cardTitles = (root: ReturnType<typeof renderSurface>) =>
  root.root.findAll((node) => node.props.accessibilityHint === "Opens the tab." && typeof node.type === "string").map((card) => card.props.accessibilityLabel as string);

test("a tab sent from the Mac while the deck is open shows at once, beside the selected tab where reopening would put it, not past it off the edge", () => {
  const root = renderSurface(<TabDeck />);
  act(() => jest.advanceTimersByTime(1500));
  const before = cardTitles(root);
  act(() => {
    receiveSentTabs([{ key: "mac-1", url: "https://example.org/from-mac", title: "From the Mac", fromDevice: "Mac", sentAt: Date.now(), profileSyncId: null }]);
  });
  for (let frame = 0; frame < 60; frame++) act(() => jest.advanceTimersByTime(16));
  const after = cardTitles(root);
  expect(after).toHaveLength(before.length + 1);
  expect(after).toContain("From the Mac");
  const selected = currentTabs().open.find((tab) => tab.id === currentTabs().selectedId)!;
  expect(after.at(-1)).toBe(selected.title);
  expect(after.at(-2)).toBe("From the Mac");
  unmount(root);
});
