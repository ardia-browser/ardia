import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import { DesignProvider } from "../components/ui";
import { pages } from "../platform/pages";
import * as system from "../platform/system";
import * as browse from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null });
  jest.spyOn(system, "prefetchImage").mockImplementation(async () => true);
  jest.spyOn(pages, "close").mockImplementation(async () => undefined);
  jest.spyOn(browse, "keepFrontPictureCurrent").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const tick = async (ms: number) => {
  for (let at = 0; at < ms; at += 16) {
    await act(async () => {
      jest.advanceTimersByTime(16);
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    });
  }
};

const settledPage = (id: string) => act(() => browse.pageStateChanged(id, { url: "https://site0.example/", title: "Site 0", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));

onAndroid("on Android a deck entrance's late capture or its hold only lets go of its own leaving page: closing the deck and opening it again on the same tab keeps the second entrance's page until that entrance is done with it", async () => {
  const id = currentTabs().selectedId!;
  settledPage(id);
  const captures: ((snapshot: unknown) => void)[] = [];
  jest.spyOn(pages, "snapshot").mockImplementation(() => new Promise((resolve) => captures.push(resolve)) as never);
  const root = renderSurface(
    <DesignProvider design="original">
      <Surfaces />
    </DesignProvider>,
    { flushTimers: false },
  );
  act(() => jest.advanceTimersByTime(1000));
  await act(async () => void browse.showDeck());
  await tick(260);
  expect(captures).toHaveLength(1);
  expect(browse.useBrowse.getState().leaving).toBe(id);
  act(() => browse.openTab(id));
  settledPage(id);
  await tick(100);
  await act(async () => void browse.showDeck());
  await tick(60);
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(browse.useBrowse.getState().leaving).toBe(id);
  await act(async () => {
    captures[0]!(null);
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  });
  expect(browse.useBrowse.getState().leaving).toBe(id);
  await tick(150);
  expect(browse.useBrowse.getState().leaving).toBe(id);
  await tick(600);
  expect(browse.useBrowse.getState().leaving).toBeNull();
  unmount(root);
});

test("a picture taken for the deck after the deck has started covering the page never falls back to copying the window, which would show the deck; the page's own pictures still may", async () => {
  const id = currentTabs().selectedId!;
  settledPage(id);
  const snapshot = jest.spyOn(pages, "snapshot").mockImplementation(() => new Promise(() => undefined) as never);
  const root = renderSurface(
    <DesignProvider design="original">
      <Surfaces />
    </DesignProvider>,
    { flushTimers: false },
  );
  await tick(1000);
  await act(async () => void browse.showDeck());
  await tick(400);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(snapshot.mock.calls[0]![1]).toMatchObject({ windowCopy: false });
  await act(async () => void browse.captureSnapshot(currentTabs().open.find((tab) => tab.id !== id)!.id));
  expect(snapshot.mock.calls[1]![1]).not.toMatchObject({ windowCopy: false });
  unmount(root);
});
