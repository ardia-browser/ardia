import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { pageDrawn, useBrowse } from "../state/browse/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { currentTabs, updateTabById } from "../state/tabs/store";
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
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(cover(root)).toBe(true);
  act(() => storeNavigation(tab.id, state(true, true)));
  act(() => jest.advanceTimersByTime(1000));
  expect(cover(root)).toBe(true);
  act(() => storeNavigation(tab.id, state(true, false)));
  if (Platform.OS === "ios") {
    act(() => jest.advanceTimersByTime(400));
    expect(cover(root)).toBe(true);
    act(() => pageDrawn(tab.id));
  }
  act(() => jest.advanceTimersByTime(400));
  expect(cover(root)).toBe(false);
  unmount(root);
});

test("a page that never reports gives up its cover after four seconds", () => {
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(3900));
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(500));
  expect(cover(root)).toBe(false);
  unmount(root);
});

test("a page that is already live and settled with no saved picture shows no cover at all", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, state(true, false));
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(cover(root)).toBe(false);
  unmount(root);
});

test("while the deck still covers the page, the cover holds; it fades only once the page is shown alone, so the fade is seen", () => {
  const tab = currentTabs().open[0]!;
  useBrowse.setState({ surface: "deck" });
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => storeNavigation(tab.id, state(true, true)));
  act(() => storeNavigation(tab.id, state(true, false)));
  act(() => jest.advanceTimersByTime(5000));
  expect(cover(root)).toBe(true);
  act(() => useBrowse.setState({ surface: "browsing" }));
  act(() => jest.advanceTimersByTime(100));
  expect(cover(root)).toBe(true);
  if (Platform.OS === "ios") act(() => pageDrawn(tab.id));
  act(() => jest.advanceTimersByTime(400));
  expect(cover(root)).toBe(false);
  unmount(root);
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;

onIPhone("on iPhone a live page's saved picture stays over the page until the page's own view reports it drew, even past the old settle, then goes in the same frame", () => {
  const tab = currentTabs().open[0]!;
  updateTabById(tab.id, { snapshotFileName: "file:///snapshots/live.jpg" });
  storeNavigation(tab.id, state(true, false));
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(600));
  expect(cover(root)).toBe(true);
  act(() => pageDrawn(tab.id));
  expect(cover(root)).toBe(false);
  unmount(root);
});

onIPhone("on iPhone a draw reported by the page's previous view doesn't lift a new view's cover, and a page that never reports gives the picture up after a second", () => {
  const tab = currentTabs().open[0]!;
  updateTabById(tab.id, { snapshotFileName: "file:///snapshots/early.jpg" });
  storeNavigation(tab.id, state(true, false));
  const early = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => pageDrawn(tab.id));
  unmount(early);
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(900));
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(400));
  expect(cover(root)).toBe(false);
  unmount(root);
});

const navigating = (url: string, isLoading: boolean, document: number) => ({ ...state(true, isLoading), url, document }) as unknown as PageState;

onIPhone("on iPhone the picture goes as soon as the page's current document has drawn, even while it still loads, and never lets a tap through to the page it hides", () => {
  const tab = currentTabs().open[0]!;
  updateTabById(tab.id, { snapshotFileName: "file:///snapshots/slow.jpg" });
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => storeNavigation(tab.id, navigating("https://site0.example/", true, 3)));
  act(() => jest.advanceTimersByTime(2_000));
  const shown = root.root.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")[0]!;
  expect(shown.props.pointerEvents).toBe("auto");
  act(() => pageDrawn(tab.id, 3));
  act(() => jest.advanceTimersByTime(200));
  expect(cover(root)).toBe(false);
  unmount(root);
});

onIPhone("on iPhone a draw of the document before the current one doesn't lift the picture", () => {
  const tab = currentTabs().open[0]!;
  updateTabById(tab.id, { snapshotFileName: "file:///snapshots/before.jpg" });
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => storeNavigation(tab.id, navigating("https://site0.example/next", true, 5)));
  act(() => pageDrawn(tab.id, 4));
  act(() => jest.advanceTimersByTime(1_500));
  expect(cover(root)).toBe(true);
  act(() => pageDrawn(tab.id, 5));
  act(() => jest.advanceTimersByTime(200));
  expect(cover(root)).toBe(false);
  unmount(root);
});

onIPhone("on iPhone a page that settles and then starts loading a new address keeps its picture until the new document draws, at most until the four second limit", () => {
  const tab = currentTabs().open[0]!;
  updateTabById(tab.id, { snapshotFileName: "file:///snapshots/settled.jpg" });
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => storeNavigation(tab.id, navigating("https://site0.example/", false, 1)));
  act(() => jest.advanceTimersByTime(100));
  act(() => storeNavigation(tab.id, navigating("https://next.example/", true, 2)));
  act(() => jest.advanceTimersByTime(1_200));
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(3_000));
  expect(cover(root)).toBe(false);
  unmount(root);
});

onIPhone("on iPhone the second's wait for a settled page's draw stops while the tab view covers the page, and starts again when the page is shown", () => {
  const tab = currentTabs().open[0]!;
  updateTabById(tab.id, { snapshotFileName: "file:///snapshots/deck.jpg" });
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => storeNavigation(tab.id, navigating("https://site0.example/", false, 1)));
  act(() => jest.advanceTimersByTime(500));
  act(() => useBrowse.setState({ surface: "deck" }));
  act(() => jest.advanceTimersByTime(900));
  expect(cover(root)).toBe(true);
  act(() => useBrowse.setState({ surface: "browsing" }));
  act(() => jest.advanceTimersByTime(700));
  expect(cover(root)).toBe(true);
  act(() => jest.advanceTimersByTime(600));
  expect(cover(root)).toBe(false);
  unmount(root);
});
