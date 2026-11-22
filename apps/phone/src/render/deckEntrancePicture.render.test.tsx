import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { pages } from "../platform/pages";
import * as system from "../platform/system";
import * as browse from "../state/browse/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";
import { noteSnapshotLoaded, noteSnapshotShown } from "../lib/shownSnapshots";

const EARLIER = "file:///snapshots/t2-earlier.jpg";
const FRESH = "file:///snapshots/t2-fresh.jpg";

let prefetched: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  const selected = currentTabs().selectedId!;
  useTabs.setState((state) => ({ open: state.open.map((tab) => (tab.id === selected ? { ...tab, snapshotFileName: EARLIER, title: "Kernel Archives" } : tab)) }));
  noteSnapshotShown(EARLIER);
  noteSnapshotLoaded(EARLIER);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  act(() => browse.pageStateChanged(selected, { url: "https://kernel.org/", title: "Kernel Archives", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));
  prefetched = [];
  jest.spyOn(system, "prefetchImage").mockImplementation(async (uri: string) => {
    prefetched.push(uri);
    return true;
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const entranceCard = (root: ReturnType<typeof renderSurface>) => {
  const selected = currentTabs().selectedId!;
  const cards = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");
  return cards.find((card) => card.findAll((node) => typeof node.props.source?.uri === "string" && node.props.source.uri.includes("t2-")).length > 0) ?? (selected ? null : null);
};

test("opening the deck from a page switches at once, without waiting for the capture, and the leaving card draws the fresh picture with no placeholder: on iPhone as it lands, on Android once the shrink has landed, so the capture's main-thread work never delays the shrink", async () => {
  const snapshot = jest.spyOn(pages, "snapshot").mockImplementation(async () => ({ uri: FRESH, width: 600, height: 1157 }) as never);
  await act(async () => {
    void browse.showDeck();
  });
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(prefetched).toEqual([]);
  const root = renderSurface(<TabDeck />, { flushTimers: false });
  await act(async () => {});
  if (Platform.OS === "android") {
    expect(snapshot).not.toHaveBeenCalled();
    expect(entranceCard(root)!.findAll((node) => node.props.source?.uri === EARLIER && typeof node.type === "string")).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    await act(async () => {});
    expect(snapshot).toHaveBeenCalled();
  }
  const card = entranceCard(root);
  expect(card).toBeTruthy();
  expect(card!.findAll((node) => node.props.source?.uri === FRESH && typeof node.type === "string")).toHaveLength(1);
  act(() => card!.findAll((node) => node.props.source?.uri === FRESH && typeof node.props.onLoad === "function")[0]!.props.onLoad({ nativeEvent: { source: { width: 600, height: 1157 } } }));
  expect(textOf({ root: card! } as never)).not.toContain("Kernel Archives");
  unmount(root);
});

test("when the fresh capture is slow, the card holds the page's earlier picture rather than the placeholder", async () => {
  jest.spyOn(pages, "snapshot").mockImplementation(() => new Promise(() => undefined) as never);
  await act(async () => {
    void browse.showDeck();
  });
  expect(browse.useBrowse.getState().surface).toBe("deck");
  const root = renderSurface(<TabDeck />, { flushTimers: false });
  const card = entranceCard(root);
  expect(card!.findAll((node) => node.props.source?.uri === EARLIER && typeof node.type === "string")).toHaveLength(1);
  expect(textOf({ root: card! } as never)).not.toContain("Kernel Archives");
  unmount(root);
});
