import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { BottomBar } from "../components/browsing/BottomBar";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { DesignProvider } from "../components/ui";
import { barHeight, pageBarCenterFromBottom } from "../components/ui/barGeometry";
import { currentTabs } from "../state/tabs/store";
import { useBrowse } from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const HOME_INDICATOR = 34;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("on iPhone the page bar's buttons sit 44 points above the screen's edge, as SwiftUI's do, whatever the home indicator's inset", () => {
  expect(pageBarCenterFromBottom(HOME_INDICATOR, "ios")).toBe(44);
  expect(pageBarCenterFromBottom(0, "ios")).toBe(44);
});

test("on Android the bar still lifts above three-button navigation, and with gestures it keeps Compose's 44", () => {
  expect(pageBarCenterFromBottom(48, "android")).toBe(70);
  expect(pageBarCenterFromBottom(16, "android")).toBe(44);
});

test("in the original design the bar on screen takes this phone's rule: its controls' bottom edge is the centre less half a button", () => {
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 47, bottom: HOME_INDICATOR, left: 0, right: 0 }));
  const tab = currentTabs().open[0]!;
  const root = renderSurface(
    <DesignProvider design="original">
      <BrowsingScreen tab={tab} />
    </DesignProvider>,
  );
  const bar = root.root.findAll((node) => node.type === BottomBar)[0]!;
  let controls = bar.parent;
  while (controls && (typeof controls.type !== "string" || StyleSheet.flatten(controls.props.style)?.bottom === undefined)) controls = controls.parent;
  const centre = Platform.OS === "ios" ? 44 : pageBarCenterFromBottom(HOME_INDICATOR, "android");
  expect(StyleSheet.flatten(controls!.props.style).bottom).toBe(centre - 22);
  expect(barHeight(HOME_INDICATOR, "original")).toBe(Platform.OS === "ios" ? 75 : 75 + centre - 44);
  unmount(root);
});
