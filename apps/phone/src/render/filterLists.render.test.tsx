import { act, type ReactTestInstance } from "react-test-renderer";
import { getAnimatedStyle } from "react-native-reanimated";
import { FilterListsPage } from "../components/settings/BlockingPages";
import * as settingsActions from "../state/settings/actions";
import { useBlocking } from "../state/settings/actions";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const list = (id: string, state: string, isEnabled = true) => ({
  id,
  title: `List ${id}`,
  group: "Ads",
  category: "ads",
  sourceUrl: null,
  supportUrl: null,
  languages: [],
  isEnabled,
  isDefault: true,
  isCustom: false,
  ruleCount: 1200,
  skippedCount: 0,
  updatedAt: 1,
  state,
  failure: null,
});

let updating: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBlocking.setState({
    busy: false,
    state: {
      isEnabled: true,
      blocksAds: true,
      blocksTrackers: true,
      hidesCookieBanners: true,
      exemptHosts: [],
      status: "ready",
      failure: null,
      isUpdating: false,
      isOffline: false,
      lastUpdated: 1,
      enabledRuleCount: 2400,
      buildError: null,
      myFilters: "",
      myFiltersRuleCount: 0,
      lists: [list("a", "ready"), list("b", "downloading")],
    } as never,
  });
  updating = jest.spyOn(settingsActions, "updateLists").mockImplementation(async () => false);
});

afterEach(() => {
  updating.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const scrollView = (root: ReturnType<typeof renderSurface>): ReactTestInstance =>
  root.root.findAll((node) => typeof node.props.onScroll === "function" && node.props.refreshControl !== undefined)[0]!;
const title = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "settingsTitle" && typeof node.type === "string")[0]!;

test("pulling Filter Lists updates them", async () => {
  const root = renderSurface(<FilterListsPage />);
  await act(async () => scrollView(root).props.refreshControl.props.onRefresh());
  expect(updating).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("the top bar shows the title only once the hero has scrolled 150 points away", () => {
  const root = renderSurface(<FilterListsPage />);
  expect(getAnimatedStyle(title(root)).opacity).toBe(0);
  act(() => scrollView(root).props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 200 } } }));
  act(() => jest.advanceTimersByTime(1000));
  expect(getAnimatedStyle(title(root)).opacity).toBeCloseTo(1, 2);
  act(() => scrollView(root).props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 40 } } }));
  act(() => jest.advanceTimersByTime(1000));
  expect(getAnimatedStyle(title(root)).opacity).toBeCloseTo(0, 2);
  unmount(root);
});

test("a downloading list shows a spinner and keeps its switch usable, and its facts line crossfades", () => {
  const root = renderSurface(<FilterListsPage />);
  const host = (testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
  expect(host("listBusy")).toHaveLength(1);
  const switches = root.root.findAll((node) => node.props.accessibilityRole === "switch" && typeof node.props.onPress === "function");
  expect(switches.length).toBeGreaterThan(1);
  for (const toggle of switches) expect(Boolean(toggle.props.disabled ?? toggle.props.accessibilityState?.disabled)).toBe(false);
  expect(host("listFacts")).toHaveLength(2);
  expect(root.root.findAll((node) => node.props.testID === "listFacts" && node.props.exiting !== undefined).length).toBeGreaterThan(0);
  unmount(root);
});
