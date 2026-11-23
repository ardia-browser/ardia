import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { pages } from "../platform/pages";
import { saveTabPosition } from "../state/browse/positions";
import * as browse from "../state/browse/store";
import { useOnboarding } from "../state/onboarding/store";
import { dismissSearch } from "../state/search/store";
import { closeTabById, currentTabs, updateTabById, useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { withTabs } from "../../test/render/harness";

let scrollY = 0;
let reportedY = 0;
let pageListener: ((event: unknown) => void) | null = null;
let generation = 100;
let counted: jest.SpyInstance;
let snapshot: jest.SpyInstance;

beforeAll(() => {
  jest.useFakeTimers();
  jest.spyOn(pages, "addListener").mockImplementation((listener) => {
    pageListener = listener as (event: unknown) => void;
    return { remove: () => undefined } as never;
  });
  browse.startBrowser();
});

beforeEach(() => {
  withTabs(2);
  useTabs.setState({ incognito: false });
  act(() => dismissSearch());
  useOnboarding.setState({ showing: false });
  browse.useBrowse.setState({ surface: "browsing", sheet: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  scrollY = 0;
  reportedY = 0;
  jest.spyOn(pages, "scrollPosition").mockImplementation(async () => ({ y: scrollY, viewportWidth: 393, viewportHeight: 873, contentHeight: 9000 }));
  jest.spyOn(pages, "saveState").mockImplementation(async () => `state-at-${scrollY}`);
  snapshot = jest.spyOn(pages, "snapshot").mockImplementation(async (id: string) => {
    generation += 1;
    return { path: "", uri: `file:///p/${id}-${generation}.jpg`, width: 600, height: 1333, durable: true, generation } as never;
  });
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  jest.useRealTimers();
});

const front = () => currentTabs().selectedId!;
const picture = (id: string) => currentTabs().open.find((tab) => tab.id === id)!.snapshotFileName;
const pageIs = (id: string, isLoading: boolean) => act(() => browse.pageStateChanged(id, { url: "https://www.theverge.com/", title: "The Verge", isLoading, isLive: true, canGoBack: false, canGoForward: false } as never));

const SCROLL_REST_IS_REPORTED = Platform.OS === "ios";

async function scrollWatchTicks(count: number) {
  for (let tick = 0; tick < count; tick++) {
    if (SCROLL_REST_IS_REPORTED && scrollY !== reportedY) {
      reportedY = scrollY;
      await act(async () => pageListener?.({ name: "page.scrollSettled", pageId: front(), y: scrollY }));
    }
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await act(async () => undefined);
  }
}

test("on Android, a page scrolled while it is still loading gets a new picture once the scroll settles, so its card never shows the page from before the scroll; iPhone keeps its pictures as they were", async () => {
  const id = front();
  pageIs(id, true);
  await scrollWatchTicks(2);
  snapshot.mockClear();
  counted.mockClear();
  const before = picture(id);
  scrollY = 1800;
  await scrollWatchTicks(2);
  if (Platform.OS === "android") {
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot.mock.calls[0]![0]).toBe(id);
    expect(picture(id)).not.toBe(before);
    expect(picture(id)).toMatch(new RegExp(`^file:///p/${id}-`));
    expect(counted).toHaveBeenCalledWith("page_pictures_scrolled");
  } else {
    expect(snapshot).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalledWith("page_pictures_scrolled");
  }
});

test("a scroll that settles where it already was takes no picture", async () => {
  const id = front();
  pageIs(id, true);
  scrollY = 600;
  await scrollWatchTicks(3);
  snapshot.mockClear();
  await scrollWatchTicks(3);
  expect(snapshot).not.toHaveBeenCalled();
});

test("a loaded page's scroll takes one quiet-page picture when it rests, kept current for the tab switcher and not counted as a picture of a loading page", async () => {
  const id = front();
  pageIs(id, false);
  await scrollWatchTicks(2);
  snapshot.mockClear();
  counted.mockClear();
  scrollY = 2400;
  await scrollWatchTicks(2);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(snapshot.mock.calls[0]![0]).toBe(id);
  expect(counted).not.toHaveBeenCalledWith("page_pictures_scrolled");
  snapshot.mockClear();
  await scrollWatchTicks(3);
  expect(snapshot).not.toHaveBeenCalled();
});

test("a page that finishes loading after its scroll settled keeps the picture its load ends with", async () => {
  const id = front();
  pageIs(id, true);
  scrollY = 1200;
  await scrollWatchTicks(2);
  snapshot.mockClear();
  pageIs(id, false);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await act(async () => undefined);
  expect(snapshot).toHaveBeenCalledTimes(1);
});

test("no picture is taken while something covers the page, such as the search tray", async () => {
  const id = front();
  pageIs(id, true);
  await scrollWatchTicks(2);
  snapshot.mockClear();
  act(() => browse.useBrowse.setState({ surface: "deck" }));
  scrollY = 3000;
  await scrollWatchTicks(2);
  expect(snapshot).not.toHaveBeenCalled();
});

test("a scroll saved by another path before the watch sees it, such as the save after a typed visit, still gets its picture", async () => {
  const id = front();
  pageIs(id, true);
  await scrollWatchTicks(2);
  snapshot.mockClear();
  scrollY = 1500;
  await act(async () => {
    await saveTabPosition(id);
  });
  await scrollWatchTicks(2);
  expect(snapshot).toHaveBeenCalledTimes(Platform.OS === "android" ? 1 : 0);
});

test("a capture whose tab closes before it lands publishes nothing and isn't counted", async () => {
  const id = front();
  act(() => updateTabById(id, { snapshotFileName: "file:///p/old.jpg" }));
  pageIs(id, true);
  await scrollWatchTicks(2);
  counted.mockClear();
  jest.spyOn(pages, "close").mockImplementation(async () => undefined);
  jest.spyOn(pages, "deleteSnapshots").mockImplementation(async () => undefined);
  snapshot.mockImplementation(async () => {
    closeTabById(id);
    return null as never;
  });
  scrollY = 2100;
  await scrollWatchTicks(2);
  expect(counted).not.toHaveBeenCalledWith("page_pictures_scrolled");
});

test("a refused capture isn't counted even when another capture changes the tab's picture meanwhile", async () => {
  const id = front();
  pageIs(id, true);
  await scrollWatchTicks(2);
  counted.mockClear();
  snapshot.mockImplementation(async () => {
    updateTabById(id, { snapshotFileName: "file:///p/from-another-capture.jpg" });
    return { refused: "blank" } as never;
  });
  scrollY = 2700;
  await scrollWatchTicks(2);
  expect(counted).not.toHaveBeenCalledWith("page_pictures_scrolled");
});

test("the picture is asked for from the same check that read the resting place, before the position saves, so a scroll during the save gets its own picture", async () => {
  const id = front();
  pageIs(id, true);
  await scrollWatchTicks(2);
  snapshot.mockClear();
  let moved = false;
  const save = jest.spyOn(pages, "saveState").mockImplementation(async () => {
    if (!moved && scrollY === 1900) {
      moved = true;
      scrollY = 2600;
    }
    return `state-at-${scrollY}`;
  });
  save.mockClear();
  scrollY = 1900;
  await scrollWatchTicks(2);
  expect(moved).toBe(true);
  if (Platform.OS !== "android") {
    expect(snapshot).not.toHaveBeenCalled();
    return;
  }
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(snapshot.mock.invocationCallOrder[0]!).toBeLessThan(save.mock.invocationCallOrder[0]!);
  await scrollWatchTicks(2);
  expect(snapshot).toHaveBeenCalledTimes(2);
});

test("a capture that finishes after Incognito came on isn't counted", async () => {
  const id = front();
  pageIs(id, true);
  await scrollWatchTicks(2);
  counted.mockClear();
  snapshot.mockClear();
  snapshot.mockImplementation(async (tab: string) => {
    useTabs.setState({ incognito: true });
    generation += 1;
    return { path: "", uri: `file:///p/${tab}-${generation}.jpg`, width: 600, height: 1333, durable: true, generation } as never;
  });
  scrollY = 3300;
  await scrollWatchTicks(2);
  expect(snapshot).toHaveBeenCalledTimes(Platform.OS === "android" ? 1 : 0);
  expect(counted).not.toHaveBeenCalledWith("page_pictures_scrolled");
});

test("on iPhone a resting scroll comes from the page's own report, not a poll, and its picture is asked for quietly, so the copy at a Tabs press stays the only one drawn on the spot", async () => {
  if (!SCROLL_REST_IS_REPORTED) return;
  const id = front();
  pageIs(id, false);
  await scrollWatchTicks(1);
  snapshot.mockClear();
  scrollY = 3200;
  await act(async () => {
    jest.advanceTimersByTime(10_000);
  });
  expect(snapshot).not.toHaveBeenCalled();
  await scrollWatchTicks(1);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(snapshot.mock.calls[0]![1]).toMatchObject({ quiet: true });
});
