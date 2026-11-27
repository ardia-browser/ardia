import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { useBrowse } from "../state/browse/store";
import { usePages } from "../state/pages/store";
import { useSync } from "../state/sync/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const profile = (syncId: string, name: string, color: string) => ({ syncId, name, color, icon: null, isDefault: syncId === "work", theme: null, deviceTabs: [], pinned: { tiles: [], sections: [] }, bookmarks: [], history: [], sendTargets: null });

const showSpace = (id: string) =>
  useSync.setState((state) => ({
    ...state,
    status: { ...state.status, isEnabled: true, phase: "idle" } as never,
    view: { devices: [], profiles: [profile("work", "Work", "blue"), profile("personal", "Personal", "pink")], search: null, syncedAt: 1, selectedProfileId: id, shownProfileId: id } as never,
  }));

const summaryLooks = (root: ReturnType<typeof renderSurface>, tabId: string) =>
  root.root.findAll((node) => typeof node.type !== "string" && node.props.pageId === tabId && "onPageState" in node.props).map((node) => node.props.summaryLook);

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState({ navigation: {}, tones: {} });
  useBrowse.setState({ surface: "browsing" });
});
afterEach(() => jest.useRealTimers());

test("a page's summary takes the look of the space it's shown in, even after another space was looked at first", () => {
  showSpace("work");
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  expect(summaryLooks(root, tab.id)).toEqual([expect.objectContaining({ color: "blue", dark: false })]);
  act(() => {
    showSpace("personal");
  });
  expect(summaryLooks(root, tab.id)).toEqual([expect.objectContaining({ color: "pink", dark: false })]);
  unmount(root);
});
