import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { deckPull, PULL_STAGE } from "../state/browse/deckPull";
import { useBrowse } from "../state/browse/store";
import * as pages from "../state/pages/store";
import { currentTabs } from "../state/tabs/store";
import { framesUntil, landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());


test("opening a card makes no page while the card grows, so the mount can't stall the growth; the page is made once the card has landed, and that same page stays in front, never made twice", () => {
  const registered = jest.spyOn(pages, "registerPageHandle");
  const registrations = (handle: "made" | "ended") => registered.mock.calls.filter((call) => (call[1] === null) === (handle === "ended")).length;
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  for (let frame = 0; frame < 6; frame++) act(() => jest.advanceTimersByTime(16));
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", opening: null });
  expect(registrations("made")).toBe(0);
  framesUntil(() => useBrowse.getState().opening !== null, 12);
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", opening: currentTabs().selectedId });
  expect(registrations("made")).toBeGreaterThan(0);
  act(() => jest.advanceTimersByTime(3000));
  expect(useBrowse.getState()).toMatchObject({ surface: "browsing", opening: null });
  expect(registrations("ended")).toBe(0);
  unmount(root);
  expect(registrations("ended")).toBe(1);
  registered.mockRestore();
});

test("a card opens as the reverse of the swipe: no opening card is mounted over the deck, the deck's own card grows from its place while the others tuck in behind it, the page is made only once the card has landed so its mount can't stall the growth, and it takes the card's place once it is laid out while the bar's glyphs cross-fade back", () => {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
  const cards = () => root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");
  const moved = (node: ReturnType<typeof host>) => Object.assign({}, ...((getAnimatedStyle(node!).transform ?? []) as object[])) as { scale?: number; translateX?: number };
  act(() => sendDeckCommand({ kind: "openFocused" }));
  act(() => jest.advanceTimersByTime(32));
  expect(host("openingCard")).toBeUndefined();
  const chrome = root.root.findAll((node) => node.props.testID === "deckChromeFade" && typeof node.type !== "string" && node.props.to !== undefined)[0]!;
  expect(chrome.props.to.opacity).toBe(1);
  expect(deckPull.stage.value).toBe(PULL_STAGE.growing);
  const growing = cards().find((card) => (getAnimatedStyle(card).zIndex as number) >= 100_000)!;
  expect(growing).toBeDefined();
  expect(moved(growing).scale).toBeGreaterThan(1);
  expect(getAnimatedStyle(growing).opacity).toBe(1);
  for (const other of cards().filter((card) => card !== growing)) {
    expect(getAnimatedStyle(other).opacity).toBe(1);
    expect(moved(other).scale).toBeLessThan(1);
  }
  act(() => jest.advanceTimersByTime(96));
  expect(useBrowse.getState().opening).toBeNull();
  expect(host("pageLayer")).toBeUndefined();
  framesUntil(() => useBrowse.getState().opening !== null, 12);
  expect(useBrowse.getState().surface).toBe("deck");
  expect(deckPull.shrink.value).toBeLessThan(0.1);
  expect(moved(host("pageLayer")!).translateX).toBeUndefined();
  expect(getAnimatedStyle(host("pagePull")!).opacity).toBe(0);
  expect(getAnimatedStyle(growing).opacity).toBe(1);
  expect(landOpeningPage(root)).toBe(true);
  framesUntil(() => useBrowse.getState().surface === "browsing", 20);
  expect(useBrowse.getState().surface).toBe("browsing");
  act(() => jest.advanceTimersByTime(32));
  expect(getAnimatedStyle(host("pagePull")!).opacity).toBe(1);
  expect(moved(host("pagePull")!).scale).toBe(1);
  const glyphs = root.root.findAll((node) => node.props.testID === "pullGlyphs" && typeof node.type === "string");
  expect(glyphs.length).toBeGreaterThan(0);
  expect(getAnimatedStyle(glyphs[0]!).opacity as number).toBeLessThan(1);
  framesUntil(() => deckPull.stage.value === PULL_STAGE.idle, 60);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  expect(getAnimatedStyle(glyphs[0]!).opacity).toBe(1);
  unmount(root);
});

test("opening a card grows it with no page made, makes the page under the deck when the spring lands, and that same page stays in front, never made twice", () => {
  const registered = jest.spyOn(pages, "registerPageHandle");
  const registrations = (handle: "made" | "ended") => registered.mock.calls.filter((call) => (call[1] === null) === (handle === "ended")).length;
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  act(() => jest.advanceTimersByTime(100));
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", opening: null });
  expect(registrations("made")).toBe(0);
  framesUntil(() => useBrowse.getState().opening !== null);
  expect(useBrowse.getState().opening).toBe(currentTabs().selectedId);
  expect(registrations("made")).toBeGreaterThan(0);
  act(() => jest.advanceTimersByTime(3000));
  expect(useBrowse.getState()).toMatchObject({ surface: "browsing", opening: null });
  expect(registrations("ended")).toBe(0);
  unmount(root);
  expect(registrations("ended")).toBe(1);
  registered.mockRestore();
});

test("while the card grows, nothing mounts the page, so the spring runs on a quiet UI thread", () => {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  for (let frame = 0; frame < 10; frame++) {
    act(() => jest.advanceTimersByTime(16));
    expect(root.root.findAll((node) => (node.type as { name?: string })?.name === "BrowsingScreen")).toHaveLength(0);
  }
  unmount(root);
});

test("the deck takes taps and a card's page takes over as soon as its spring is within Compose's settle point and the page has drawn, well under half a second", () => {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let elapsed = 0;
  let landed = false;
  while (useBrowse.getState().surface === "deck" && elapsed < 1000) {
    act(() => jest.advanceTimersByTime(16));
    elapsed += 16;
    if (!landed && useBrowse.getState().opening !== null) landed = landOpeningPage(root);
  }
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(elapsed).toBeLessThan(450);
  unmount(root);
});
