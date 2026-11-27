import { Platform } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { neighbours } from "../lib/pagerPhysics";
import { TAB_SWIPE_HINT } from "../components/browsing/tabSwipeHint";
import * as browse from "../state/browse/store";
import { useSettingsNav } from "../state/settings/nav";
import { currentPreferences, setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { currentTabs, selectTabById, useTabs } from "../state/tabs/store";
import { launchTabs } from "../state/tabs/tabsState";
import { useToasts } from "../state/toasts/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, someTabs, unmount, withTabs } from "../../test/render/harness";

let mockReportsDrawn = true;

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  return { ...actual, pageReportsDrawn: () => mockReportsDrawn };
});

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  mockReportsDrawn = true;
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  useToasts.setState({ toast: null });
  setPreference("tabSwipeHintShown", true);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function Page() {
  const tab = useSelectedTab();
  return tab ? <BrowsingScreen tabId={tab.id} /> : null;
}

const neighbour = () => {
  const around = neighbours(browse.swipeOrder(), currentTabs().selectedId);
  return around.right ? { id: around.right, dx: -1 } : { id: around.left!, dx: 1 };
};

function swipeToNeighbour(root: ReactTestRenderer) {
  const { dx } = neighbour();
  act(() =>
    fireGestureHandler(getByGestureTestId("tabPager"), [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, translationX: dx * 20, translationY: 0, velocityX: dx * 1600, velocityY: 0 },
      { state: State.ACTIVE, translationX: dx * 260, translationY: 0, velocityX: dx * 1600, velocityY: 0 },
      { state: State.END, translationX: dx * 260, translationY: 0, velocityX: dx * 1600, velocityY: 0 },
    ]),
  );
  const from = currentTabs().selectedId;
  for (let frame = 0; frame < 120 && currentTabs().selectedId === from; frame++) act(() => jest.advanceTimersByTime(16));
}

const hosts = (root: ReactTestRenderer, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const pageCoverId = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.props.coverNativeId !== "undefined" || (typeof node.type !== "string" && "coverNativeId" in node.props)).map((node) => node.props.coverNativeId)[0];

test("where the page reports its first draw, a landed swipe keeps the arriving tab's card over its page, under a cover id of its own for this arrival, until the page draws it, then takes it away, ignoring a report for an earlier arrival", () => {
  const right = neighbour().id;
  const root = renderSurface(<Page />);
  swipeToNeighbour(root);
  expect(currentTabs().selectedId).toBe(right);
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: right, covered: right });
  const arrival = hosts(root, "pagerArrival");
  expect(arrival).toHaveLength(1);
  const cover = browse.useBrowse.getState().arrivalCover!;
  expect(cover.startsWith(browse.ARRIVAL_COVER_ID)).toBe(true);
  expect(arrival[0]!.props.nativeID).toBe(cover);
  expect(pageCoverId(root)).toBe(cover);
  act(() => browse.pageCoverHidden(right, "drawn", `${browse.ARRIVAL_COVER_ID}-stale`, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: right, covered: right });
  act(() => browse.pageCoverHidden(right, "drawn", cover, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, covered: null });
  expect(hosts(root, "pagerArrival")).toHaveLength(0);
  expect(pageCoverId(root)).toBeUndefined();
  expect(counted).toHaveBeenCalledWith("tabs_bar_swiped");
  unmount(root);
});

test("an arrival the page never reports drawn is still taken away after 400 ms", () => {
  const right = neighbour().id;
  const root = renderSurface(<Page />);
  swipeToNeighbour(root);
  expect(browse.useBrowse.getState().arriving).toBe(right);
  act(() => jest.advanceTimersByTime(400));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, covered: null });
  if (Platform.OS === "ios") expect(counted).toHaveBeenCalledWith("page_covers_capped");
  else expect(counted).not.toHaveBeenCalledWith("page_covers_capped");
  unmount(root);
});

test("where the page can't report its first draw, a landed swipe switches tabs as before, with no arrival card and no cover id", () => {
  mockReportsDrawn = false;
  const right = neighbour().id;
  const root = renderSurface(<Page />);
  swipeToNeighbour(root);
  expect(currentTabs().selectedId).toBe(right);
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, covered: null });
  expect(hosts(root, "pagerArrival")).toHaveLength(0);
  expect(counted).toHaveBeenCalledWith("tabs_bar_swiped");
  unmount(root);
});

test("a swipe from an Incognito tab isn't counted", () => {
  const privates = someTabs(3, true);
  act(() => useTabs.setState({ ...launchTabs([], 0), privates, selectedId: privates[1]!.id, incognito: true, listing: 0 }));
  const root = renderSurface(<Page />);
  swipeToNeighbour(root);
  expect(counted).not.toHaveBeenCalledWith("tabs_bar_swiped");
  unmount(root);
});

const loaded = (id: string) => act(() => browse.pageStateChanged(id, { url: "https://site.example/", title: "Site", isLoading: false, isLive: true, canGoBack: false, canGoForward: false } as never));

test("on Android, the first loaded page with a neighbour shows the bar swipe once: the page peeks toward the next tab and a toast names the swipe; on iPhone it never does", () => {
  setPreference("tabSwipeHintShown", false);
  const root = renderSurface(<Page />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(TAB_SWIPE_HINT.delayMs + 10));
  expect(useToasts.getState().toast).toBeNull();
  loaded(currentTabs().selectedId!);
  act(() => jest.advanceTimersByTime(TAB_SWIPE_HINT.delayMs + 10));
  if (Platform.OS === "android") {
    expect(useToasts.getState().toast?.message).toBe(TAB_SWIPE_HINT.text);
    expect(currentPreferences().tabSwipeHintShown).toBe(true);
    expect(counted).toHaveBeenCalledWith("tab_swipe_hints_shown");
  } else {
    expect(useToasts.getState().toast).toBeNull();
    expect(currentPreferences().tabSwipeHintShown).toBe(false);
  }
  unmount(root);
});

test("a step to the next tab that isn't a swipe, such as VoiceOver's Next Tab, isn't counted as one", () => {
  const right = neighbour().id;
  const root = renderSurface(<Page />);
  act(() => browse.switchToNeighbour(right));
  expect(currentTabs().selectedId).toBe(right);
  expect(counted).not.toHaveBeenCalledWith("tabs_bar_swiped");
  unmount(root);
});

test("the hint waits while Settings covers the page, and shows once it closes", () => {
  setPreference("tabSwipeHintShown", false);
  const root = renderSurface(<Page />, { flushTimers: false });
  loaded(currentTabs().selectedId!);
  act(() => useSettingsNav.setState({ open: true }));
  act(() => jest.advanceTimersByTime(TAB_SWIPE_HINT.delayMs * 2 + 10));
  expect(currentPreferences().tabSwipeHintShown).toBe(false);
  expect(useToasts.getState().toast).toBeNull();
  act(() => useSettingsNav.setState({ open: false }));
  act(() => jest.advanceTimersByTime(TAB_SWIPE_HINT.delayMs + 10));
  if (Platform.OS === "android") expect(useToasts.getState().toast?.message).toBe(TAB_SWIPE_HINT.text);
  else expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("someone who already swipes between tabs never sees the hint", () => {
  setPreference("tabSwipeHintShown", false);
  const root = renderSurface(<Page />, { flushTimers: false });
  swipeToNeighbour(root);
  expect(currentPreferences().tabSwipeHintShown).toBe(true);
  loaded(currentTabs().selectedId!);
  act(() => jest.advanceTimersByTime(TAB_SWIPE_HINT.delayMs + 10));
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("in a quick swipe there and back, the first arrival's late draw report can't end the second arrival", () => {
  const first = currentTabs().selectedId!;
  const right = neighbour().id;
  const root = renderSurface(<Page />);
  swipeToNeighbour(root);
  const earlier = browse.useBrowse.getState().arrivalCover!;
  expect(currentTabs().selectedId).toBe(right);
  swipeToNeighbour(root);
  const later = browse.useBrowse.getState().arrivalCover!;
  expect(later).not.toBe(earlier);
  const arrived = currentTabs().selectedId!;
  act(() => browse.pageCoverHidden(arrived, "drawn", earlier, true, 1));
  expect(browse.useBrowse.getState().arriving).toBe(arrived);
  act(() => browse.pageCoverHidden(arrived, "drawn", later, true, 1));
  expect(browse.useBrowse.getState().arriving).toBeNull();
  expect(first).toBeDefined();
  unmount(root);
});

test("on both phones an arrival is only handed over by a report that names it and says its card was hidden; a report that came before the wait still counts", () => {
  const right = neighbour().id;
  const root = renderSurface(<Page />);
  swipeToNeighbour(root);
  const cover = browse.useBrowse.getState().arrivalCover!;
  act(() => browse.pageCoverHidden(right, "cap", cover, false, 1));
  expect(browse.useBrowse.getState().arriving).toBe(right);
  act(() => browse.pageCoverHidden(right, "drawn"));
  expect(browse.useBrowse.getState().arriving).toBe(right);
  act(() => browse.pageCoverHidden(right, "drawn", cover, true, 1));
  expect(browse.useBrowse.getState().arriving).toBeNull();
  unmount(root);
  let finished: string | null = null;
  browse.pageCoverHidden("early-page", "drawn", "openingCover-early", true, 1);
  browse.whenPageCoverHidden("early-page", 400, (reason) => (finished = reason), "openingCover-early");
  expect(finished).toBe("drawn");
});
