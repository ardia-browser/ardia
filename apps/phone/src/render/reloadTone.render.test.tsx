import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { useBrowse } from "../state/browse/store";
import { clearTone, storeNavigation, storeTone, type PageState } from "../state/pages/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const colour = (node: ReactTestInstance) => {
  let animated: unknown;
  try {
    animated = getAnimatedStyle(node).backgroundColor;
  } catch {
    animated = undefined;
  }
  return animated ?? StyleSheet.flatten(node.props.style)?.backgroundColor;
};

test("a page that lost its colours and is reloading keeps its last known colours in the status strip and bar until it reports again, instead of the surface's tint", () => {
  const tab = currentTabs().open[0]!;
  act(() => storeTone(tab.id, { top: "#101820", bottom: "#203040" }));
  act(() => clearTone(tab.id));
  act(() => storeNavigation(tab.id, { isLive: true, isLoading: true, url: tab.url, title: tab.title, failure: null, progress: 0.2 } as unknown as PageState));
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  act(() => jest.advanceTimersByTime(2800));
  const painted = root.root.findAll((node) => typeof node.type === "string").map(colour);
  const shows = (hex: string, rgba: string) => painted.some((value) => value === hex || value === rgba);
  expect(shows("#101820", "rgba(16, 24, 32, 1)")).toBe(true);
  expect(shows("#203040", "rgba(32, 48, 64, 1)")).toBe(true);
  unmount(root);
});
