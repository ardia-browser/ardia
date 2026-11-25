import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider } from "../components/ui";
import { useArchiveCard } from "../state/browse/archiveCard";
import { useBrowse } from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null });
  useArchiveCard.setState({ showing: true });
});

const originalDeck = () => (
  <DesignProvider design="original">
    <TabDeck />
  </DesignProvider>
);

afterEach(() => {
  useArchiveCard.setState({ showing: false });
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("the Archive card's bottom edge sits above the deck bar's top, both placed from the top so a three-button navigation bar can't drop the card onto the buttons", () => {
  const root = renderSurface(originalDeck());
  const place = StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "archiveCardPlace" && typeof node.type === "string")[0]!.props.style);
  expect(place.top).toBe(0);
  expect(place.bottom).toBeUndefined();
  const plus = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.type === "string")[0]!;
  let bar = plus.parent;
  while (bar && StyleSheet.flatten(bar.props.style)?.position !== "absolute") bar = bar.parent;
  const barTop = StyleSheet.flatten(bar!.props.style).top as number;
  expect(place.height).toBeLessThan(barTop);
  expect(barTop - (place.height as number)).toBeLessThan(12);
  unmount(root);
});

test("the + menu opens above the + button measured against the deck's real height, which on a three-button phone is taller than the window", () => {
  const root = renderSurface(originalDeck());
  const deck = root.root.findAll((node) => typeof node.type === "string" && typeof node.props.onLayout === "function" && StyleSheet.flatten(node.props.style)?.position === "absolute")[0]!;
  const windowHeight = 873;
  const navigationBar = 48;
  act(() => deck.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: windowHeight + navigationBar } } }));
  const plus = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onLongPress === "function")[0]!;
  act(() => plus.props.onLongPress());
  let bar = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.type === "string")[0]!.parent;
  while (bar && StyleSheet.flatten(bar.props.style)?.position !== "absolute") bar = bar.parent;
  const barTop = StyleSheet.flatten(bar!.props.style).top as number;
  const panel = root.root.findAll((node) => typeof node.type === "string" && typeof StyleSheet.flatten(node.props.style)?.bottom === "number" && StyleSheet.flatten(node.props.style)?.width === 250)[0];
  const menuBottomEdge = windowHeight + navigationBar - (StyleSheet.flatten(panel?.props.style ?? {}).bottom as number);
  expect(menuBottomEdge).toBeLessThanOrEqual(barTop);
  unmount(root);
});
