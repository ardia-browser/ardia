import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";

jest.mock("../platform/system", () => ({ ...jest.requireActual("../platform/system"), displayCornerRadius: () => 30 }));

const { BrowsingScreen } = require("../components/browsing/BrowsingScreen") as typeof import("../components/browsing/BrowsingScreen");
const { useBrowse } = require("../state/browse/store") as typeof import("../state/browse/store");
const { currentTabs, selectTabById } = require("../state/tabs/store") as typeof import("../state/tabs/store");
const { renderSurface, unmount, withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");

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

test("the tab pager rounds its cards to the display's own corner when the phone reports one, as Compose's rememberDisplayCornerRadius does", () => {
  const tab = currentTabs().open.find((candidate) => candidate.id === currentTabs().selectedId)!;
  const root = renderSurface(<BrowsingScreen tab={tab} />);
  const edges = root.root.findAll((node) => node.props.testID === "pagerEdgeShadow" && typeof node.type === "string");
  expect(edges.length).toBeGreaterThanOrEqual(1);
  for (const edge of edges) expect(StyleSheet.flatten(edge.props.style)).toMatchObject({ top: 18, bottom: 18 });
  const cards = root.root.findAll((node) => typeof node.type === "string" && StyleSheet.flatten(node.props.style)?.borderRadius === 30 && StyleSheet.flatten(node.props.style)?.overflow === "hidden");
  expect(cards.length).toBeGreaterThanOrEqual(1);
  unmount(root);
});
