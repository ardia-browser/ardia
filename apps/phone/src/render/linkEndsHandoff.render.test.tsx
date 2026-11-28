import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { startLinks } from "../state/links/links";
import { handleSystemBack } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { dismissSearch } from "../state/search/store";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

const mockLinks = { listener: null as null | ((link: unknown) => void) };

jest.mock("../platform/links", () => ({
  initialLink: async () => null,
  addLinkListener: (listener: (link: unknown) => void) => {
    mockLinks.listener = listener;
    return { remove: () => undefined };
  },
  setHidesFromRecents: async () => undefined,
}));

test("a later link that leaves the same tab selected ends the hand-off, so Back on the earlier link's tab shows the deck", async () => {
  jest.useFakeTimers();
  withTabs(1);
  jest.spyOn(pages, "close").mockImplementation(async () => undefined as never);
  const deckShown = jest.spyOn(browse, "showDeck").mockImplementation(async () => undefined);
  usePages.setState({ navigation: {}, tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false, menuOpen: false, menuPage: "main", menuDocked: false, press: null, readerTabId: null });
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  await act(async () => startLinks());
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  act(() => mockLinks.listener!({ kind: "open", url: "https://x.com/jack/status/20", source: "web" }));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  const opened = currentTabs().selectedId!;
  act(() => mockLinks.listener!({ kind: "search", query: null, source: "intent" }));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  act(() => dismissSearch());
  expect(currentTabs().selectedId).toBe(opened);
  let handled = false;
  act(() => {
    handled = handleSystemBack();
  });
  expect(handled).toBe(true);
  expect(deckShown).toHaveBeenCalledTimes(1);
  expect(currentTabs().open.map((tab) => tab.id)).toContain(opened);
  jest.useRealTimers();
  jest.restoreAllMocks();
});
