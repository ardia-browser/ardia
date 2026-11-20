import { act } from "react-test-renderer";
import { FilterListDetailPage } from "../components/settings/BlockingPages";
import * as settingsActions from "../state/settings/actions";
import { useBlocking } from "../state/settings/actions";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const failed = {
  id: "x",
  title: "Extra List",
  group: "Ads",
  category: "ads",
  sourceUrl: "https://lists.example.com/extra/filters.txt",
  supportUrl: "https://lists.example.com/",
  languages: [],
  isEnabled: true,
  isDefault: false,
  isCustom: true,
  ruleCount: 10,
  skippedCount: 0,
  updatedAt: new Date(2026, 10, 14, 15, 30).getTime(),
  state: "failed",
  failure: "The server didn’t answer.",
};

let opening: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBlocking.setState({ busy: false, state: { isUpdating: true, isOffline: false, lastUpdated: 1, enabledRuleCount: 10, lists: [failed], myFiltersRuleCount: 0 } as never });
  opening = jest.spyOn(settingsActions, "openFromSettings").mockImplementation(() => undefined);
});

afterEach(() => {
  opening.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("a failed list shows its failure as a row, Try Again waits for the running update, dates are absolute and the source opens in a tab", () => {
  const root = renderSurface(<FilterListDetailPage id="x" />);
  const failure = root.root.findAll((node) => node.props.testID === "listFailure" && typeof node.type === "string")[0]!;
  expect(textOf({ root: failure } as never)).toContain("The server didn’t answer.");
  const tryAgain = root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as never) === "Try Again")[0]!;
  expect(Boolean(tryAgain.props.disabled ?? tryAgain.props.accessibilityState?.disabled)).toBe(true);
  expect(textOf(root)).toContain("2026");
  expect(textOf(root)).not.toContain("ago");
  const links = root.root.findAll((node) => node.props.accessibilityRole === "link" && typeof node.props.onPress === "function");
  act(() => links.find((link) => textOf({ root: link } as never).includes("filters.txt"))!.props.onPress());
  act(() => links.find((link) => textOf({ root: link } as never) === "Visit the List’s Website")!.props.onPress());
  expect(opening.mock.calls.map((call) => call[0])).toEqual([failed.sourceUrl, failed.supportUrl]);
  unmount(root);
});
