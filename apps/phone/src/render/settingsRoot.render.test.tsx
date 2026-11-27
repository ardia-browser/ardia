import { Platform, Dimensions, ScrollView, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { settingsTint } from "../components/ui";
import { openSettings, popSettings, pushSettings } from "../state/settings/nav";
import { useSync } from "../state/sync/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";
import { useDefaultBrowser } from "../state/settings/defaultBrowser";
import { PHONE_SHARING_COPY } from "../lib/telemetryCopy";

const NORMAL = { width: 393, height: 873, scale: 3, fontScale: 1 };

function setFontScale(fontScale: number) {
  const window = { ...NORMAL, fontScale };
  act(() => Dimensions.set({ window, screen: window }));
}

const styleOf = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};

function syncTileSide(root: ReturnType<typeof renderSurface>) {
  const tile = root.root.findAll((node) => typeof node.type === "string" && styleOf(node).backgroundColor === settingsTint.sync)[0]!;
  return styleOf(tile).width;
}

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  openSettings();
});

afterEach(() => {
  setFontScale(1);
  jest.useRealTimers();
});

onAndroid("on the hand-built Settings Android keeps, at ordinary text sizes the sync card has a 56-point tile beside its text, and as on iPhone there are no Archive or Spaces shortcuts", () => {
  const root = renderSurface(<SettingsView />);
  expect(syncTileSide(root)).toBe(56);
  expect(root.root.findAll((node) => node.props.testID === "settingsShortcuts")).toHaveLength(0);
  unmount(root);
});

onAndroid("on the hand-built Settings Android keeps, at accessibility text sizes the sync card stacks a 44-point tile above its text", () => {
  setFontScale(2);
  const root = renderSurface(<SettingsView />);
  expect(syncTileSide(root)).toBe(44);
  const card = root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "syncCardContent")[0]!;
  expect(styleOf(card).flexDirection).toBe("column");
  unmount(root);
});

onAndroid("on the hand-built Settings Android keeps, the sync card's status line crossfades when it changes and doesn't fade in when Settings opens", () => {
  const root = renderSurface(<SettingsView />);
  const line = () => root.root.findAll((node) => node.props.testID === "syncStatusLine" && node.props.exiting !== undefined)[0];
  const first = line()!;
  expect(first.props.entering).toBeDefined();
  let skipsFirstEntering = false;
  for (let at: ReactTestInstance | null = first; at; at = at.parent) if (at.props.skipEntering === true) skipsFirstEntering = true;
  expect(skipsFirstEntering).toBe(true);
  act(() => {
    useSync.setState((state) => ({ ...state, status: { ...state.status, attention: "phrase" } as never }));
  });
  const second = line()!;
  expect(second.props.children).toBe("Enter Recovery Phrase");
  unmount(root);
});

onAndroid("Back from About returns to where Settings was scrolled, whatever scrolled it, with the offset given at mount so Android applies it once the list is laid out", () => {
  const root = renderSurface(<SettingsView />);
  const list = () => root.root.findAll((node) => node.type === ScrollView)[0]!;
  expect(list().props.contentOffset).toEqual({ x: 0, y: 0 });
  act(() => list().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 640 } } }));
  act(() => pushSettings({ page: "about" }));
  act(() => jest.advanceTimersByTime(600));
  act(() => void popSettings());
  act(() => jest.advanceTimersByTime(600));
  expect(list().props.contentOffset).toEqual({ x: 0, y: 640 });
  unmount(root);
});

const inOrder = (text: string, titles: string[]) => {
  const at = titles.map((title) => text.indexOf(title));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
};

onAndroid("Android's Settings lists iPhone's panes in iPhone's order, Sync first, and each pane holds iPhone's sections and rows in iPhone's words", () => {
  useDefaultBrowser.setState({ status: { isDefault: false, canAsk: true } });
  const root = renderSurface(<SettingsView />);
  const text = textOf(root);
  inOrder(text, ["Sync", "General", "Tabs", "Appearance", "Search", "Site settings"]);
  expect(text).not.toContain("Clear browsing data");
  unmount(root);
  const pane = (page: "general" | "tabs" | "search") => {
    act(() => openSettings({ page }));
    const shown = renderSurface(<SettingsView />);
    const words = textOf(shown);
    unmount(shown);
    return words;
  };
  inOrder(pane("general"), ["Default browser", "Make Ardia your default browser.", "Links", "Open app links in", "Links to apps you have, like YouTube or Maps.", "Privacy", "Clear browsing data", "History, cookies and cached files.", PHONE_SHARING_COPY.toggle, PHONE_SHARING_COPY.whatsSent, "About", "Set up Ardia again", "Shows the welcome screens again.", "About Ardia"]);
  inOrder(pane("tabs"), ["Tab view", "Stack", "Grid", "Clean up", "Archive inactive tabs", "Moves tabs you haven't used in this long to the Archive.", "Export", "Export open tabs", "Share a list of every open tab."]);
  inOrder(pane("search"), ["Search engine", "Search suggestions", "Suggestions from your search engine as you type.", "New tabs", "Auto-open keyboard", "Start typing as soon as Ardia opens."]);
});
