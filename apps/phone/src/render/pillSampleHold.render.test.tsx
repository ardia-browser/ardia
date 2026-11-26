import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { pillSampleHold } from "../components/browsing/HostPill";
import { DesignProvider } from "../components/ui";
import { NO_LAUNCH_ARGUMENTS, parseLaunchArguments } from "../lib/launchArguments";
import * as launchFlags from "../state/app/launchFlags";
import { useBrowse } from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { setPreference } from "../state/settings/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/lab", () => ({ ...jest.requireActual<object>("../platform/lab"), isLabBuild: true }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  setPreference("collapsesBottomBar", true);
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => parseLaunchArguments({ ArdiaPillHold: true }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
  setPreference("collapsesBottomBar", false);
});

const android = Platform.OS === "android";

type Root = ReturnType<typeof renderSurface>;

const scrolled = (scrollDirection: "up" | "down", url = "https://site0.example/") =>
  act(() => storeNavigation(currentTabs().open[0]!.id, { url, title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));

const page = () => {
  scrolled("up");
  return renderSurface(
    <DesignProvider design="redesigned">
      <BrowsingScreen tabId={currentTabs().open[0]!.id} />
    </DesignProvider>,
  );
};

const settle = () => {
  for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
};

const pillGlass = (root: Root) => root.root.findAll((node) => node.props.testID === "hostPill" && node.props.shown !== undefined && typeof node.type !== "string")[0];

const hold = (root: Root) => {
  const glass = pillGlass(root);
  return glass ? (glass.props.sampleHold ?? null) : null;
};

test("the hold key is Android's collapsed pill's alone, and names the tab, its privacy and the bar's tone", () => {
  expect(pillSampleHold(true, true, true, "t1", false, false)).toBe("t1:open:light");
  expect(pillSampleHold(true, true, true, "t1", true, true)).toBe("t1:private:dark");
  expect(pillSampleHold(true, false, true, "t1", false, false)).toBeNull();
  expect(pillSampleHold(true, true, false, "t1", false, false)).toBeNull();
  expect(pillSampleHold(false, true, true, "t1", false, false)).toBeNull();
});

test("with ArdiaPillHold, scrolling the page down arms the collapsed pill's sample hold on Android, and scrolling back up to expand the bar lets it go", () => {
  const root = page();
  expect(hold(root)).toBeNull();
  scrolled("down");
  settle();
  const tab = currentTabs().open[0]!;
  if (android) expect(hold(root)).toMatch(new RegExp(`^${tab.id}:open:(light|dark)$`));
  else expect(hold(root)).toBeNull();
  scrolled("up");
  settle();
  expect(hold(root)).toBeNull();
  unmount(root);
});

test("tapping the pill to bring the bar back lets the hold go at once", () => {
  const root = page();
  scrolled("down");
  settle();
  const button = root.root.findAll((node) => node.props.accessibilityLabel === "Show Toolbar" && typeof node.props.onPress === "function")[0]!;
  act(() => button.props.onPress());
  expect(hold(root)).toBeNull();
  unmount(root);
});

test("without ArdiaPillHold the collapsed pill stays live through a scroll", () => {
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => NO_LAUNCH_ARGUMENTS);
  const root = page();
  scrolled("down");
  settle();
  expect(pillGlass(root)).toBeDefined();
  expect(hold(root)).toBeNull();
  unmount(root);
});
