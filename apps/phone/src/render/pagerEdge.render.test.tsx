import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { useBrowse } from "../state/browse/store";
import { currentTabs, selectTabById } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("each incoming pager card carries Compose's 36-point edge shadow on the side that meets the page, hidden until a swipe brings it in", () => {
  const tab = currentTabs().open.find((candidate) => candidate.id === currentTabs().selectedId)!;
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />);
  const edges = root.root.findAll((node) => node.props.testID === "pagerEdgeShadow" && typeof node.type === "string");
  expect(edges.length).toBeGreaterThanOrEqual(1);
  for (const edge of edges) {
    const style = StyleSheet.flatten(edge.props.style);
    expect(style.width).toBe(36);
    expect(String(style.experimental_backgroundImage)).toContain("rgba(0,0,0,0.26)");
  }
  unmount(root);
});
