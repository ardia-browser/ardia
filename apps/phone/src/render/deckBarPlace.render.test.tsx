import { Dimensions, Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider, tabsLayout } from "../components/ui";
import { setRootSize, useRootSize } from "../state/app/rootSize";
import { useArchiveCard } from "../state/browse/archiveCard";
import { useBrowse } from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const SCREEN = { width: 374, height: 831 };
const STATUS_BAR = 35.7;

type Shape = { name: string; navigation: number; windowHeight: number };

const THREE_BUTTONS: Shape = { name: "three-button navigation", navigation: 46.4, windowHeight: SCREEN.height - STATUS_BAR - 46.4 };
const GESTURES: Shape = { name: "gesture navigation", navigation: 16, windowHeight: SCREEN.height - STATUS_BAR };

const realWindow = Dimensions.get("window");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null });
});

afterEach(() => {
  useArchiveCard.setState({ showing: false });
  useRootSize.setState({ width: 0, height: 0 });
  Dimensions.set({ window: realWindow, screen: realWindow });
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function onPhone(shape: Shape) {
  const window = { ...SCREEN, height: shape.windowHeight, scale: 2.8875, fontScale: 1 };
  Dimensions.set({ window, screen: { ...window, height: SCREEN.height } });
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: STATUS_BAR, bottom: shape.navigation, left: 0, right: 0 }));
  setRootSize(SCREEN.width, SCREEN.height);
}

const originalDeck = () => (
  <DesignProvider design="original">
    <TabDeck />
  </DesignProvider>
);

function barCenterY(root: ReturnType<typeof renderSurface>) {
  let bar = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.type === "string")[0]!.parent;
  while (bar && StyleSheet.flatten(bar.props.style)?.position !== "absolute") bar = bar.parent;
  return (StyleSheet.flatten(bar!.props.style).top as number) + tabsLayout.barPlus.height / 2 + 2;
}

const composeCenterFromBottom = (navigation: number) => Math.max(navigation, 20) + 6;
const expectedCenterFromBottom = (navigation: number) => (Platform.OS === "android" && navigation > 32 ? navigation + 22 + 6 : composeCenterFromBottom(navigation));

test.each([THREE_BUTTONS, GESTURES])("with $name the deck bar is placed from the screen the deck covers, not from a window that leaves out the system bars", (shape) => {
  onPhone(shape);
  const root = renderSurface(originalDeck());
  const fromBottom = SCREEN.height - barCenterY(root);
  expect(fromBottom).toBeCloseTo(expectedCenterFromBottom(shape.navigation), 1);
  expect(fromBottom).toBeLessThan(shape.navigation + 40);
  unmount(root);
});

test("on gesture navigation the bar sits exactly where Compose's does: max(inset, 20) + 6 above the screen's bottom", () => {
  onPhone(GESTURES);
  const root = renderSurface(originalDeck());
  expect(SCREEN.height - barCenterY(root)).toBeCloseTo(composeCenterFromBottom(GESTURES.navigation), 1);
  unmount(root);
});

test("with three-button navigation the Archive card still sits just above the bar", () => {
  onPhone(THREE_BUTTONS);
  useArchiveCard.setState({ showing: true });
  const root = renderSurface(originalDeck());
  const place = StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "archiveCardPlace" && typeof node.type === "string")[0]!.props.style);
  const barTop = barCenterY(root) - tabsLayout.barPlus.height / 2 - 2;
  expect(place.height).toBeLessThan(barTop);
  expect(barTop - (place.height as number)).toBeLessThan(12);
  unmount(root);
});
