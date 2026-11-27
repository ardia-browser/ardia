import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { Surfaces } from "../App";
import { PageSurface } from "../components/browsing/PageSurface";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { deckPull, PULL_STAGE } from "../state/browse/deckPull";
import { useBrowse } from "../state/browse/store";
import * as pages from "../state/pages/store";
import { currentTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { framesUntil, landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

let mockReportsHosted = false;

jest.mock("@ardia/phone-native", () => ({ ...jest.requireActual<object>("@ardia/phone-native"), pageReportsHosted: () => mockReportsHosted }));

beforeEach(() => {
  mockReportsHosted = false;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const pageViewOf = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.pageId === id && typeof node.props.onPageEvent === "function")[0]!;
const reportHosted = (root: ReactTestRenderer, id: string) => act(() => pageViewOf(root, id).props.onPageEvent({ nativeEvent: { name: "hosted" } }));
const cardLandsWithinCap = () => act(() => jest.advanceTimersByTime(160));

function openFocusedCard() {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  framesUntil(() => useBrowse.getState().opening !== null, 12);
  return { root, id: useBrowse.getState().opening! };
}


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

test("card_opens_waited counts only an open whose page wasn't in place within its cap, not every pulled open whose page is made as its card lands, whether or not the native page view reports hosting", () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  for (const reportsHosted of [false, true]) {
    for (const laysOut of [true, false]) {
      mockReportsHosted = reportsHosted;
      withTabs(3);
      useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
      const root = renderSurface(<Surfaces />);
      act(() => sendDeckCommand({ kind: "openFocused" }));
      let landed = false;
      for (let elapsed = 0; elapsed < 1000 && useBrowse.getState().surface === "deck"; elapsed += 16) {
        act(() => jest.advanceTimersByTime(16));
        const opening = useBrowse.getState().opening;
        if (!laysOut || landed || opening === null) continue;
        landed = landOpeningPage(root);
        if (landed && reportsHosted) reportHosted(root, opening);
      }
      expect(useBrowse.getState().surface).toBe("browsing");
      expect(counted.mock.calls.filter(([name]) => name === "card_opens_waited")).toHaveLength(laysOut ? 0 : 1);
      counted.mockClear();
      unmount(root);
      act(() => jest.runOnlyPendingTimers());
    }
  }
});

test("where the native page view reports hosting, a laid-out page whose web view isn't in place yet keeps the grown card in front until it reports, so the deck can't show through an empty page layer (#4546); without that report the page takes over on layout alone", () => {
  for (const reportsHosted of [true, false]) {
    mockReportsHosted = reportsHosted;
    const { root, id } = openFocusedCard();
    expect(landOpeningPage(root)).toBe(true);
    cardLandsWithinCap();
    expect(useBrowse.getState().surface).toBe(reportsHosted ? "deck" : "browsing");
    if (reportsHosted) {
      expect(deckPull.pageLive.value).toBe(false);
      reportHosted(root, id);
    }
    framesUntil(() => deckPull.pageLive.value, 4);
    expect(useBrowse.getState()).toMatchObject({ surface: "browsing", opening: null });
    expect(deckPull.pageLive.value).toBe(true);
    unmount(root);
    act(() => jest.runOnlyPendingTimers());
  }
});

test("a page whose native view reports hosting before its layout arrives takes the card's place on that layout, not on the cap", () => {
  mockReportsHosted = true;
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const { root, id } = openFocusedCard();
  reportHosted(root, id);
  cardLandsWithinCap();
  expect(useBrowse.getState().surface).toBe("deck");
  expect(landOpeningPage(root)).toBe(true);
  framesUntil(() => useBrowse.getState().surface === "browsing", 4);
  expect(useBrowse.getState().surface).toBe("browsing");
  expect(counted.mock.calls.filter(([name]) => name === "card_opens_waited")).toHaveLength(0);
  counted.mockRestore();
  unmount(root);
});

test("a hosting report from an earlier mount of the same tab, arriving after the tab's new page is made, can't release the open: only the new page's own report does", () => {
  mockReportsHosted = true;
  withTabs(3);
  const tab = currentTabs().open.find((open) => open.id === currentTabs().selectedId)!;
  const earlier = renderSurface(<PageSurface tab={tab} toneBottom={0} />);
  const earlierReport = pageViewOf(earlier, tab.id).props.onPageEvent;
  unmount(earlier);
  act(() => jest.runOnlyPendingTimers());
  const { root, id } = openFocusedCard();
  expect(id).toBe(tab.id);
  act(() => earlierReport({ nativeEvent: { name: "hosted" } }));
  expect(landOpeningPage(root)).toBe(true);
  cardLandsWithinCap();
  expect(useBrowse.getState().surface).toBe("deck");
  expect(deckPull.pageLive.value).toBe(false);
  reportHosted(root, id);
  framesUntil(() => deckPull.pageLive.value, 4);
  expect(useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});
