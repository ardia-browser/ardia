import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { useArchiveCard } from "../state/browse/archiveCard";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs } from "../state/tabs/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
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

test("where the system glass exists, no view above the deck's glass surfaces fades, their glass waits hidden through the entrance and materialises over 150 ms once the chrome comes in, and their glyphs carry the chrome's fade", () => {
  withGlass(true);
  const root = enterDeck();
  expect(glasses(root)).toHaveLength(CHROME.length);
  for (const glass of glasses(root)) expect(fadingAncestors(glass)).toEqual([]);
  expect(glassShown(root)).toEqual(CHROME.map(() => false));
  for (const glass of glasses(root)) expect(glass.props.shownMs).toBe(150);
  for (const glyph of GLYPHS) expect(opacity(host(root, glyph))).toBe(0);
  expect(host(root, "deckRedesignedChrome").props.jestAnimatedProps?.value?.pointerEvents ?? host(root, "deckRedesignedChrome").props.pointerEvents).toBe("none");
  expect(host(root, "deckRedesignedChrome").props.accessibilityElementsHidden).toBe(true);
  act(() => jest.advanceTimersByTime(3000));
  for (const glass of glasses(root)) expect(fadingAncestors(glass)).toEqual([]);
  expect(glassShown(root)).toEqual(CHROME.map(() => true));
  for (const glyph of GLYPHS) expect(opacity(host(root, glyph))).toBe(1);
  expect(host(root, "deckRedesignedChrome").props.jestAnimatedProps?.value?.pointerEvents ?? host(root, "deckRedesignedChrome").props.pointerEvents).toBe("box-none");
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

test("where the system glass exists, the header's glass hides as soon as a card is tapped open and the glass stays hidden while the deck is away; on both phones the deck's bar stays whole, glass and glyphs, until the page's own bar takes over, while the header's glyphs fade as the card grows", () => {
  withGlass(true);
  const root = enterDeck();
  act(() => jest.advanceTimersByTime(3000));
  expect(glassShown(root)).toEqual(CHROME.map(() => true));
  act(() => sendDeckCommand({ kind: "openFocused" }));
  expect(glassShown(root)).toEqual([false, true, true]);
  const chromeFade = root.root.findAll((node) => node.props.testID === "deckChromeFade" && typeof node.type !== "string" && node.props.to !== undefined)[0]!;
  expect(chromeFade.props.to.opacity).toBe(1);
  frames(6);
  expect(opacity(host(root, "deckHeaderMoreGlyph"))).toBe(0);
  expect(opacity(host(root, "deckSwitcher"))).toBe(0);
  expect(opacity(host(root, "deckSearchTabsContent"))).toBe(1);
  expect(opacity(host(root, "deckBarPlusGlyph"))).toBe(1);
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

test("with cuts, the deck's bar glass is shown from the standby on and never flips, while the header draws nothing behind the page: its precomposited sample lies under it at its own bounds, and its live glass comes on only while the deck shows", () => {
  withGlass(true);
  cutTabSwitches(true);
  try {
    useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
    const root = renderSurface(
      <DesignProvider design="redesigned">
        <TabDeck />
      </DesignProvider>,
      { flushTimers: false },
    );
    const seen = (glass: ReactTestInstance) => {
      let product = 1;
      for (let at = glass.parent; at; at = at.parent) if (typeof at.type === "string") product *= opacity(at);
      return product;
    };
    const shownOf = (id: string) => glasses(root).find((glass) => glass.props.testID === id)!.props.shown;
    expect(glasses(root)).toHaveLength(CHROME.length);
    expect([shownOf("deckSearchTabs"), shownOf("deckBarPlus")]).toEqual([true, true]);
    expect(shownOf("deckHeaderMore")).toBe(false);
    for (const glass of glasses(root)) expect(seen(glass)).toBe(0);
    const more = glasses(root).find((glass) => glass.props.testID === "deckHeaderMore")!;
    act(() => more.props.onLayout({ nativeEvent: { layout: { x: 300, y: 4, width: 44, height: 44 } } }));
    const sample = root.root.findAll((node) => node.props.testID === "deckHeaderMoreSample" && typeof node.type === "string")[0];
    expect(StyleSheet.flatten(sample!.props.style)).toMatchObject({ left: 300, top: 4, width: 44, height: 44 });
    act(() => useBrowse.setState({ surface: "deck", deckEntrance: currentTabs().selectedId }));
    frames(4);
    expect(glasses(root).map((glass) => glass.props.shown)).toEqual(CHROME.map(() => true));
    for (const glass of glasses(root)) expect(seen(glass)).toBe(1);
    unmount(root);
  } finally {
    cutTabSwitches(false);
  }
});
