import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { useArchiveCard } from "../state/browse/archiveCard";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

const CHROME = ["deckHeaderMore", "deckSearchTabs", "deckBarPlus"];
const GLYPHS = ["deckHeaderMoreGlyph", "deckSearchTabsContent", "deckBarPlusGlyph", "deckSwitcher"];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(6);
  useArchiveCard.setState({ showing: false });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const withGlass = (on: boolean) => jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => on);

const enterDeck = (design: Design = "redesigned") => {
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: currentTabs().selectedId, frozenOrder: null, opening: null });
  return renderSurface(
    <DesignProvider design={design}>
      <TabDeck />
    </DesignProvider>,
    { flushTimers: false },
  );
};

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0]!;
const glasses = (root: Root) => root.root.findAll((node) => node.type === lookModule.Glass && CHROME.includes(node.props.testID));
const glassShown = (root: Root) => glasses(root).map((node) => node.props.shown);
const animatedOpacity = (node: ReactTestInstance) => (node.props.jestAnimatedStyle?.value as { opacity?: number } | undefined)?.opacity;
const opacity = (node: ReactTestInstance) => (getAnimatedStyle(node).opacity as number | undefined) ?? 1;

const fadingAncestors = (node: ReactTestInstance) => {
  const fading: string[] = [];
  for (let at = node.parent; at; at = at.parent) {
    if (typeof at.type !== "string") continue;
    const still = StyleSheet.flatten(at.props.style)?.opacity;
    if (animatedOpacity(at) !== undefined || (typeof still === "number" && still < 1)) fading.push(String(at.props.testID ?? at.type));
  }
  return fading;
};

const frames = (count: number) => {
  for (let frame = 0; frame < count; frame++) act(() => jest.advanceTimersByTime(16));
};

test("where the system glass exists, no view above the deck's glass surfaces fades, their glass waits hidden through the entrance and materialises over 200 ms once the chrome comes in, and their glyphs carry the chrome's fade", () => {
  withGlass(true);
  const root = enterDeck();
  expect(glasses(root)).toHaveLength(CHROME.length);
  for (const glass of glasses(root)) expect(fadingAncestors(glass)).toEqual([]);
  expect(glassShown(root)).toEqual(CHROME.map(() => false));
  for (const glass of glasses(root)) expect(glass.props.shownMs).toBe(200);
  for (const glyph of GLYPHS) expect(opacity(host(root, glyph))).toBe(0);
  expect(host(root, "deckRedesignedChrome").props.pointerEvents).toBe("none");
  expect(host(root, "deckRedesignedChrome").props.accessibilityElementsHidden).toBe(true);
  act(() => jest.advanceTimersByTime(3000));
  for (const glass of glasses(root)) expect(fadingAncestors(glass)).toEqual([]);
  expect(glassShown(root)).toEqual(CHROME.map(() => true));
  for (const glyph of GLYPHS) expect(opacity(host(root, glyph))).toBe(1);
  expect(host(root, "deckRedesignedChrome").props.pointerEvents).toBe("box-none");
  expect(host(root, "deckRedesignedChrome").props.accessibilityElementsHidden).toBe(false);
  unmount(root);
});

test("where the system glass exists, the glyphs fade in mid-entrance on the chrome's curve while their glass turns on as the chrome starts coming in", () => {
  withGlass(true);
  const root = enterDeck();
  let midway = -1;
  let shownAt = -1;
  for (let frame = 1; frame <= 60 && (midway < 0 || shownAt < 0); frame++) {
    frames(1);
    const glyph = opacity(host(root, "deckBarPlusGlyph"));
    if (midway < 0 && glyph > 0 && glyph < 1) midway = frame;
    if (shownAt < 0 && glassShown(root).every(Boolean)) shownAt = frame;
  }
  expect(midway).toBeGreaterThan(0);
  expect(shownAt).toBeGreaterThan(0);
  expect(shownAt).toBeLessThanOrEqual(midway);
  unmount(root);
});

test("where the system glass exists, the glass hides as soon as a card is tapped open while on iPhone the glyphs fade over the growing card, and the glass stays hidden while the deck is away", () => {
  withGlass(true);
  const root = enterDeck();
  act(() => jest.advanceTimersByTime(3000));
  expect(glassShown(root)).toEqual(CHROME.map(() => true));
  act(() => sendDeckCommand({ kind: "openFocused" }));
  expect(glassShown(root)).toEqual(CHROME.map(() => false));
  if (Platform.OS === "ios") {
    const chromeFade = root.root.findAll((node) => node.props.testID === "deckChromeFade" && typeof node.type !== "string" && node.props.to !== undefined)[0]!;
    expect(chromeFade.props.to.opacity).toBe(0);
    for (const glyph of GLYPHS) expect(chromeFade.findAll((node) => node.props.testID === glyph && typeof node.type === "string")).toHaveLength(1);
  }
  act(() => useBrowse.setState({ surface: "browsing", opening: null }));
  act(() => jest.advanceTimersByTime(3000));
  expect(glassShown(root)).toEqual(CHROME.map(() => false));
  unmount(root);
});

test("where the system glass exists, the deck's chrome glass comes back on the next open after a card opened", () => {
  withGlass(true);
  const root = enterDeck();
  act(() => jest.advanceTimersByTime(3000));
  act(() => sendDeckCommand({ kind: "openFocused" }));
  act(() => jest.advanceTimersByTime(3000));
  act(() => useBrowse.setState({ surface: "browsing", opening: null }));
  act(() => useBrowse.setState({ surface: "deck", deckEntrance: currentTabs().selectedId }));
  expect(glassShown(root)).toEqual(CHROME.map(() => false));
  act(() => jest.advanceTimersByTime(3000));
  expect(glassShown(root)).toEqual(CHROME.map(() => true));
  for (const glass of glasses(root)) expect(fadingAncestors(glass)).toEqual([]);
  unmount(root);
});

test("without the system glass the redesigned chrome fades as one layer, as before, and its glyphs carry no fade of their own", () => {
  withGlass(false);
  const root = enterDeck();
  expect(animatedOpacity(host(root, "deckRedesignedChrome"))).toBe(0);
  for (const glyph of GLYPHS) expect(animatedOpacity(host(root, glyph))).toBeUndefined();
  act(() => jest.advanceTimersByTime(3000));
  expect(animatedOpacity(host(root, "deckRedesignedChrome"))).toBe(1);
  unmount(root);
});
