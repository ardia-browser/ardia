import { act } from "react-test-renderer";
import { BottomBar } from "../components/browsing/BottomBar";
import { FloatingMenu, rolesFor } from "../components/ui";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("the Tabs button offers its long-press menu, a plain activate and the tab steps to a screen reader, as both native apps do, its menu drawn where the system has none", () => {
  const calls: string[] = [];
  const root = renderSurface(
    <BottomBar
      order={currentTabs().open}
      roles={rolesFor(false)}
      showsPlus
      onTabs={() => calls.push("tabs")}
      onTabsMenu={() => calls.push("menu")}
      onStep={(delta) => calls.push(`step ${delta}`)}
      onPlus={() => undefined}
      onMore={() => undefined}
    />,
  );
  const tabs = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onAccessibilityAction === "function")[0]!;
  const ios = require("react-native").Platform.OS === "ios";
  expect(tabs.props.accessibilityActions).toEqual(
    ios
      ? [{ name: "Recent Tabs" }, { name: "Previous Tab" }, { name: "Next Tab" }]
      : [{ name: "activate" }, { name: "longpress", label: "Recent Tabs" }, { name: "previousTab", label: "Previous Tab" }, { name: "nextTab", label: "Next Tab" }],
  );
  expect(tabs.props.accessibilityValue).toEqual({ text: "3 tabs" });
  for (const actionName of ios ? ["Recent Tabs"] : ["longpress"]) act(() => tabs.props.onAccessibilityAction({ nativeEvent: { actionName } }));
  if (ios) act(() => tabs.props.onAccessibilityTap());
  else act(() => tabs.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }));
  for (const actionName of ios ? ["Previous Tab", "Next Tab"] : ["previousTab", "nextTab"]) act(() => tabs.props.onAccessibilityAction({ nativeEvent: { actionName } }));
  expect(calls).toEqual(["tabs", "step -1", "step 1"]);
  expect(root.root.findAll((node) => node.type === FloatingMenu)).toHaveLength(1);
  unmount(root);
});
