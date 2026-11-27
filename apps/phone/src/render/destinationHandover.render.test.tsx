import { getAnimatedStyle } from "react-native-reanimated";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Dimensions, StyleSheet } from "react-native";
import { Surfaces } from "../App";
import { sendDeckCommand } from "../state/browse/deckCommands";
import * as deckPull from "../state/browse/deckPull";
import { pageBarPreviewShown, pageBarShown } from "../state/browse/deckPull";
import { destination, liftDestination, releaseDestination, useDestination } from "../state/browse/destination";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { display } from "../state/search/omnibox";
import { dismissSearch, searchState } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { forgetWarmPictures, noteWarmPicture } from "../state/tabs/warmPictures";
import { renderSurface, someTabs, textOf, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  return { ...actual, pageReportsDrawn: () => true };
});

beforeEach(() => {
  jest.useFakeTimers();
  cutTabSwitches(true);
  setPreference("tabSwipeHintShown", true);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => releaseDestination());
  act(() => jest.runOnlyPendingTimers());
  cutTabSwitches(false);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const hosts = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const host = (root: ReactTestRenderer, id: string) => hosts(root, id)[0];
const flush = () => act(() => jest.advanceTimersByTime(0));
const deckUp = () => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
const otherTab = () => currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
const hostOf = (id: string) => display(currentTabs().open.find((tab) => tab.id === id)!.url).host;
const animatedProp = (node: ReactTestInstance, key: string) => (node.props.jestAnimatedProps?.value as Record<string, unknown> | undefined)?.[key];
const opacityOf = (node: ReactTestInstance): number => {
  const animated = (node.props.jestAnimatedStyle?.value as { opacity?: number } | undefined)?.opacity;
  if (animated !== undefined) return animated;
  return typeof node.type === "string" ? ((StyleSheet.flatten(node.props.style) as { opacity?: number } | undefined)?.opacity ?? 1) : 1;
};
const drawnMarks = (root: ReactTestRenderer) => [
  ...new Set(
    root.root
      .findAll((node) => (node.props.testID === "destinationFaceMark" || node.props.testID === "destinationBarMark") && typeof node.props.markWhenShown === "string" && node.props.jestAnimatedStyle !== undefined && (node.props.jestAnimatedStyle.value as { opacity?: number }).opacity === 1)
      .map((node) => node.props.markWhenShown as string),
  ),
];
const faceOf = (root: ReactTestRenderer, id: string) =>
  root.root
    .findAll((node) => typeof node.type !== "string" && (node.props.tab as { id?: string } | undefined)?.id === id && "statusOver" in node.props)
    .flatMap((owner) => owner.findAll((node) => node.props.testID === "destinationFace" && typeof node.type === "string"))[0];
const shownFaces = (root: ReactTestRenderer) => hosts(root, "destinationFace").filter((face) => opacityOf(face) > 0);
const lift = (id: string) => {
  act(() => {
    liftDestination(id);
  });
  act(() => jest.advanceTimersByTime(16));
};
const roundOf = (id: string) => useDestination.getState().spent[id] ?? 0;
const expectReleased = (root: ReactTestRenderer, id: string, before: number) => {
  const face = faceOf(root, id)!;
  expect(face).toBeDefined();
  expect(roundOf(id)).toBe(before + 1);
  expect(face.props.nativeID).toBeUndefined();
  expect(opacityOf(face)).toBe(0);
  expect(shownFaces(root)).toHaveLength(0);
};
const commit = (id: string) => act(() => sendDeckCommand({ kind: "open", tabId: id, tappedAt: Date.now() }));

test("a card pressed in the deck gets its destination face ready under the kept bar before lift: mounted, opaque title first, hidden and untouchable until the lift's own UI turn shows it with the bar", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => require("../state/browse/destination").pressDestination(wanted.id));
  const face = faceOf(root, wanted.id)!;
  expect(face).toBeDefined();
  expect(host(root, "destinationTitle")).toBeDefined();
  expect(getAnimatedStyle(face).opacity).toBe(0);
  expect(animatedProp(face, "pointerEvents")).toBe("none");
  expect(face.props.importantForAccessibility).toBe("no-hide-descendants");
  lift(wanted.id);
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(animatedProp(face, "pointerEvents")).toBe("auto");
  expect(pageBarShown.value).toBe(1);
  expect(drawnMarks(root).sort()).toEqual([`dest-bar:${wanted.id}`, `dest-face:${wanted.id}`]);
  unmount(root);
});

test("the destination face is one view from the lift to the page's first drawn frame: the commit keeps it, names it as the page's cover, mounts no second cover, and only the matching drawn acknowledgement releases it", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => require("../state/browse/destination").pressDestination(wanted.id));
  const before = roundOf(wanted.id);
  lift(wanted.id);
  commit(wanted.id);
  flush();
  expect(currentTabs().selectedId).toBe(wanted.id);
  const face = faceOf(root, wanted.id)!;
  expect(roundOf(wanted.id)).toBe(before);
  const cover = useDestination.getState().cover!;
  expect(cover).toMatch(/^destinationCover-/);
  expect(face.props.nativeID).toBe(cover);
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(hosts(root, "pageCover")).toHaveLength(0);
  const surface = root.root.findAll((node) => node.props.pageId === wanted.id && node.props.coverNativeId !== undefined)[0]!;
  expect(surface.props.coverNativeId).toBe(cover);
  act(() => browse.pageCoverHidden(wanted.id, "drawn", "destinationCover-0", true, 1));
  expect(faceOf(root, wanted.id)!.props.nativeID).toBe(cover);
  act(() => browse.pageCoverHidden(wanted.id, "drawn", cover, true, 1));
  flush();
  expectReleased(root, wanted.id, before);
  expect(destination.id.value).toBe("");
  unmount(root);
});

test("a short press whose JS touch-down never ran before the lift still shows the destination's address: the bar's leaf for another card stays hidden and the UI-thread leaf reads the lifted card's address", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const selected = currentTabs().selectedId!;
  const [stale, wanted] = currentTabs().open.filter((tab) => tab.id !== selected);
  act(() => require("../state/browse/deckPull").previewPageBar(stale!.id));
  lift(wanted!.id);
  expect(getAnimatedStyle(host(root, "floatingBarPreview")!).opacity).toBe(0);
  const fallback = host(root, "floatingBarDestinationLeaf")!;
  expect(getAnimatedStyle(fallback).opacity).toBe(1);
  const text = root.root.findAll((node) => node.props.testID === "floatingBarDestinationHost" && node.props.jestAnimatedProps !== undefined)[0]!;
  expect(animatedProp(text, "text")).toBe(hostOf(wanted!.id));
  expect(getAnimatedStyle(host(root, "floatingBarAddressStack")!).opacity).toBe(0);
  unmount(root);
});

test("a pressed card's own leaf is the one shown on its lift, and the fallback stays hidden", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => require("../state/browse/destination").pressDestination(wanted.id));
  lift(wanted.id);
  expect(getAnimatedStyle(host(root, "floatingBarPreview")!).opacity).toBe(1);
  expect(getAnimatedStyle(host(root, "floatingBarDestinationLeaf")!).opacity).toBe(0);
  unmount(root);
});

test("while the kept bar shows over the deck, its Address press is fenced from the tab it left and held for the destination, then runs there on the commit", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  lift(wanted.id);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  commit(wanted.id);
  flush();
  expect(currentTabs().selectedId).toBe(wanted.id);
  expect(searchState().open).toBe(true);
  expect(searchState().initialText).toContain(hostOf(wanted.id));
  unmount(root);
});

test("a card opened by a screen reader takes the same hand-over: it lifts its destination, shows its face and names it as the arriving page's cover", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  expect(destination.id.value).toBe(wanted.id);
  const face = faceOf(root, wanted.id)!;
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(face.props.nativeID).toBe(useDestination.getState().cover);
  unmount(root);
});

test("a cut back to the deck before the page draws hides the destination face on that same UI turn", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  const face = faceOf(root, wanted.id)!;
  expect(getAnimatedStyle(face).opacity).toBe(1);
  act(() => {
    pageBarShown.value = 0;
    pageBarPreviewShown.value = 0;
  });
  expect(getAnimatedStyle(face).opacity).toBe(0);
  unmount(root);
});

test("a destination whose page fails is released instead of waiting on a drawn frame that never comes", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  const before = roundOf(wanted.id);
  expect(faceOf(root, wanted.id)!.props.nativeID).toBe(useDestination.getState().cover);
  act(() => require("../state/pages/store").storeNavigation(wanted.id, { isLive: true, isLoading: false, url: wanted.url, title: "", failure: { code: "offline" }, progress: 1 }));
  act(() => jest.advanceTimersByTime(4_100));
  expectReleased(root, wanted.id, before);
  unmount(root);
});

test("the deck's own tap prepares the pressed card at touch-down and its lift publishes it", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const tap = getByGestureTestId("deckTap") as unknown as { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void } };
  const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")[0]!;
  const pose = Object.assign({}, ...((getAnimatedStyle(card).transform ?? []) as object[])) as { translateX: number; translateY: number };
  const box = StyleSheet.flatten(card.props.style) as { width: number; height: number };
  const touch = { id: 0, x: pose.translateX + box.width / 2, y: pose.translateY + box.height / 2 };
  const manager = { fail: () => undefined };
  act(() => tap.handlers.onTouchesDown({ allTouches: [touch], changedTouches: [touch] }, manager));
  flush();
  expect(useDestination.getState().prepared).not.toBeNull();
  unmount(root);
});

const pageViewOf = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.pageId === id && typeof node.props.onPageError === "function")[0]!;
const frostSource = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "pageFrostSource" && node.props.jestAnimatedProps !== undefined)[0]!;

test("a destination page that native refuses to bind, so it never draws, releases its face and the frost hold at once instead of keeping both up and taking the page's touches", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  const before = roundOf(wanted.id);
  act(() => pageViewOf(root, wanted.id).props.onPageError({ code: "savedStateUnreadable", message: "bind refused" }));
  flush();
  act(() => jest.advanceTimersByTime(16));
  expectReleased(root, wanted.id, before);
  expect(useDestination.getState().arriving).toBeNull();
  expect(destination.id.value).toBe("");
  expect(animatedProp(frostSource(root), "heldFill") ?? null).toBeNull();
  unmount(root);
});

test("a destination page that fails to load releases its face on the failure itself, not after the long wait", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  const before = roundOf(wanted.id);
  act(() => require("../state/pages/store").storeNavigation(wanted.id, { isLive: true, isLoading: false, url: wanted.url, title: "", failure: { code: "offline" }, progress: 1 }));
  flush();
  expectReleased(root, wanted.id, before);
  unmount(root);
});

test("reopening the deck before one destination draws and pressing another hands the face and the frost hold to the new card: the old arrival can't refuse it or keep its cover over the new hold", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const selected = currentTabs().selectedId!;
  const [first, second] = currentTabs().open.filter((tab) => tab.id !== selected);
  commit(first!.id);
  flush();
  const firstCover = useDestination.getState().cover;
  expect(firstCover).not.toBeNull();
  act(() => {
    pageBarShown.value = 0;
    pageBarPreviewShown.value = 0;
  });
  deckUp();
  flush();
  act(() => require("../state/browse/destination").pressDestination(second!.id));
  expect(useDestination.getState().prepared).toBe(second!.id);
  expect(useDestination.getState().arriving).toBeNull();
  const face = faceOf(root, second!.id)!;
  lift(second!.id);
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(animatedProp(frostSource(root), "heldUntil") ?? null).toBeNull();
  unmount(root);
});

test("a deck select of a tab whose swipe arrival is still waiting keeps the deck cover's own acknowledgement: the arrival's re-wait can't take its slot", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => browse.arriveAtNeighbour(wanted.id));
  act(() => jest.advanceTimersByTime(1_000));
  deckUp();
  flush();
  commit(wanted.id);
  flush();
  const cover = useDestination.getState().cover!;
  expect(cover).toMatch(/^destinationCover-/);
  act(() => jest.advanceTimersByTime(3_100));
  const before = roundOf(wanted.id);
  act(() => browse.pageCoverHidden(wanted.id, "drawn", cover, true, 1));
  flush();
  expect(useDestination.getState().arriving).toBeNull();
  expectReleased(root, wanted.id, before);
  unmount(root);
});

test("an Address press after lifting the card that is already the shown tab is held until that card commits, so search isn't opened and then dismissed by the commit", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const selected = currentTabs().selectedId!;
  lift(selected);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  commit(selected);
  flush();
  act(() => jest.advanceTimersByTime(16));
  expect(currentTabs().selectedId).toBe(selected);
  expect(searchState().open).toBe(true);
  expect(searchState().initialText).toContain(hostOf(selected));
  unmount(root);
});

test("without tab-switch cuts the Address stays the plain Pressable, with no UI-thread value over its own", () => {
  cutTabSwitches(false);
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const root = renderSurface(<Surfaces />);
  const nodes = root.root.findAll((node) => node.props.accessibilityLabel === "Address");
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes.every((node) => node.props.jestAnimatedProps === undefined && node.props.animatedProps === undefined)).toBe(true);
  unmount(root);
});

const deckCardIds = (root: ReactTestRenderer) => [...new Set(root.root.findAll((node) => typeof node.type !== "string" && node.props.motion !== undefined && typeof node.props.onOpen === "function" && (node.props.tab as { id?: string } | undefined)?.id !== undefined).map((node) => (node.props.tab as { id: string }).id))].sort();
const faceIds = (root: ReactTestRenderer) =>
  [...new Set(root.root.findAll((node) => typeof node.type !== "string" && "statusOver" in node.props && typeof node.props.id === "string").map((node) => node.props.id as string))].sort();
const both = (id: string) => [`dest-bar:${id}`, `dest-face:${id}`];

test("every tappable deck card has its face mounted before any press, so a tap whose JS touch-down never ran shows face and bar together from the release alone", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  expect(deckCardIds(root).length).toBe(3);
  expect(faceIds(root)).toEqual(deckCardIds(root));
  expect(useDestination.getState().prepared).toBeNull();
  expect(drawnMarks(root)).toEqual([]);
  const wanted = otherTab();
  const face = faceOf(root, wanted.id)!;
  expect(face.props.importantForAccessibility).toBe("no-hide-descendants");
  expect(opacityOf(face)).toBe(0);
  lift(wanted.id);
  expect(useDestination.getState().prepared).toBeNull();
  expect(opacityOf(faceOf(root, wanted.id)!)).toBe(1);
  expect(shownFaces(root)).toHaveLength(1);
  expect(drawnMarks(root).sort()).toEqual(both(wanted.id));
  unmount(root);
});

test("the release publishes face and bar in one UI write: no step shows one mark without the other, and no React state changes on the way", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  const before = useDestination.getState();
  const steps: string[][] = [];
  act(() => {
    liftDestination(wanted.id);
  });
  steps.push(drawnMarks(root).sort());
  for (let frame = 0; frame < 3; frame++) {
    act(() => jest.advanceTimersByTime(16));
    steps.push(drawnMarks(root).sort());
  }
  for (const step of steps) expect([[], both(wanted.id)]).toContainEqual(step);
  expect(steps.at(-1)).toEqual(both(wanted.id));
  expect(useDestination.getState()).toBe(before);
  unmount(root);
});

test("a warm card's picture is decoded under its hidden face before any press and is shown on the release; a cold card shows its title card", () => {
  withTabs(3);
  const selected = currentTabs().selectedId!;
  const [warm, cold] = currentTabs().open.filter((tab) => tab.id !== selected);
  const uri = `file:///${warm!.id}.jpg`;
  useTabs.setState((now) => ({ open: now.open.map((tab) => (tab.id === warm!.id ? { ...tab, snapshotFileName: uri } : tab)) }));
  const window = Dimensions.get("window");
  noteWarmPicture(warm!.id, { uri, url: warm!.url, window, frame: { x: 0, y: 0, width: window.width, height: window.height }, settled: true, view: 1, viewId: 1 });
  deckUp();
  const root = renderSurface(<Surfaces />);
  const pictureOf = (id: string) => faceOf(root, id)!.findAll((node) => node.props.testID === "destinationPicture" && typeof node.props.onLoad === "function")[0];
  const picture = pictureOf(warm!.id)!;
  expect(picture.props.resizeMethod).toBe("scale");
  expect(StyleSheet.flatten(picture.props.style).opacity).toBe(0);
  act(() => picture.props.onLoad({ nativeEvent: { source: { width: window.width, height: window.height } } }));
  expect(StyleSheet.flatten(pictureOf(warm!.id)!.props.style).opacity).toBe(1);
  expect(opacityOf(faceOf(root, warm!.id)!)).toBe(0);
  lift(warm!.id);
  expect(opacityOf(faceOf(root, warm!.id)!)).toBe(1);
  expect(StyleSheet.flatten(pictureOf(warm!.id)!.props.style).opacity).toBe(1);
  expect(pictureOf(cold!.id)).toBeUndefined();
  expect(textOf({ root: faceOf(root, cold!.id)! } as ReactTestRenderer)).toContain(cold!.title);
  commit(warm!.id);
  flush();
  const round = roundOf(warm!.id);
  act(() => browse.pageCoverHidden(warm!.id, "drawn", useDestination.getState().cover!, true, 1));
  flush();
  expect(roundOf(warm!.id)).toBe(round + 1);
  expect(StyleSheet.flatten(pictureOf(warm!.id)!.props.style).opacity).toBe(1);
  forgetWarmPictures([warm!.id]);
  unmount(root);
});

test("a moving deck keeps one face per mounted card: cards scrolled into reach get theirs and a newly reachable card's release shows its own face", () => {
  withTabs(30);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const was = deckCardIds(root);
  expect(was.length).toBeLessThan(30);
  expect(faceIds(root)).toEqual(was);
  const scroller = root.root.findAll((node) => typeof node.props.onScrollAction === "function")[0]!;
  for (let step = 0; step < 12; step++) {
    act(() => scroller.props.onScrollAction("backward"));
    act(() => jest.advanceTimersByTime(600));
  }
  const now = deckCardIds(root);
  const arrived = now.filter((id) => !was.includes(id));
  expect(arrived.length).toBeGreaterThan(0);
  expect(faceIds(root)).toEqual(now);
  lift(arrived[0]!);
  expect(shownFaces(root)).toHaveLength(1);
  expect(drawnMarks(root).sort()).toEqual(both(arrived[0]!));
  unmount(root);
});

test("a private card's face carries the incognito styling, not its page title card", () => {
  withTabs(3);
  const [secret] = someTabs(1, true);
  useTabs.setState({ privates: [secret!], incognito: true });
  deckUp();
  const root = renderSurface(<Surfaces />);
  const face = faceOf(root, secret!.id)!;
  expect(face).toBeDefined();
  lift(secret!.id);
  expect(opacityOf(faceOf(root, secret!.id)!)).toBe(1);
  expect(textOf({ root: faceOf(root, secret!.id)! } as ReactTestRenderer)).toContain("Incognito Tab");
  expect(drawnMarks(root).sort()).toEqual(both(secret!.id));
  unmount(root);
});

test("a deck opened over a page whose bar had collapsed still publishes the destination face and bar together", () => {
  setPreference("collapsesBottomBar", true);
  withTabs(3);
  const selected = currentTabs().selectedId!;
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const root = renderSurface(<Surfaces />);
  act(() => require("../state/pages/store").storeNavigation(selected, { url: currentTabs().open[0]!.url, title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection: "down" }));
  act(() => jest.advanceTimersByTime(1_000));
  deckUp();
  flush();
  const wanted = otherTab();
  lift(wanted.id);
  expect(shownFaces(root)).toHaveLength(1);
  expect(drawnMarks(root).sort()).toEqual(both(wanted.id));
  setPreference("collapsesBottomBar", null);
  unmount(root);
});

test("from the release to the page's first drawn frame some face always covers the page, and the face re-mounted after the hand-over never shows", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  lift(wanted.id);
  commit(wanted.id);
  for (let frame = 0; frame < 6; frame++) {
    act(() => jest.advanceTimersByTime(16));
    expect(shownFaces(root)).toHaveLength(1);
    expect(opacityOf(faceOf(root, wanted.id)!)).toBe(1);
  }
  const round = roundOf(wanted.id);
  act(() => browse.pageCoverHidden(wanted.id, "drawn", useDestination.getState().cover!, true, 1));
  for (let frame = 0; frame < 6; frame++) {
    act(() => jest.advanceTimersByTime(16));
    const face = faceOf(root, wanted.id)!;
    if (roundOf(wanted.id) > round) expect(opacityOf(face)).toBe(0);
  }
  expectReleased(root, wanted.id, round);
  unmount(root);
});

const shownMark = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((node) => node.props.markWhenShown === label && node.props.jestAnimatedStyle !== undefined).some((node) => (node.props.jestAnimatedStyle.value as { opacity?: number }).opacity === 1);

test("a stale drawn acknowledgement from an earlier arrival of the same tab can't clear a newer lift of it: its face stays up through the second hand-over", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  const first = useDestination.getState().cover!;
  act(() => {
    pageBarShown.value = 0;
    pageBarPreviewShown.value = 0;
  });
  deckUp();
  flush();
  lift(wanted.id);
  act(() => browse.pageCoverHidden(wanted.id, "drawn", first, true, 1));
  flush();
  act(() => jest.advanceTimersByTime(16));
  expect(destination.id.value).toBe(wanted.id);
  expect(opacityOf(faceOf(root, wanted.id)!)).toBe(1);
  commit(wanted.id);
  flush();
  const second = useDestination.getState().cover!;
  expect(second).not.toBe(first);
  expect(faceOf(root, wanted.id)!.props.nativeID).toBe(second);
  expect(opacityOf(faceOf(root, wanted.id)!)).toBe(1);
  unmount(root);
});

test("a card lifted after the Tabs cut but before the deck's entrance commits stays lifted: the entrance doesn't hide its face and bar, and after the hand-over its face never shows again until it is lifted again", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const root = renderSurface(<Surfaces />);
  flush();
  const wanted = otherTab();
  const shows: boolean[] = [];
  const step = () => {
    act(() => jest.advanceTimersByTime(16));
    shows.push(shownMark(root, `dest-face:${wanted.id}`) && shownMark(root, `dest-bar:${wanted.id}`));
  };
  act(() => {
    deckPull.pageBodyShown.value = 0;
    pageBarShown.value = 0;
    pageBarPreviewShown.value = 0;
  });
  act(() => {
    liftDestination(wanted.id);
  });
  step();
  deckUp();
  step();
  expect(pageBarShown.value).toBe(1);
  expect(opacityOf(faceOf(root, wanted.id)!)).toBe(1);
  commit(wanted.id);
  for (let frame = 0; frame < 4; frame++) step();
  act(() => browse.pageCoverHidden(wanted.id, "drawn", useDestination.getState().cover!, true, 1));
  for (let frame = 0; frame < 6; frame++) step();
  const turnedOn = shows.filter((shown, at) => shown && !(shows[at - 1] ?? false)).length;
  expect(shows[0]).toBe(true);
  expect(turnedOn).toBe(1);
  expect(shows.at(-1)).toBe(false);
  expect(shownFaces(root)).toHaveLength(0);
  unmount(root);
});

test("while browsing with the deck parked, no destination mark keeps a per-frame watch: each mark is shown by its own opacity, and every one is hidden", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  expect(root.root.findAll((node) => node.props.drawn === true)).toHaveLength(0);
  const labels = root.root.findAll((node) => typeof node.props.markWhenShown === "string" && /^dest-(face|bar):/.test(node.props.markWhenShown) && node.props.jestAnimatedStyle !== undefined);
  expect(labels.length).toBeGreaterThanOrEqual(6);
  expect(labels.every((node) => (node.props.jestAnimatedStyle.value as { opacity?: number }).opacity === 0)).toBe(true);
  unmount(root);
});

const browsing = () => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
const parkedDeck = () => {
  deckUp();
  const root = renderSurface(<Surfaces />);
  flush();
  act(() => browsing());
  flush();
  return root;
};
const faceViews = (root: ReactTestRenderer) => hosts(root, "destinationFace").length;
const standaloneMarks = (root: ReactTestRenderer) =>
  root.root.findAll((node) => (node.props.testID === "destinationFaceMark" || node.props.testID === "destinationBarMark") && node.props.jestAnimatedStyle !== undefined).filter((node) => {
    for (let at: ReactTestInstance | null = node.parent; at; at = at.parent) if (at.props.testID === "destinationFace") return false;
    return true;
  }).length;

test("while browsing with 20 tabs only the cards a parked-deck tap can reach have faces: the shown card and two each side, with no mark views outside them", () => {
  withTabs(20);
  const root = parkedDeck();
  expect(deckCardIds(root).length).toBeGreaterThan(5);
  expect(faceViews(root) + standaloneMarks(root)).toBeLessThanOrEqual(6);
  expect(faceViews(root)).toBeGreaterThanOrEqual(3);
  expect(standaloneMarks(root)).toBe(0);
  expect(faceIds(root)).toContain(currentTabs().selectedId);
  unmount(root);
});

test("a parked card beyond the reach gets its face on touch-down, and every mounted card has one once the deck is shown", () => {
  withTabs(20);
  const root = parkedDeck();
  const far = deckCardIds(root).find((id) => !faceIds(root).includes(id))!;
  expect(far).toBeDefined();
  act(() => require("../state/browse/destination").pressDestination(far));
  expect(faceIds(root)).toContain(far);
  lift(far);
  expect(drawnMarks(root).sort()).toEqual(both(far));
  act(() => releaseDestination());
  flush();
  act(() => deckUp());
  flush();
  expect(faceIds(root)).toEqual(deckCardIds(root));
  unmount(root);
});
