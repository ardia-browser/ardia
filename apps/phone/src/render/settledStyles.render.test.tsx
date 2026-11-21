import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { showDeck, useBrowse } from "../state/browse/store";
import { storeNavigation, type PageState } from "../state/pages/store";
import { dismissSearch, presentSearch } from "../state/search/store";
import { closeSettings } from "../state/settings/nav";
import { setPreference } from "../state/settings/store";
import { currentTabs, updateTabById } from "../state/tabs/store";
import { showToast } from "../state/toasts/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const GEOMETRY = ["opacity", "transform", "top", "left", "right", "bottom", "width", "height", "zIndex", "borderRadius"] as const;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(4);
  closeSettings();
  setPreference("schemeChoice", "light");
  setPreference("collapsesBottomBar", true);
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const animatedGeometry = (root: Root) =>
  root.root
    .findAll((node) => typeof node.type === "string" && node.props.jestAnimatedStyle !== undefined)
    .map((node: ReactTestInstance) => {
      const style = { ...StyleSheet.flatten(node.props.style), ...getAnimatedStyle(node) } as Record<string, unknown>;
      return JSON.stringify([node.props.testID ?? "", GEOMETRY.map((key) => style[key])]);
    });

const page = (scrollDirection: "up" | "down") => ({ url: "https://settled.example/", title: "Settled", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection }) as unknown as PageState;

const frames = (count: number) => {
  for (let frame = 0; frame < count; frame++) act(() => jest.advanceTimersByTime(16));
};

type EndState = { name: string; from?: () => void; reach: () => void };

const END_STATES: EndState[] = [
  { name: "the deck open", reach: () => void showDeck() },
  { name: "a card opened from the deck", from: () => void showDeck(), reach: () => sendDeckCommand({ kind: "openSelected" }) },
  { name: "the tray up", reach: () => presentSearch("page", "") },
  { name: "a toast showing", reach: () => showToast("Copied URL", "link", 60_000) },
  { name: "the bar collapsed", reach: () => storeNavigation(currentTabs().selectedId!, page("down")) },
  ...(Platform.OS === "android" ? [{ name: "the Spaces sheet at rest", reach: () => void useBrowse.setState({ sheet: "spaces" }) }] : []),
];

for (const end of END_STATES) {
  test(`with ${end.name}, switching to dark and renaming a tab re-render it without moving any animated view off its end state`, () => {
    storeNavigation(currentTabs().selectedId!, page("up"));
    const root = renderSurface(<Surfaces />);
    frames(30);
    if (end.from) {
      act(() => end.from!());
      frames(120);
    }
    const before = animatedGeometry(root);
    act(() => end.reach());
    frames(120);
    const atRest = animatedGeometry(root);
    expect(atRest.length).toBeGreaterThan(0);
    expect(atRest).not.toEqual(before);
    act(() => setPreference("schemeChoice", "dark"));
    frames(3);
    const other = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
    act(() => updateTabById(other.id, { title: "Renamed while settled" }));
    frames(3);
    expect(animatedGeometry(root)).toEqual(atRest);
    unmount(root);
  });
}
