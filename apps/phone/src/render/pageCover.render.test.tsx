import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { useBrowse } from "../state/browse/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const state = (isLive: boolean, isLoading: boolean) => ({ isLive, isLoading, url: "https://site0.example/", title: "Site 0", failure: null, progress: 0 }) as unknown as PageState;
const cover = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string").length > 0;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState({ navigation: {}, tones: {} });
  useBrowse.setState({ surface: "browsing" });
});
afterEach(() => jest.useRealTimers());

test("a page that hasn't painted is covered by its face until it finishes loading, then the cover fades", () => {
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tab={tab} />, { flushTimers: false });
  expect(cover(root)).toBe(true);
  act(() => storeNavigation(tab.id, state(true, true)));
  act(() => jest.advanceTimersByTime(1000));
  expect(cover(root)).toBe(true);
  act(() => storeNavigation(tab.id, state(true, false)));
  act(() => jest.advanceTimersByTime(400));
  expect(cover(root)).toBe(false);
  unmount(root);
});

test("a page that never reports gives up its cover after four seconds", () => {
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tab={tab} />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(3900));
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(500));
  expect(cover(root)).toBe(false);
  unmount(root);
});

test("a page that is already live and settled with no saved picture shows no cover at all", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, state(true, false));
  const root = renderSurface(<BrowsingScreen tab={tab} />, { flushTimers: false });
  expect(cover(root)).toBe(false);
  unmount(root);
});

test("while the deck still covers the page, the cover holds; it fades only once the page is shown alone, so the fade is seen", () => {
  const tab = currentTabs().open[0]!;
  useBrowse.setState({ surface: "deck" });
  const root = renderSurface(<BrowsingScreen tab={tab} />, { flushTimers: false });
  act(() => storeNavigation(tab.id, state(true, true)));
  act(() => storeNavigation(tab.id, state(true, false)));
  act(() => jest.advanceTimersByTime(5000));
  expect(cover(root)).toBe(true);
  act(() => useBrowse.setState({ surface: "browsing" }));
  act(() => jest.advanceTimersByTime(100));
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(400));
  expect(cover(root)).toBe(false);
  unmount(root);
});
