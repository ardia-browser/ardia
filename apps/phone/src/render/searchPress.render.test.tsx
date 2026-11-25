import { act } from "react-test-renderer";
import * as omnibox from "../state/search/omnibox";
import { setSearchEngine } from "../state/search/omnibox";
import { dismissSearch, presentSearch, searchPresented, setSearchClearsPagePrefill, useSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
});

afterEach(() => {
  act(() => dismissSearch());
  setSearchClearsPagePrefill(false);
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("where the panel opens on an empty field, a page's search starts empty instead of suggesting for its address and clearing it a moment later", () => {
  setSearchClearsPagePrefill(true);
  act(() => presentSearch("page", "https://example.com/a", null, { currentUrl: "https://example.com/a", currentTabId: "t0" }));
  expect(useSearch.getState()).toMatchObject({ open: true, text: "", initialText: "https://example.com/a", editsPage: true });
});

test("elsewhere a page's search still opens with its address in the field", () => {
  act(() => presentSearch("page", "https://example.com/a", null, { currentUrl: "https://example.com/a", currentTabId: "t0" }));
  expect(useSearch.getState()).toMatchObject({ text: "https://example.com/a", initialText: "https://example.com/a" });
});

test("changed suggestion sources are rebuilt once the panel has presented, not before it moves, and without a presentation shortly after", () => {
  act(() => presentSearch("home"));
  act(() => dismissSearch());
  const rebuilt = jest.spyOn(omnibox, "setSources");
  act(() => useTabs.setState((state) => ({ listing: state.listing + 1 })));
  act(() => presentSearch("home"));
  expect(useSearch.getState().open).toBe(true);
  act(() => jest.advanceTimersByTime(32));
  expect(rebuilt).not.toHaveBeenCalled();
  act(() => searchPresented(useSearch.getState().session));
  expect(rebuilt).toHaveBeenCalledTimes(1);
  act(() => dismissSearch());
  act(() => useTabs.setState((state) => ({ listing: state.listing + 1 })));
  act(() => presentSearch("home"));
  act(() => jest.advanceTimersByTime(400));
  expect(rebuilt).toHaveBeenCalledTimes(2);
});

test("a blank search with nothing remembered for its scope opens with no rows instead of reading history first", () => {
  act(() => useTabs.setState((state) => ({ spaces: { ...state.spaces, current: "never-opened-scope" } })));
  act(() => presentSearch("home"));
  expect(useSearch.getState().rows).toEqual([]);
});

test("idle rows are made again after the search engine changes, so none carry the old engine's addresses", () => {
  act(() => presentSearch("home"));
  act(() => searchPresented(useSearch.getState().session));
  act(() => dismissSearch());
  const before = omnibox.searchEngineRevision();
  setSearchEngine("duckduckgo");
  setSearchEngine("bing");
  expect(omnibox.searchEngineRevision()).toBeGreaterThan(before);
  const idle = jest.spyOn(omnibox, "idleRows");
  act(() => presentSearch("home"));
  act(() => searchPresented(useSearch.getState().session));
  expect(idle).toHaveBeenCalled();
});

test("a remembered query row shown at the press already searches with the engine chosen since, before the panel has presented", () => {
  const [first, second] = omnibox.searchEngines();
  const realIdleRows = jest.requireActual<typeof omnibox>("../state/search/omnibox").idleRows;
  const idle = jest.spyOn(omnibox, "idleRows").mockImplementation((_queries, macTabs) => realIdleRows(["otter facts"], macTabs));
  setSearchEngine(first!.id);
  act(() => useTabs.setState((state) => ({ listing: state.listing + 1 })));
  act(() => presentSearch("home"));
  act(() => searchPresented(useSearch.getState().session));
  const firstUrl = omnibox.resolve("?otter facts")?.url;
  expect(useSearch.getState().rows.find((row) => row.kind === "query")?.url).toBe(firstUrl);
  act(() => dismissSearch());
  setSearchEngine(second!.id);
  const secondUrl = omnibox.resolve("?otter facts")?.url;
  expect(secondUrl).not.toBe(firstUrl);
  idle.mockClear();
  act(() => presentSearch("home"));
  expect(idle).not.toHaveBeenCalled();
  expect(useSearch.getState().rows.find((row) => row.kind === "query")?.url).toBe(secondUrl);
});
