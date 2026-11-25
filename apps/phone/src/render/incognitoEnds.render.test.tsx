const mockEnded = { closed: [] as string[] };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  return {
    ...actual,
    closePage: async (id: string) => void mockEnded.closed.push(id),
    pages: { ...actual.pages, endPrivateSession: async () => undefined, deleteSnapshots: async () => undefined },
  };
});

import { act } from "react-test-renderer";
import { closeTabFromDeck } from "../state/browse/store";
import { currentTabs, setIncognito, useTabs } from "../state/tabs/store";
import { TabDeck } from "../components/tabs/TabDeck";
import { useBrowse } from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("closing the last private tab leaves incognito, so the deck's new-tab button reads New Tab again", () => {
  const base = currentTabs().open[0]!;
  act(() => useTabs.setState((state) => ({ privates: [{ ...base, id: "private-1", isPrivate: true }], incognito: true, selectedId: "private-1" }) as never));
  expect(useTabs.getState().incognito).toBe(true);
  expect(currentTabs().privates.length).toBeGreaterThan(0);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />);
  for (const tab of [...currentTabs().privates]) act(() => closeTabFromDeck(tab.id));
  act(() => jest.advanceTimersByTime(600));
  expect(currentTabs().privates).toHaveLength(0);
  expect(useTabs.getState().incognito).toBe(false);
  const plus = root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && /^New (Incognito )?Tab$/.test(node.props.accessibilityLabel) && typeof node.props.onPress === "function");
  expect(plus.length).toBeGreaterThan(0);
  for (const button of plus) expect(button.props.accessibilityLabel).toBe("New Tab");
  unmount(root);
});

test("choosing incognito before any private tab exists stays in incognito", () => {
  act(() => setIncognito(true));
  act(() => jest.advanceTimersByTime(600));
  expect(currentTabs().privates).toHaveLength(0);
  expect(useTabs.getState().incognito).toBe(true);
  act(() => setIncognito(false));
});
