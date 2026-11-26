import { Platform } from "react-native";
import type { ReactTestInstance } from "react-test-renderer";
import { act } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { ArchiveView } from "../components/tabs/ArchiveView";
import * as settingsActions from "../state/settings/actions";
import { openSettings } from "../state/settings/nav";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const hidden = (node: ReactTestInstance | null): boolean => {
  for (let at = node?.parent ?? null; at; at = at.parent) {
    if (at.props.accessibilityElementsHidden === true || at.props.importantForAccessibility === "no-hide-descendants") return true;
  }
  return false;
};

const exposed = (root: ReturnType<typeof renderSurface>, label: string) =>
  root.root.findAll((node) => typeof node.type === "string" && !hidden(node) && (node.props.accessibilityLabel === label || (node.type === "Text" && node.props.children === label)));

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const SUGGESTIONS_ROW = "Search suggestions, Suggestions from your search engine as you type.";

onAndroid("on the hand-built Settings Android keeps, a switch row is one screen-reader element with the switch role, and the whole row toggles, as Compose's toggleable row", () => {
  const setting = jest.spyOn(settingsActions, "setSearchSuggestions").mockImplementation(() => undefined);
  openSettings({ page: "search" });
  const root = renderSurface(<SettingsView />);
  const nodes = exposed(root, SUGGESTIONS_ROW);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.props.accessibilityRole).toBe("switch");
  expect(nodes[0]!.props.accessibilityState).toMatchObject({ checked: expect.any(Boolean) });
  const row = root.root.findAll((node) => node.props.accessibilityLabel === SUGGESTIONS_ROW && typeof node.props.onPress === "function")[0]!;
  act(() => row.props.onPress());
  expect(setting).toHaveBeenCalledTimes(1);
  setting.mockRestore();
  unmount(root);
});

test("the Archive's empty state reads its line along with its title, so it can't be skipped", () => {
  const root = renderSurface(<ArchiveView />);
  act(() => jest.advanceTimersByTime(500));
  const empty = root.root.findAll((node) => typeof node.type === "string" && !hidden(node) && typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.includes("Closed and inactive tabs show up here."));
  expect(empty).toHaveLength(1);
  expect(empty[0]!.props.accessible).toBe(true);
  unmount(root);
});
