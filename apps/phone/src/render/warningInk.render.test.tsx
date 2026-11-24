import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SyncHero } from "../components/sync/SyncPage";
import { useTheme } from "../components/ui";
import { legibleInk } from "../lib/color";
import { renderSurface, unmount } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("a sync warning reads in the native apps' orange made legible on its surface, not the destructive red", () => {
  let theme: ReturnType<typeof useTheme> | null = null;
  function Probe() {
    theme = useTheme();
    return null;
  }
  const root = renderSurface(
    <>
      <Probe />
      <SyncHero title="Sync With Mac" subtitle="Choose Your Sync Folder Again" warning />
    </>,
  );
  const subtitle = root.root.findAll((node) => typeof node.type === "string" && node.type === "Text" && node.children.includes("Choose Your Sync Folder Again"))[0]!;
  const color = StyleSheet.flatten(subtitle.props.style).color;
  expect(color).toBe(legibleInk("#FF9500", theme!.dark));
  expect(color).not.toBe(theme!.destructive);
  unmount(root);
});
