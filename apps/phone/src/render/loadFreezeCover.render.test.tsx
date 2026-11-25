import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { NO_LAUNCH_ARGUMENTS } from "../lib/launchArguments";
import * as launchFlags from "../state/app/launchFlags";
import { useBrowse } from "../state/browse/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const settled = { isLive: true, isLoading: false, url: "https://site0.example/", title: "Site 0", failure: null, progress: 1 } as unknown as PageState;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useTabs.setState((state) => ({ open: state.open.map((tab) => ({ ...tab, snapshotFileName: "file:///snapshots/t0.jpg" })) }));
  usePages.setState({ navigation: {}, tones: {} });
  useBrowse.setState({ surface: "browsing" });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const cover = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")[0];

test("under BrowseLoadFreeze the page stays behind the tab's loading placeholder, not its snapshot, however the page loads, as Compose's capture shows", () => {
  jest.spyOn(launchFlags, "launchArguments").mockImplementation(() => ({ ...NO_LAUNCH_ARGUMENTS, loadFreeze: 0.4 }));
  const tab = currentTabs().open[0]!;
  act(() => storeNavigation(tab.id, settled));
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(5000));
  const shown = cover(root);
  expect(shown).toBeDefined();
  expect(shown!.findAll((node) => node.props.source?.uri === "file:///snapshots/t0.jpg")).toHaveLength(0);
  unmount(root);
});

test("without it, a settled page with a snapshot needs no cover", () => {
  const tab = currentTabs().open[0]!;
  act(() => storeNavigation(tab.id, settled));
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(5000));
  expect(cover(root)).toBeUndefined();
  unmount(root);
});
