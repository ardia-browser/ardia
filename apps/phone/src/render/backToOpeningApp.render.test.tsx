import { act } from "react-test-renderer";
import * as browse from "../state/browse/store";
import { handleSystemBack } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { dismissSearch } from "../state/search/store";
import { closeSettings } from "../state/settings/nav";
import { closeLibrary } from "../state/library/store";
import * as telemetry from "../state/telemetry/telemetry";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
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

test("Back with no history on a tab another app opened closes it and leaves Ardia for that app", () => {
  const before = openIds();
  act(() => browse.openPageFromAnotherApp("https://x.com/jack/status/20", "link"));
  const opened = currentTabs().selectedId!;
  expect(before).not.toContain(opened);
  let handled = true;
  act(() => {
    handled = handleSystemBack();
  });
  expect(handled).toBe(false);
  expect(openIds()).toEqual(before);
  expect(currentTabs().selectedId).not.toBe(opened);
  expect(browse.useBrowse.getState().surface).not.toBe("deck");
  expect(counted).toHaveBeenCalledWith("tabs_returned_to_app");
});

test("Back with no history on a tab Ardia opened itself still shows the tabs", () => {
  act(() => void browse.openPage("https://example.com/", "typed"));
  const opened = currentTabs().selectedId!;
  let handled = false;
  act(() => {
    handled = handleSystemBack();
  });
  expect(handled).toBe(true);
  expect(openIds()).toContain(opened);
  expect(counted).not.toHaveBeenCalledWith("tabs_returned_to_app");
});

test("a tab another app opened goes back through its own history first, and returns to the app only once", () => {
  act(() => browse.openPageFromAnotherApp("https://x.com/jack/status/20", "link"));
  const opened = currentTabs().selectedId!;
  act(() => usePages.setState({ navigation: { [opened]: { canGoBack: true } as never } }));
  let handled = false;
  act(() => {
    handled = handleSystemBack();
  });
  expect(handled).toBe(true);
  expect(openIds()).toContain(opened);
  act(() => usePages.setState({ navigation: {} }));
  act(() => {
    handled = handleSystemBack();
  });
  expect(handled).toBe(false);
  expect(openIds()).not.toContain(opened);
});
