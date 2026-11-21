import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

let captured: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_790_000_060_000);
  withTabs(3);
  captured = [];
  jest.spyOn(pages, "snapshot").mockImplementation(async (id: string) => {
    captured.push(id);
    return null as never;
  });
  jest.spyOn(pages, "close").mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const settle = (id: string) =>
  act(() => browse.pageStateChanged(id, { url: "https://example.com/", title: "Example", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));

test("leaving a settled page for another tab takes its picture on the way out, as Compose's covers do, so the bar's thumbnail isn't the old one", async () => {
  const [first, second] = currentTabs().open;
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  browse.openTab(first!.id);
  settle(first!.id);
  captured = [];
  await act(async () => browse.switchToNeighbour(second!.id));
  expect(captured).toEqual([first!.id]);
});

test("opening a tab from the deck takes no picture, since the page the deck covers isn't on screen", async () => {
  const [first, second] = currentTabs().open;
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  browse.openTab(first!.id);
  settle(first!.id);
  browse.useBrowse.setState({ surface: "deck" });
  captured = [];
  await act(async () => browse.openTab(second!.id));
  expect(captured).toEqual([]);
});
