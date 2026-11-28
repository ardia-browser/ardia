import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { handleSystemBack } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import * as pagesStore from "../state/pages/store";
import { usePages } from "../state/pages/store";
import { dismissSearch } from "../state/search/store";
import { closeSettings } from "../state/settings/nav";
import { closeLibrary } from "../state/library/store";
import * as telemetry from "../state/telemetry/telemetry";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

let counted: jest.SpyInstance;
let deckShown: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  jest.spyOn(pages, "close").mockImplementation(async () => undefined as never);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  deckShown = jest.spyOn(browse, "showDeck").mockImplementation(async () => undefined);
  usePages.setState({ navigation: {}, tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false, menuOpen: false, menuPage: "main", menuDocked: false, press: null, readerTabId: null });
  dismissSearch();
  closeSettings();
  closeLibrary();
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const openIds = () => currentTabs().open.map((tab) => tab.id);

function back(): boolean {
  let handled = true;
  act(() => {
    handled = handleSystemBack();
  });
  return handled;
}

function openFromAnotherApp(url: string): string {
  act(() => browse.openPageFromAnotherApp(url, "link"));
  return currentTabs().selectedId!;
}

test("Back with no history on the tab another app just opened closes it and leaves Ardia for that app", () => {
  const before = openIds();
  const opened = openFromAnotherApp("https://x.com/jack/status/20");
  expect(before).not.toContain(opened);
  expect(back()).toBe(false);
  expect(openIds()).toEqual(before);
  expect(before).toContain(currentTabs().selectedId);
  expect(deckShown).not.toHaveBeenCalled();
  expect(counted).toHaveBeenCalledWith("tabs_returned_to_app");
});

test("Back with no history on a tab Ardia opened itself shows the deck", () => {
  act(() => void browse.openPage("https://example.com/", "typed"));
  const opened = currentTabs().selectedId!;
  expect(back()).toBe(true);
  expect(deckShown).toHaveBeenCalledTimes(1);
  expect(openIds()).toContain(opened);
  expect(counted).not.toHaveBeenCalledWith("tabs_returned_to_app");
});

test("the tab another app opened goes back through its own history first, and the tab it falls back to opens the deck", () => {
  const goBack = jest.fn(async () => undefined);
  const opened = openFromAnotherApp("https://html.duckduckgo.com/html/?q=otter");
  jest.spyOn(pagesStore, "pageHandle").mockImplementation((id) => (id === opened ? ({ goBack } as never) : null));
  act(() => usePages.setState({ navigation: { [opened]: { canGoBack: true } as never } }));
  expect(back()).toBe(true);
  expect(goBack).toHaveBeenCalledTimes(1);
  expect(openIds()).toContain(opened);
  act(() => usePages.setState({ navigation: {} }));
  expect(back()).toBe(false);
  expect(openIds()).not.toContain(opened);
  expect(back()).toBe(true);
  expect(deckShown).toHaveBeenCalledTimes(1);
});

test("only the latest link from another app returns there: Back on an earlier one shows the deck", () => {
  const first = openFromAnotherApp("https://a.example/");
  const second = openFromAnotherApp("https://b.example/");
  act(() => browse.openTab(first));
  expect(back()).toBe(true);
  expect(deckShown).toHaveBeenCalledTimes(1);
  expect(openIds()).toEqual(expect.arrayContaining([first, second]));
});

test("selecting another tab and coming back forgets that the tab came from another app", () => {
  const opened = openFromAnotherApp("https://x.com/jack/status/20");
  const other = openIds().find((id) => id !== opened)!;
  act(() => browse.openTab(other));
  act(() => browse.openTab(opened));
  expect(back()).toBe(true);
  expect(deckShown).toHaveBeenCalledTimes(1);
  expect(openIds()).toContain(opened);
  expect(counted).not.toHaveBeenCalledWith("tabs_returned_to_app");
});

test("leaving Ardia and coming back from its icon forgets the link, so Back shows the deck", () => {
  const opened = openFromAnotherApp("https://x.com/jack/status/20");
  act(() => browse.appWillResignActive());
  act(() => browse.appBecameActive());
  expect(currentTabs().selectedId).toBe(opened);
  expect(back()).toBe(true);
  expect(deckShown).toHaveBeenCalledTimes(1);
  expect(openIds()).toContain(opened);
});
