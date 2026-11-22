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

function shortcutsDirection(root: ReturnType<typeof renderSurface>) {
  const shortcuts = root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "settingsShortcuts")[0]!;
  return styleOf(shortcuts).flexDirection;
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

onAndroid("on the hand-built Settings Android keeps, at ordinary text sizes the sync card has a 56-point tile beside its text and the shortcuts sit side by side", () => {
  const root = renderSurface(<SettingsView />);
  expect(syncTileSide(root)).toBe(56);
  expect(shortcutsDirection(root)).toBe("row");
  unmount(root);
});

onAndroid("on the hand-built Settings Android keeps, at accessibility text sizes the sync card stacks a 44-point tile above its text and the shortcuts stack", () => {
  setFontScale(2);
  const root = renderSurface(<SettingsView />);
  expect(syncTileSide(root)).toBe(44);
  expect(shortcutsDirection(root)).toBe("column");
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

onAndroid("Android's Settings groups its rows as iPhone's do, General, Search, Tabs, Privacy, Experimental and About, keeping Default Browser in General and Pinch to Summarize under Experimental", () => {
  useDefaultBrowser.setState({ status: { isDefault: false, canAsk: true } });
  const root = renderSurface(<SettingsView />);
  const headers = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "header" && node.type === "Text").map((node) => node.children.join(""));
  const sections = headers.filter((title) => ["General", "Search", "Tabs", "Privacy", "Experimental", "About"].includes(title));
  expect(sections.filter((title) => title !== "Experimental")).toEqual(["General", "Search", "Tabs", "Privacy", "About"]);
  const text = textOf(root);
  const order = ["Site Settings", "Default Browser", "Open App Links In", "Search Engine", "Search Suggestions", "Auto-Open Keyboard", "Archive Inactive Tabs", "Export Open Tabs", "Clear Browsing Data", PHONE_SHARING_COPY.whatsSent, "Show Onboarding", "About Ardia"];
  const at = order.map((title) => text.indexOf(title));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(text.indexOf("General")).toBeLessThan(text.indexOf("Site Settings"));
  expect(text.indexOf("Privacy")).toBeLessThan(text.indexOf("Clear Browsing Data"));
  expect(text).not.toContain(PHONE_SHARING_COPY.summary);
  unmount(root);
});
