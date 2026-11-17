import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { StartScreen } from "../components/search/StartScreen";
import { SearchTray } from "../components/search/SearchTray";
import { TabDeck } from "../components/tabs/TabDeck";
import { useTheme } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import { presentSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

let theme: ReturnType<typeof useTheme> | null = null;
function ThemeProbe() {
  theme = useTheme();
  return null;
}

const bases = (root: Root) => root.root.findAll((node) => node.props.testID === "backdropBase" && typeof node.type === "string").map((node) => StyleSheet.flatten(node.props.style).backgroundColor);

test("at launch, the tray over the start screen has the start backdrop's own colour under it even before the native backdrop draws its first frame", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  useBrowse.setState({ surface: "start", sheet: null });
  presentSearch("home", "");
  const root = renderSurface(
    <>
      <ThemeProbe />
      <StartScreen />
      <SearchTray />
    </>,
  );
  expect(bases(root)).toEqual([theme!.start.colors[0]]);
  unmount(root);
});

test("the deck's native backdrop has the deck's base colour under it", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(
    <>
      <ThemeProbe />
      <TabDeck />
    </>,
  );
  expect(bases(root)).toContain(theme!.backdrop[0]);
  unmount(root);
});

test("with the look's fallback the gradient is drawn by the app and needs no base", () => {
  useBrowse.setState({ surface: "start", sheet: null });
  const root = renderSurface(<StartScreen />);
  expect(bases(root)).toEqual([]);
  unmount(root);
});

test("the deck's and the start page's frost sources hold only their native backdrop; the base colour sits beside the source, not in it", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const deck = renderSurface(<TabDeck />);
  const sources = deck.root.findAll((node) => node.type === lookModule.FrostSource && node.props.name === "deck");
  expect(sources).toHaveLength(1);
  expect(sources[0]!.findAll((node) => node.props.testID === "backdropBase")).toHaveLength(0);
  expect(sources[0]!.findAll((node) => node.type === lookModule.DeckBackdrop)).toHaveLength(1);
  expect(bases(deck)).toHaveLength(1);
  unmount(deck);
  useBrowse.setState({ surface: "start", sheet: null });
  const start = renderSurface(<StartScreen />);
  const startSources = start.root.findAll((node) => node.type === lookModule.FrostSource);
  expect(startSources.every((source) => source.findAll((node) => node.props.testID === "backdropBase").length === 0)).toBe(true);
  expect(bases(start)).toHaveLength(1);
  unmount(start);
});
