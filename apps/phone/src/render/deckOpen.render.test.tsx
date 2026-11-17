import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { Platform } from "react-native";
import { DECK, deckGeometry } from "../lib/deckGeometry";
import { Surfaces } from "../App";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import * as pages from "../state/pages/store";
import { currentTabs } from "../state/tabs/store";
import { framesUntil, landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

onIos("on iPhone, opening a card makes its page under the deck two frames after the card starts growing, so the growth reaches Core Animation before the mount, and that same page stays in front, never made twice", () => {
  const registered = jest.spyOn(pages, "registerPageHandle");
  const registrations = (handle: "made" | "ended") => registered.mock.calls.filter((call) => (call[1] === null) === (handle === "ended")).length;
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  for (let frame = 0; frame < 6; frame++) act(() => jest.advanceTimersByTime(16));
  expect(useBrowse.getState()).toMatchObject({ surface: "deck", opening: currentTabs().selectedId });
  expect(registrations("made")).toBeGreaterThan(0);
  act(() => jest.advanceTimersByTime(3000));
  expect(useBrowse.getState()).toMatchObject({ surface: "browsing", opening: null });
  expect(registrations("ended")).toBe(0);
  unmount(root);
  expect(registrations("ended")).toBe(1);
  registered.mockRestore();
});

onIos("on iPhone, the opening card is one view on top of the deck's cards that grows from the card's place to full screen with the display's corners while the deck's header and bar fade over it on the same spring, as main's do, and the deck card under it hides once it starts", () => {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const opening = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type !== "string" && node.props.to !== undefined)[0];
  act(() => sendDeckCommand({ kind: "openFocused" }));
  const chrome = () => root.root.findAll((node) => node.props.testID === "deckChromeFade" && typeof node.type !== "string" && node.props.to !== undefined)[0]!;
  expect(chrome().props.to.opacity).toBe(0);
  expect(chrome().props.motion).toMatchObject({ type: "spring" });
  const start = opening("openingCard")!.props.to;
  expect(start.scale).toBe(1);
  expect(start.cornerRadius).toBe(DECK.cardRadius);
  act(() => jest.advanceTimersByTime(48));
  const g = deckGeometry(393, 873, 40, 24);
  const full = opening("openingCard")!.props.to;
  expect(full).toMatchObject({ translateX: 0, translateY: 0 });
  expect(full.scale).toBeCloseTo(g.width / g.cardWidth);
  expect(full.cornerRadius * full.scale).toBeCloseTo(DECK.displayCornerRadius);
  const strip = opening("openingCardFace")!.props.to.translateY * full.scale;
  expect(strip).toBeGreaterThan(36);
  expect(strip).toBeLessThanOrEqual(40.001);
  const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string").find((node) => getAnimatedStyle(node).opacity === 0);
  expect(card).toBeTruthy();
  unmount(root);
});

onAndroid("on Android, opening a card grows it with no page made, makes the page under the deck when the spring lands, and that same page stays in front, never made twice", () => {
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

onAndroid("on Android, while the card grows, nothing mounts the page, so the spring runs on a quiet UI thread", () => {
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

onAndroid("on Android, an opening card grows a status-bar strip in the page's tone above its picture, so at full size the picture lands where the live page starts", () => {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const strips = () => root.root.findAll((node) => node.props.testID === "deckCardFace" && typeof node.type === "string");
  const drop = (face: ReturnType<typeof strips>[number]) => ((getAnimatedStyle(face).transform as { translateY?: number }[] | undefined) ?? []).reduce((sum, step) => sum + (step.translateY ?? 0), 0);
  expect(strips().every((strip) => drop(strip) === 0)).toBe(true);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  let grown = 0;
  for (let frame = 0; frame < 120 && useBrowse.getState().surface === "deck"; frame++) {
    act(() => jest.advanceTimersByTime(16));
    for (const strip of strips()) grown = Math.max(grown, drop(strip));
  }
  const g = deckGeometry(393, 873, 40, 24);
  expect(grown * (g.width / g.cardWidth)).toBeGreaterThan(36);
  expect(grown * (g.width / g.cardWidth)).toBeLessThanOrEqual(40.001);
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
