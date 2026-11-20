import { Platform } from "react-native";
import { act } from "react-test-renderer";
import "../platform/copy";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { FloatingMenu, type MenuItem } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  useTabs.setState((state) => ({ open: state.open.map((tab, index) => (index === 0 ? { ...tab, title: "", url: "data:text/html,otter" } : tab)) }));
  useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("the recent-tabs menu lists a tab with no title or host by its address on Android, as Compose does, and as New Tab on iPhone, as SwiftUI does", async () => {
  const selected = currentTabs().open.find((tab) => tab.id === currentTabs().selectedId)!;
  const root = renderSurface(<BrowsingScreen tab={selected} />);
  const tabs = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onLongPress === "function")[0]!;
  act(() => tabs.props.onLongPress());
  await act(async () => undefined);
  const drawn = root.root.findAll((node) => node.type === FloatingMenu)[0];
  const text = drawn ? (drawn.props.items as MenuItem[]).map((item) => (typeof item === "object" && "label" in item ? item.label : "")).join("\n") : textOf(root);
  if (Platform.OS === "android") {
    expect(text).toContain("data:text/html,otter");
  } else {
    expect(text).toContain("New Tab");
    expect(text).not.toContain("data:text/html,otter");
  }
  unmount(root);
});
