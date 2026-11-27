import { useState } from "react";
import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable, runOnUI } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Surfaces } from "../App";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { PullGhost } from "../components/browsing/PagePull";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider, Favicon } from "../components/ui";
import { Dimensions, Image, Platform, StyleSheet, TextInput, View } from "react-native";
import { deckPull, pageBarPreviewShown, pageBarShown, pageBodyShown, previewPageBar, PULL_STAGE } from "../state/browse/deckPull";
import { advancePhoneGeneration, currentPhoneGeneration, DECK_HIT_LABELS, deckChromeOwned, deckControlsCurrent, deckReadyFor, deckTurn, followDeckChromeOnUI, releaseDeckTurnOnUI, liftDeckControl, pressDeckControl, queueDeckHit, takeDeckHit, type DeckHitCommand, type PreparedDeck } from "../state/browse/deckTurn";
import { beginDeckPull, settleDeckPull } from "../state/browse/deckPull";
import { deckCardAt, deckLeading } from "../lib/deckGeometry";
import { liftDestination } from "../state/browse/destination";
import { MenuTrigger } from "../components/ui/MenuTrigger";
import { neighbours } from "../lib/pagerPhysics";
import { sendDeckCommand } from "../state/browse/deckCommands";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { dismissSearch, presentSearch, searchState, setSearchText, useSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import { display } from "../state/search/omnibox";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { closeTabById, currentTabs, selectTabById, updateTabById } from "../state/tabs/store";
import { noteViewMoved, noteWarmPicture } from "../state/tabs/warmPictures";
import { findTab } from "../state/tabs/tabsState";
import * as pageStore from "../state/pages/store";
import * as perf from "../state/app/interactionPerf";
import { pageUi } from "../state/page/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

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
  act(() => {
    deckTurn.live.value = 0;
    deckTurn.reconciled.value = 0;
    deckTurn.press.value = null;
    deckTurn.pressed.value = "";
    deckTurn.hitMark.value = "";
    deckTurn.chromeTurn.value = 0;
    deckPull.stage.value = PULL_STAGE.idle;
    deckPull.cut.value = false;
    pageBarShown.value = 1;
    pageBodyShown.value = 1;
  });
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  cutTabSwitches(false);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function Page() {
  const tab = useSelectedTab();
  return tab ? <BrowsingScreen tabId={tab.id} /> : null;
}

const toNeighbour = () => {
  const around = neighbours(browse.swipeOrder(), currentTabs().selectedId);
  return around.right ? { id: around.right, dx: -1 } : { id: around.left!, dx: 1 };
};

function releaseSwipe(root: ReactTestRenderer, dx: number, distance: number, velocity: number) {
  act(() =>
    fireGestureHandler(getByGestureTestId("tabPager"), [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, translationX: dx * 20, translationY: 0, velocityX: dx * velocity, velocityY: 0 },
      { state: State.ACTIVE, translationX: dx * distance, translationY: 0, velocityX: dx * velocity, velocityY: 0 },
      { state: State.END, translationX: dx * distance, translationY: 0, velocityX: dx * velocity, velocityY: 0 },
    ]),
  );
  return root;
}

const arrivalPose = (root: ReactTestRenderer) => {
  const arrival = root.root.findAll((node) => node.props.testID === "pagerArrival" && typeof node.type === "string")[0];
  expect(arrival).toBeDefined();
  return { node: arrival!, at: Object.assign({}, ...((getAnimatedStyle(arrival!).transform ?? []) as object[])) as { translateX?: number } };
};

const browsingNow = () => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });

const outgoingPose = (root: ReactTestRenderer) => {
  const outgoing = root.root.findAll((node) => typeof node.type === "string" && getAnimatedStyle(node)?.transform !== undefined && (getAnimatedStyle(node).transform as object[]).some((step) => "scale" in step))[0];
  expect(outgoing).toBeDefined();
  return Object.assign({}, ...((getAnimatedStyle(outgoing!).transform ?? []) as object[])) as { translateX?: number };
};

test("an accepted bar swipe commits the neighbour within a frame of release, with no spring to wait out, and its arrival card sits full screen from that frame, hidden from TalkBack, and with no validated picture of that page it keeps touches off the page body under it", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  expect(currentTabs().selectedId).toBe(id);
  act(() => jest.advanceTimersByTime(16));
  const arrival = arrivalPose(root);
  expect(arrival.at).toMatchObject({ translateX: 0 });
  expect(arrival.node.props.pointerEvents).toBe("auto");
  expect(arrival.node.props.importantForAccessibility).toBe("no-hide-descendants");
  unmount(root);
});

test("a refused bar swipe is back in place on its release frame and keeps the tab", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const before = currentTabs().selectedId;
  const root = renderSurface(<Page />);
  releaseSwipe(root, toNeighbour().dx, 40, 0);
  expect(currentTabs().selectedId).toBe(before);
  expect(outgoingPose(root)).toMatchObject({ translateX: 0 });
  unmount(root);
});

test("a swipe whose target closes before the commit arrives keeps the tab it started from and puts the page back", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const before = currentTabs().selectedId;
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  releaseSwipe(root, dx, 260, 1600);
  act(() => closeTabById(id));
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(before);
  expect(findTab(currentTabs(), id)).toBeFalsy();
  expect(outgoingPose(root)).toMatchObject({ translateX: 0 });
  unmount(root);
});

test("a swipe whose source is no longer selected when the commit arrives changes nothing", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  const elsewhere = currentTabs().open[0]!.id;
  act(() => selectTabById(elsewhere));
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(elsewhere);
  unmount(root);
});

test("an arrival's cover leaves only on its own acknowledgement: a late or unnamed one from an earlier arrival is ignored", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const cover = browse.useBrowse.getState().arrivalCover!;
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, covered: id });
  act(() => browse.pageCoverHidden(id, "drawn"));
  act(() => browse.pageCoverHidden(id, "drawn", `${browse.ARRIVAL_COVER_ID}-0`, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, arrivalCover: null });
  unmount(root);
});

test("right after a swipe lands, the bar already belongs to the destination: its address and its Address button are the new tab's", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const host = root.root.findAll((node) => node.props.testID === "floatingBarHost" && typeof node.type === "string")[0]!;
  expect(host.props.children).toBe(display(findTab(currentTabs(), id)!.url).host);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().editsPage).toBeTruthy();
  expect(currentTabs().selectedId).toBe(id);
  unmount(root);
});

test("with cuts the page bar is one bar that stays mounted under the deck: hidden, untouchable and out of TalkBack there, it holds the pressed card's address, and the release shows it and hides the deck's own bar in one UI-thread step", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
  const kept = () => host("keptPageBar")[0];
  expect(kept()).toBeDefined();
  expect(getAnimatedStyle(kept()!).opacity).toBe(0);
  const destination = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  const renders: string[] = [];
  const counting = jest.spyOn(perf, "countRender").mockImplementation((component: string) => void renders.push(component));
  act(() => previewPageBar(destination.id));
  expect(renders.filter((name) => name === "BrowsingScreen")).toEqual([]);
  counting.mockRestore();
  const preview = host("floatingBarPreviewHost").map((node) => node.props.children).flat().join("");
  expect(preview).toContain(display(destination.url).host);
  const previewLeaf = host("floatingBarPreview")[0]!;
  expect(getAnimatedStyle(previewLeaf).opacity).toBe(0);
  act(() => liftDestination(destination.id));
  act(() => jest.advanceTimersByTime(16));
  expect(getAnimatedStyle(kept()!).opacity).toBe(1);
  expect(getAnimatedStyle(previewLeaf).opacity).toBe(1);
  const source = root.root.findAll((node) => node.props.testID === "pageFrostSource" && node.props.jestAnimatedProps !== undefined)[0]!;
  expect(source.props.jestAnimatedProps.value.heldFill).toEqual(expect.any(String));
  act(() => sendDeckCommand({ kind: "open", tabId: destination.id, tappedAt: Date.now() }));
  expect(currentTabs().selectedId).toBe(destination.id);
  expect(host("keptPageBar")[0]).toBeDefined();
  act(() => jest.advanceTimersByTime(16));
  expect(root.root.findAll((node) => node.props.testID === "pageFrostSource" && typeof node.props.jestAnimatedProps?.value?.heldUntil === "string")).not.toHaveLength(0);
  expect(host("floatingBarHost").map((node) => node.props.children).flat().join("")).toContain(display(destination.url).host);
  act(() => previewPageBar(null));
  unmount(root);
});

test("with cuts a deck entrance renders neither the kept page body nor its bar: their visibility, touches and TalkBack follow one UI-thread owner", () => {
  withTabs(3);
  browsingNow();
  const root = renderSurface(<Surfaces />);
  const names: string[] = [];
  const counting = jest.spyOn(perf, "countRender").mockImplementation((component: string) => void names.push(component));
  act(() => browse.useBrowse.setState({ surface: "deck", deckEntrance: currentTabs().selectedId, frozenOrder: null }));
  expect(names.filter((name) => name === "BrowsingScreen")).toEqual([]);
  const body = root.root.findAll((node) => node.props.testID === "pageBody" && typeof node.type === "string")[0]!;
  expect(getAnimatedStyle(body).transform).toEqual([{ translateX: 100_000 }]);
  act(() => browse.useBrowse.setState({ surface: "browsing", deckEntrance: null }));
  expect(getAnimatedStyle(body).transform).toEqual([{ translateX: 0 }]);
  counting.mockRestore();
  unmount(root);
});

test("a tap on the page's Tabs button cuts to the waiting deck from its own UI-thread worklet, before any JS press handler runs", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  expect(deckPull.target.value?.id).toBe(selected);
  const press = jest.spyOn(browse, "showDeck");
  act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));
  expect(deckPull.cut.value).toBe(true);
  expect(pageBarShown.value).toBe(0);
  expect(press).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  press.mockRestore();
  unmount(root);
});

test("switching to a Duo layout in the middle of a cut revokes the phone's deck turn and gives the page back its bar and body, and returning to the phone layout owns them again from the surface", async () => {
  if (Platform.OS !== "android") return;
  const { reportScreenLayout } = require("../state/app/screenLayout") as typeof import("../state/app/screenLayout");
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  expect(deckPull.target.value?.id).toBe(selected);
  act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));
  expect(deckPull.cut.value).toBe(true);
  expect(pageBarShown.value).toBe(0);
  act(() => previewPageBar(currentTabs().open[0]!.id));
  pageBarPreviewShown.value = 1;
  act(() => reportScreenLayout({ layout: "wide" }));
  act(() => jest.advanceTimersByTime(0));
  expect(deckPull.cut.value).toBe(false);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(pageBarPreviewShown.value).toBe(0);
  expect(deckTurn.live.value).toBe(0);
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  const pages = () => root.root.findAll((node) => node.props.testID === "keptPageBar" && typeof node.type === "string");
  expect(pages()).toHaveLength(0);
  expect(currentTabs().selectedId).toBe(selected);
  act(() => reportScreenLayout({ layout: "phone" }));
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(deckPull.target.value?.id).toBe(selected);
  await layOutControls(root);
  act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));
  expect(deckPull.cut.value).toBe(true);
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

function spyScreenReaderFocus() {
  const RN = require("react-native") as typeof import("react-native");
  const native = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  jest.spyOn(RN.AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  const views = new Map<number, unknown>();
  jest.spyOn(RN, "findNodeHandle").mockImplementation((view) => {
    const handle = 100 + views.size;
    views.set(handle, view);
    return handle;
  });
  const landed: unknown[] = [];
  jest.spyOn(RN.AccessibilityInfo, "setAccessibilityFocus").mockImplementation((handle) => void landed.push(views.get(handle)));
  jest.spyOn(native, "focusViewNatively").mockImplementation((handle) => {
    landed.push(views.get(handle));
    return () => undefined;
  });
  return landed;
}

const spokenValue = (node: ReactTestInstance) => ((node.props.jestAnimatedProps?.value?.accessibilityValue ?? node.props.accessibilityValue) as { text: string } | undefined)?.text;

const focusedAddress = (root: ReactTestRenderer, view: unknown) => {
  const nodes = root.root.findAll((node) => node.instance === view && node.props.accessibilityLabel === "Address");
  return nodes.length > 0 ? (spokenValue(nodes[0]!) ?? null) : null;
};

const settleFocus = async () => {
  for (let step = 0; step < 4; step += 1) {
    await act(async () => undefined);
    act(() => jest.advanceTimersByTime(200));
  }
};

test("after a swipe hands the page over, TalkBack focus moves to the destination's Address, which is the same node that was there before the swipe", async () => {
  const landed = spyScreenReaderFocus();
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const addressNode = () => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Address")[0]!;
  const before = addressNode().instance;
  await settleFocus();
  expect(landed.length).toBe(0);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  await settleFocus();
  expect(currentTabs().selectedId).toBe(id);
  expect(addressNode().instance).toBe(before);
  expect(spokenValue(addressNode())).toBe(display(findTab(currentTabs(), id)!.url).host);
  expect(landed.length).toBe(1);
  expect(focusedAddress(root, landed[0])).toBe(display(findTab(currentTabs(), id)!.url).host);
  unmount(root);
});

test("a deck select moves TalkBack focus to the destination's Address once the deck has handed the page over", async () => {
  const landed = spyScreenReaderFocus();
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  await settleFocus();
  landed.length = 0;
  const wanted = currentTabs().open[0]!.id;
  act(() => sendDeckCommand({ kind: "open", tabId: wanted, tappedAt: Date.now() }));
  await settleFocus();
  expect(currentTabs().selectedId).toBe(wanted);
  const address = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Address" && spokenValue(node) === display(findTab(currentTabs(), wanted)!.url).host);
  expect(address).toHaveLength(1);
  expect(landed.length).toBe(1);
  expect(focusedAddress(root, landed[0])).toBe(display(findTab(currentTabs(), wanted)!.url).host);
  unmount(root);
});

test("a card tapped in the deck is the open tab at once: the deck hands straight to the page, with no growth and no bar hand-over", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const wanted = currentTabs().open[0]!.id;
  act(() => sendDeckCommand({ kind: "open", tabId: wanted, tappedAt: Date.now() }));
  expect(browse.useBrowse.getState()).toMatchObject({ surface: "browsing", opening: null });
  expect(currentTabs().selectedId).toBe(wanted);
  unmount(root);
});

test("a tray raised by + is at rest with its dim on its first frame, without waiting for the keyboard or a landing delay", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  presentSearch("page", "");
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const panel = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
  const lift = ((getAnimatedStyle(panel).transform ?? []) as { translateY?: number }[]).find((step) => step.translateY !== undefined)?.translateY ?? 0;
  expect(lift).toBeLessThanOrEqual(0);
  const dim = root.root.findAll((node) => node.props.testID === "trayDim" && typeof node.type === "string")[0]!;
  expect(getAnimatedStyle(dim).opacity).toBe(1);
  unmount(root);
  keyboard.mockRestore();
});

test("a first-use sheet waits lifted where the soft keyboard will be with no timer to drop it, and starts at rest when a hardware keyboard is attached", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const native = require("@ardia/phone-native") as { hardwareKeyboardShown: () => boolean };
  const lifted = (hardware: boolean) => {
    const attached = jest.spyOn(native, "hardwareKeyboardShown").mockImplementation(() => hardware);
    presentSearch("page", "");
    const root = renderSurface(
      <DesignProvider design="redesigned">
        <SearchTray />
      </DesignProvider>,
      { flushTimers: false },
    );
    const lift = () => {
      const panel = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
      return ((getAnimatedStyle(panel).transform ?? []) as { translateY?: number }[]).find((step) => step.translateY !== undefined)?.translateY ?? 0;
    };
    const resting = lift();
    act(() => jest.advanceTimersByTime(100));
    const early = lift();
    act(() => jest.advanceTimersByTime(1500));
    const late = lift();
    unmount(root);
    act(() => dismissSearch());
    act(() => jest.advanceTimersByTime(4000));
    attached.mockRestore();
    return { resting, early, late };
  };
  const soft = lifted(false);
  expect(soft.early).toBeLessThan(soft.resting);
  expect(soft.late).toBe(soft.early);
  const hard = lifted(true);
  expect(hard.late).toBe(hard.resting);
  keyboard.mockRestore();
});

test("the next search sheet waits laid out and hidden, its field made but unfocused; + turns that same sheet and field live instead of mounting them, and no second sheet is made while it is up", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
  expect(host("trayStandby")).toHaveLength(1);
  expect(host("trayRoot")).toHaveLength(0);
  const waitingField = host("trayFieldCapsule");
  expect(waitingField).toHaveLength(1);
  const waiting = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
  act(() => presentSearch("page", ""));
  expect(host("trayRoot")).toHaveLength(1);
  expect(host("trayFieldCapsule")).toContain(waitingField[0]);
  expect(root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")).toContain(waiting);
  expect(host("trayStandby")).toHaveLength(0);
  unmount(root);
  keyboard.mockRestore();
});

test("+ shows and focuses the waiting sheet before React renders it live: the press itself reveals it, and the live commit changes nothing on screen", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
  const waiting = host("trayStandby")[0]!;
  expect(getAnimatedStyle(waiting).opacity).toBe(0);
  const input = waiting.findAll((node) => node.type === TextInput)[0]!;
  const focus = jest.spyOn(input.instance as { focus(): void }, "focus");
  presentSearch("page", "");
  expect(host("trayRoot")).toHaveLength(0);
  expect(getAnimatedStyle(waiting).opacity).toBe(1);
  expect(focus).toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  expect(host("trayRoot")).toHaveLength(1);
  expect(host("trayRoot")[0] === waiting).toBe(true);
  expect(getAnimatedStyle(waiting).opacity).toBe(1);
  unmount(root);
  keyboard.mockRestore();
});

test("a keystroke in the frame right after + lands in the new search, before React has rendered the sheet live", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const typing = waiting.findAll((node) => typeof node.props.onTyped === "function")[0]!;
  presentSearch("page", "");
  typing.props.onTyped("o");
  expect(searchState().open).toBe(true);
  await act(async () => {
    jest.advanceTimersByTime(20);
  });
  expect(searchState().text).toBe("o");
  unmount(root);
  keyboard.mockRestore();
});

test("a field-version reset at the press keeps the input the reveal focused", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  act(() => useSearch.setState({ fieldVersion: 3 }));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const focused = waiting.findAll((node) => node.type === TextInput)[0]!;
  presentSearch("page", "");
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  const live = root.root.findAll((node) => node.props.testID === "trayRoot" && typeof node.type === "string")[0]!;
  expect(live.findAll((node) => node.type === TextInput)[0] === focused).toBe(true);
  unmount(root);
  keyboard.mockRestore();
});

test("after an Address sheet is dismissed, the waiting + sheet carries no edit-this-page row", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const tab = currentTabs().open[0]!;
  act(() => presentSearch("page", tab.url, null, { currentUrl: tab.url, currentTabId: tab.id }));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  act(() => dismissSearch());
  for (let step = 0; step < 40; step++)
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  expect(searchState().editsPage).toBeTruthy();
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  expect(waiting.findAll((node) => node.props.testID === "trayCurrentPageRow" && typeof node.type === "string")).toHaveLength(0);
  unmount(root);
  keyboard.mockRestore();
});

test("a tap on the dim of a sheet + revealed before React rendered it live closes that search", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const dim = waiting.findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0]!;
  presentSearch("page", "");
  expect(searchState().open).toBe(true);
  dim.props.onPressIn();
  expect(searchState().open).toBe(false);
  unmount(root);
  keyboard.mockRestore();
});

test("the waiting + sheet carries no live frost behind the page: its panel shows the precomposited solid face until it goes live", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const frosts = waiting.findAll((node) => typeof node.type !== "string" && /Frost/.test((node.type as { displayName?: string; name?: string }).displayName ?? (node.type as { name?: string }).name ?? ""));
  expect(frosts).toHaveLength(0);
  expect(waiting.findAll((node) => node.props.testID === "searchPanelFace" && typeof node.type === "string")).toHaveLength(1);
  unmount(root);
  keyboard.mockRestore();
});

test("while you browse, the waiting + sheet is a minimal shell with no rows mounted, and the bar's neighbour addresses are plain leaves, not buttons", () => {
  withTabs(3);
  browsingNow();
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const tray = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = tray.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  expect(waiting.findAll((node) => node.props.testID === "searchPanelRowsScroll")).toHaveLength(0);
  unmount(tray);
  keyboard.mockRestore();
  const page = renderSurface(<Page />);
  const leaves = page.root.findAll((node) => (node.props.testID === "floatingBarLandedLeft" || node.props.testID === "floatingBarLandedRight") && typeof node.type === "string");
  expect(leaves.length).toBeGreaterThan(0);
  for (const leaf of leaves) expect(leaf.findAll((node) => node.props.accessibilityRole === "button")).toHaveLength(0);
  unmount(page);
});

test("a search that opens with text waits for its own commit: the waiting empty sheet is not shown early", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  presentSearch("page", "example.com");
  expect(getAnimatedStyle(waiting).opacity).toBe(0);
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  unmount(root);
  keyboard.mockRestore();
});

test("a search that opens with text, such as editing the address, gets a field of its own rather than the waiting empty one", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const fields = () => root.root.findAll((node) => node.props.testID === "trayFieldCapsule" && typeof node.type === "string");
  const waiting = fields()[0]!;
  act(() => presentSearch("page", "example.com"));
  const live = root.root.findAll((node) => node.props.testID === "trayRoot" && typeof node.type === "string")[0]!;
  const liveField = live.findAll((node) => node.props.testID === "trayFieldCapsule" && typeof node.type === "string")[0]!;
  expect(liveField).not.toBe(waiting);
  unmount(root);
  keyboard.mockRestore();
});

test("a dismissed query never comes back in the next + sheet: the waiting field starts empty", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  act(() => presentSearch("page", ""));
  act(() => setSearchText("otters"));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  act(() => dismissSearch());
  for (let step = 0; step < 40; step++)
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  const standby = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0];
  expect(standby).toBeDefined();
  const starts = standby!.findAll((node) => typeof node.props.start === "string").map((node) => node.props.start);
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) expect(start).toBe("");
  unmount(root);
  keyboard.mockRestore();
});

test("TalkBack's next and previous tab go through the swipe's own checks: a page that is no longer the selected tab can't switch tabs", () => {
  withTabs(3);
  const shown = currentTabs().open[1]!.id;
  selectTabById(shown);
  browsingNow();
  const root = renderSurface(<BrowsingScreen tabId={shown} />);
  const stepper = root.root.findAll((node) => typeof node.props.onStep === "function")[0]!;
  const elsewhere = currentTabs().open[0]!.id;
  act(() => selectTabById(elsewhere));
  act(() => stepper.props.onStep(1));
  act(() => stepper.props.onStep(-1));
  expect(currentTabs().selectedId).toBe(elsewhere);
  unmount(root);
});

test("an Address tap in the frames between a swipe landing and its commit opens search for the destination, not the tab it left", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(id);
  expect(searchState().open).toBe(true);
  expect(searchState().editsPage).toBeTruthy();
  unmount(root);
});

test("a More tap between a swipe landing and its commit opens the destination's page menu with the switch, and its two sites differ", async () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const from = currentTabs().selectedId!;
  const { id, dx } = toNeighbour();
  expect(findTab(currentTabs(), id)!.url).not.toBe(findTab(currentTabs(), from)!.url);
  releaseSwipe(root, dx, 260, 1600);
  const more = root.root.findAll((node) => node.props.accessibilityLabel === "Page Menu" && typeof node.props.onPress === "function")[0]!;
  act(() => more.props.onPress());
  expect(pageUi().menuOpen).toBe(false);
  for (let step = 0; step < 4; step++)
    await act(async () => {
      jest.advanceTimersByTime(16);
    });
  expect(currentTabs().selectedId).toBe(id);
  expect(pageUi().menuOpen).toBe(true);
  unmount(root);
});

test("a Plus tap between a swipe landing and its commit is held for that turn and opens the new-tab sheet with the switch", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  const plus = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onPress === "function")[0]!;
  act(() => plus.props.onPress());
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(id);
  expect(searchState().open).toBe(true);
  unmount(root);
});

test("an Address tap that arrives in the same JS turn as the deck's release acts on the destination, because the release opens it first", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const destination = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  act(() => previewPageBar(destination.id));
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => {
    pageBarShown.value = 1;
    browse.openTab(destination.id);
    address.props.onPress();
  });
  expect(currentTabs().selectedId).toBe(destination.id);
  expect(searchState().open).toBe(true);
  expect(searchState().initialText).toContain(display(destination.url).host);
  act(() => previewPageBar(null));
  unmount(root);
});

test("the deck-to-page cover re-checks its warm picture: once the page's view moves, it drops the picture and blocks touches to the page under it", () => {
  if (Platform.OS !== "android") return;
  withTabs(2);
  const tab = currentTabs().open[0]!;
  const uri = `file:///cover-${tab.id}.jpg`;
  act(() => updateTabById(tab.id, { snapshotFileName: uri }));
  const window = Dimensions.get("window");
  noteWarmPicture(tab.id, { uri, url: findTab(currentTabs(), tab.id)!.url, window, frame: { x: 0, y: 0, width: window.width, height: window.height }, settled: true, view: 2, viewId: 21 });
  act(() => pageStore.storeNavigation(tab.id, { isLive: true, isLoading: true, url: tab.url, title: "Site", failure: null, progress: 0 } as never));
  browse.noteCutCard(tab.id, 200);
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  const coverNode = () => root.root.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")[0];
  expect(coverNode()).toBeDefined();
  {
    expect(root.root.findAll((node) => node.props.testID === "pageCoverWarmPicture" && typeof node.type === "string")).toHaveLength(1);
    expect(coverNode()!.props.pointerEvents).toBe("none");
    act(() => noteViewMoved(tab.id, 21, 3));
    expect(root.root.findAll((node) => node.props.testID === "pageCoverWarmPicture" && typeof node.type === "string")).toHaveLength(0);
    expect(coverNode()!.props.pointerEvents).toBe("auto");
  }
  unmount(root);
});

test("an action held for a swipe is dropped by any other navigation before its commit, so it never fires on a later visit", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  browse.holdBarAction(currentTabs().open[2]!.id, "address", "swipe:999");
  act(() => browse.openTab(currentTabs().open[0]!.id));
  expect(browse.takeBarAction("swipe:999", currentTabs().open[2]!.id)).toBeNull();
});

test("a page counts as drawn only for the document it is showing now: a draw of an earlier document doesn't let a cover go", () => {
  withTabs(2);
  const id = currentTabs().open[0]!.id;
  act(() => pageStore.storeNavigation(id, { ...pageStore.pageNavigation(id), isLive: true, isLoading: false, url: "https://site0.example/", document: 4 } as never));
  act(() => browse.pageDrawn(id, 3));
  expect(browse.documentWasDrawn(id)).toBe(false);
  act(() => browse.pageDrawn(id, 4));
  expect(browse.documentWasDrawn(id)).toBe(true);
});

test("on Android a cover acknowledgement must name the document whose drawn frame hid it; one without leaves the cover up", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const cover = browse.useBrowse.getState().arrivalCover!;
  act(() => browse.pageCoverHidden(id, "drawn", cover, true));
  if (Platform.OS === "android") expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover, true, 7));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null });
  unmount(root);
});

test("on a cut to the deck the page bar's Search Tabs ghost never draws, so only the deck's own field shows that label", () => {
  const root = renderSurface(<PullGhost style={undefined}><Image source={{ uri: "file:///ghost.png" }} /></PullGhost>);
  const ghost = () => root.root.findAll((node) => node.props.testID === "pullGhost" && typeof node.type === "string")[0]!;
  act(() => {
    deckPull.target.value = { id: "t0" } as never;
    deckPull.stage.value = PULL_STAGE.landed;
    deckPull.cut.value = true;
  });
  expect(getAnimatedStyle(ghost()).opacity).toBe(0);
  act(() => {
    deckPull.cut.value = false;
    deckPull.stage.value = PULL_STAGE.idle;
    deckPull.target.value = null;
  });
  unmount(root);
});

test("a menu's opener opens it at once when its trigger is live, and holds the open until a disabled trigger comes live", () => {
  if (Platform.OS !== "android") return;
  const opened = jest.fn();
  const opener: { current: (() => void) | null } = { current: null };
  const items = [{ title: "One", onPress: () => undefined }] as never;
  let enable: () => void = () => undefined;
  function Host() {
    const [disabled, setDisabled] = useState(true);
    enable = () => setDisabled(false);
    return (
      <MenuTrigger opener={opener} items={items} trigger="tap" disabled={disabled} onOpen={opened}>
        {() => <View />}
      </MenuTrigger>
    );
  }
  const root = renderSurface(<Host />);
  act(() => opener.current?.());
  expect(opened).not.toHaveBeenCalled();
  act(() => enable());
  expect(opened).toHaveBeenCalledTimes(1);
  act(() => opener.current?.());
  expect(opened).toHaveBeenCalledTimes(2);
  unmount(root);
});

test("a cover acknowledgement that names the arrival's cover but found no view leaves the cover up", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const cover = browse.useBrowse.getState().arrivalCover!;
  act(() => browse.pageCoverHidden(id, "drawn", cover, false, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => jest.advanceTimersByTime(1000));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null });
  unmount(root);
});

test("a cut card width is used once: the next open of the same tab doesn't inherit it, and opening the deck forgets it", () => {
  browse.noteCutCard("t1", 200);
  expect(browse.takeCutCardWidth("t1")).toBe(200);
  expect(browse.takeCutCardWidth("t1")).toBeNull();
  browse.noteCutCard("t1", 200);
  browse.clearCutCard();
  expect(browse.takeCutCardWidth("t1")).toBeNull();
});

test("a favicon another view already resolved shows its icon on its own first frame, never the letter tile first", () => {
  const icon = (root: ReactTestRenderer) => root.root.findAll((node) => node.type === Image).length;
  const first = renderSurface(<Favicon iconUrl="https://site.example/favicon.ico" pageUrl="https://site.example/" size={32} />);
  act(() => jest.advanceTimersByTime(16));
  expect(icon(first)).toBe(1);
  const second = renderSurface(<Favicon iconUrl="https://site.example/favicon.ico" pageUrl="https://site.example/" size={32} />);
  expect(icon(second)).toBe(1);
  unmount(first);
  unmount(second);
});

test("a swipe's neighbour shows its own last picture at the geometry it was captured at, and only its title card once that page's view has moved", async () => {
  withTabs(3);
  browsingNow();
  const { id } = toNeighbour();
  const uri = `file:///warm-${id}.jpg`;
  act(() => updateTabById(id, { snapshotFileName: uri }));
  const neighbour = findTab(currentTabs(), id)!;
  const window = Dimensions.get("window");
  const frame = { x: 0, y: 0, width: window.width, height: window.height - 40 };
  noteWarmPicture(id, { uri, url: neighbour.url, window, frame, settled: true, view: 3, viewId: 11 });
  const pictures = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "pagerWarmPicture" && typeof node.type === "string");
  const warm = renderSurface(<Page />);
  expect(pictures(warm)).toHaveLength(1);
  expect(pictures(warm)[0]!.props.source).toEqual({ uri });
  expect(StyleSheet.flatten(pictures(warm)[0]!.props.style)).toMatchObject({ top: 0, height: window.height - 40 });
  act(() => noteViewMoved(id, 11, 4));
  expect(pictures(warm)).toHaveLength(0);
  const inNeighbour = (node: ReactTestInstance) => {
    for (let at = node.parent; at; at = at.parent) if ((at.type as { name?: string }).name === "PagerNeighbour") return true;
    return false;
  };
  const rasters = warm.root.findAll((node) => typeof node.type === "string" && JSON.stringify(node.props.source ?? null).includes(uri) && inNeighbour(node));
  expect(rasters).toHaveLength(0);
  unmount(warm);
});

const unlaidStandbyDeck = () => {
  withTabs(3);
  browsingNow();
  const { setRootSize } = require("../state/app/rootSize") as typeof import("../state/app/rootSize");
  act(() => setRootSize(393, 873));
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  return root;
};

const standbyDeck = async () => {
  const root = unlaidStandbyDeck();
  await layOutControls(root);
  return root;
};

const tapTabs = () => act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));

const hostWith = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];

const animatedProp = (node: ReactTestInstance, name: string) => (node.props.jestAnimatedProps?.value as Record<string, unknown> | undefined)?.[name] ?? node.props[name];

const shownMark = (root: ReactTestRenderer, id: string) => {
  const node = root.root.findAll((each) => each.props.testID === id && each.props.jestAnimatedStyle !== undefined && each.props.markWhenShown !== undefined)[0];
  expect(node).toBeDefined();
  return getAnimatedStyle(node!).opacity === 1 ? (node!.props.markWhenShown as string) : "";
};

const markOf = (root: ReactTestRenderer, id: string) => {
  if (id !== "deckHitMark") return shownMark(root, id);
  const shown = DECK_HIT_LABELS.map((control) => shownMark(root, `deckHitMark-${control}`)).filter((mark) => mark !== "");
  expect(shown.length).toBeLessThanOrEqual(1);
  return shown[0] ?? "";
};

const CONTROL_BOXES = {
  more: { x: 330, y: 0, width: 44, height: 44 },
  search: { x: 70, y: 0, width: 250, height: 48 },
  plus: { x: 330, y: 0, width: 48, height: 48 },
  privacy: { x: 16, y: 0, width: 48, height: 48 },
} as const;

const layOutControls = async (root: ReactTestRenderer) => {
  for (const [control, layout] of Object.entries(CONTROL_BOXES)) {
    const host = hostWith(root, `deckHit-${control}`);
    expect(host).toBeDefined();
    act(() => host!.props.onLayout({ nativeEvent: { layout } }));
  }
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(16));
};

const centreOf = (control: keyof typeof CONTROL_BOXES) => {
  const bounds = deckTurn.prepared.value!.controls[control]!;
  return { absoluteX: (bounds.left + bounds.right) / 2, absoluteY: (bounds.top + bounds.bottom) / 2, x: 1, y: 1 };
};

const pressControl = (control: keyof typeof CONTROL_BOXES) => {
  const at = centreOf(control);
  act(() => fireGestureHandler(getByGestureTestId(`deckHit:${control}`), [{ state: State.BEGAN, ...at }, { state: State.ACTIVE, ...at }, { state: State.END, ...at }]));
};

test("while the page owns input the deck waits laid out under it with one prepared snapshot: the selected tab, the order, a privacy and space revision, the phone layout and the real bounds of each control it has, and no Spaces control when there is no switcher", async () => {
  if (Platform.OS !== "android") return;
  const root = unlaidStandbyDeck();
  const selected = currentTabs().selectedId!;
  const prepared = deckTurn.prepared.value as PreparedDeck;
  expect(prepared.tabId).toBe(selected);
  expect(prepared.order.includes(selected)).toBe(true);
  expect(prepared.phone).toBe(currentPhoneGeneration());
  expect(typeof prepared.revision).toBe("string");
  expect(deckTurn.live.value).toBe(0);
  expect(animatedProp(hostWith(root, "tabDeck")!, "pointerEvents")).toBe("none");
  expect(animatedProp(hostWith(root, "tabDeck")!, "importantForAccessibility")).toBe("no-hide-descendants");
  expect(animatedProp(hostWith(root, "deckRedesignedChrome")!, "pointerEvents")).toBe("none");
  expect([...prepared.present].sort()).toEqual(["more", "plus", "privacy", "search"]);
  expect(deckReadyFor(selected)).toBe(false);
  const before = prepared.layout;
  await layOutControls(root);
  expect(deckReadyFor(selected)).toBe(true);
  const laid = deckTurn.prepared.value!;
  expect(laid.layout).toBeGreaterThan(before);
  const header = hostWith(root, "deckHeader")!;
  const headerTop = (StyleSheet.flatten(header.props.style) as { top: number }).top;
  expect(laid.controls.more).toEqual({ left: 330, top: headerTop, right: 374, bottom: headerTop + 44 });
  expect(laid.controls.plus!.right - laid.controls.plus!.left).toBe(48);
  expect(laid.controls.search!.left).toBe(70);
  expect(laid.controls.spaces).toBeUndefined();
  expect(hostWith(root, "deckHit-spaces")).toBeUndefined();
  unmount(root);
});

test("the Tabs worklet sets the deck's final pose and its input turn in one step: the deck takes touches and TalkBack, the page body and the pull blocker let go, and that frame is marked deck-live, before any JS runs", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  expect(getAnimatedStyle(hostWith(root, "deckCards")!).opacity).toBe(0);
  tapTabs();
  expect(deckTurn.live.value).toBeGreaterThan(0);
  expect(deckPull.cut.value).toBe(true);
  expect(pageBodyShown.value).toBe(0);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  const deck = hostWith(root, "tabDeck")!;
  expect(animatedProp(deck, "pointerEvents")).toBe("auto");
  expect(animatedProp(deck, "importantForAccessibility")).toBe("auto");
  expect(markOf(root, "deckLiveMark")).toBe("deck-live");
  expect(markOf(root, "deckDrawnMark")).toBe("deck-drawn");
  const chrome = hostWith(root, "deckRedesignedChrome")!;
  expect(animatedProp(chrome, "pointerEvents")).toBe("box-none");
  expect(animatedProp(chrome, "importantForAccessibility")).toBe("auto");
  expect(animatedProp(hostWith(root, "pageBody")!, "pointerEvents")).toBe("none");
  expect(getAnimatedStyle(deck).transform).toEqual([{ translateX: 0 }]);
  const blocker = hostWith(root, "pagePullBlocker")!;
  expect(getAnimatedStyle(blocker).transform).toEqual([{ translateX: 100_000 }]);
  const cards = hostWith(root, "deckCards")!;
  expect(getAnimatedStyle(cards).opacity).toBe(1);
  act(() => jest.advanceTimersByTime(100));
  act(() => jest.advanceTimersByTime(16));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(deckTurn.reconciled.value).toBe(deckTurn.live.value);
  expect(animatedProp(hostWith(root, "tabDeck")!, "pointerEvents")).toBe("auto");
  unmount(root);
});

test("More, Plus and the privacy switch pressed in the frames after the cut answer on the UI thread with a deck-hit mark, and JS applies the deck's entrance and that command in one dispatch", async () => {
  if (Platform.OS !== "android") return;
  for (const control of ["plus", "privacy", "more"] as const) {
    const root = await standbyDeck();
    await layOutControls(root);
    const wasIncognito = useTabs.getState().incognito;
    tapTabs();
    pressControl(control);
    expect(deckTurn.hitMark.value).toBe(`deck-hit:${control}`);
    expect(markOf(root, "deckHitMark")).toBe(`deck-hit:${control}`);
    expect(browse.useBrowse.getState().surface).toBe("browsing");
    act(() => jest.advanceTimersByTime(0));
    expect(browse.useBrowse.getState().surface).toBe("deck");
    act(() => jest.advanceTimersByTime(100));
    if (control === "plus") expect(searchState().open).toBe(true);
    if (control === "privacy") expect(useTabs.getState().incognito).toBe(!wasIncognito);
    if (control === "more") expect(root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").length).toBeGreaterThan(0);
    act(() => dismissSearch());
    act(() => useTabs.setState({ incognito: false }));
    unmount(root);
    act(() => browse.useBrowse.setState({ surface: "browsing" }));
  }
});

test("a deck control pressed once the deck's entrance has committed is left to the control itself, so nothing runs twice", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  await layOutControls(root);
  tapTabs();
  act(() => jest.advanceTimersByTime(100));
  act(() => jest.advanceTimersByTime(16));
  expect(deckTurn.reconciled.value).toBe(deckTurn.live.value);
  pressControl("plus");
  expect(deckTurn.hitMark.value).toBe("");
  act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(false);
  unmount(root);
});

const preparedAt = (controls: PreparedDeck["controls"], layout: number): PreparedDeck => ({ tabId: "t0", order: ["t0", "t1"], revision: deckTurn.revision.value, layout, phone: currentPhoneGeneration(), present: ["more"], controls });

test("a press that touches down before a standby republish and lifts after it keeps its target when the control didn't move, and is revoked when the control moved or the turn changed", () => {
  const more = { left: 330, top: 40, right: 374, bottom: 84 };
  const layout = deckTurn.layout.value;
  deckTurn.prepared.value = preparedAt({ more }, 1);
  deckTurn.layout.value = 1;
  deckTurn.live.value = 7007;
  deckTurn.reconciled.value = 0;
  expect(pressDeckControl("more", 350, 60)).toBe(true);
  expect(deckTurn.pressed.value).toBe("more");
  deckTurn.layout.value = 2;
  deckTurn.prepared.value = preparedAt({ more: { ...more } }, 2);
  deckTurn.reconciled.value = 7007;
  const kept = liftDeckControl("more", 352, 62);
  expect(kept).not.toBeNull();
  expect(kept!.turn).toBe(7007);
  expect(kept!.label).toBe("deck-hit:more");
  expect(deckTurn.pressed.value).toBe("");
  deckTurn.reconciled.value = 0;
  expect(pressDeckControl("more", 350, 60)).toBe(true);
  deckTurn.prepared.value = preparedAt({ more: { ...more, left: 300, right: 344 } }, 3);
  expect(liftDeckControl("more", 350, 60)).toBeNull();
  deckTurn.prepared.value = preparedAt({ more }, 4);
  deckTurn.layout.value = 4;
  expect(pressDeckControl("more", 350, 60)).toBe(true);
  deckTurn.live.value = 7008;
  expect(liftDeckControl("more", 350, 60)).toBeNull();
  expect(pressDeckControl("more", 200, 400)).toBe(false);
  expect(pressDeckControl("spaces", 60, 60)).toBe(false);
  deckTurn.reconciled.value = 7008;
  expect(pressDeckControl("more", 350, 60)).toBe(false);
  deckTurn.live.value = 0;
  deckTurn.prepared.value = null;  deckTurn.layout.value = layout;
});

test("a deck command is consumed exactly once, only on its own turn: the first one of a turn wins, one stamped with an earlier screen layout is dropped, and none outlives its turn", () => {
  deckTurn.live.value = 9003;
  const hit: DeckHitCommand = { seq: 9001, turn: 9003, phone: currentPhoneGeneration(), control: "plus", label: "deck-hit:plus", deck: "t0" };
  expect(queueDeckHit(hit)).toBe(true);
  expect(queueDeckHit({ ...hit, seq: 9003, control: "privacy", label: "deck-hit:privacy" })).toBe(false);
  expect(takeDeckHit(hit)).toBe(true);
  expect(takeDeckHit(hit)).toBe(false);
  expect(queueDeckHit(hit)).toBe(false);
  deckTurn.live.value = 9004;
  const stale: DeckHitCommand = { ...hit, seq: 9002, turn: 9004, phone: currentPhoneGeneration() - 1 };
  expect(queueDeckHit(stale)).toBe(true);
  expect(takeDeckHit(stale)).toBe(false);
  deckTurn.live.value = 9005;
  const late: DeckHitCommand = { ...hit, seq: 9004, turn: 9005 };
  expect(queueDeckHit(late)).toBe(true);
  deckTurn.live.value = 0;
  expect(takeDeckHit(late)).toBe(false);
  expect(queueDeckHit({ ...hit, seq: 9005, turn: 9006 })).toBe(false);
});

test("a card command that reaches JS before the deck's entrance opens that card in the same dispatch as the entrance", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  const destination = currentTabs().open.find((tab) => tab.id !== selected)!.id;
  tapTabs();
  const turn = deckTurn.live.value;
  act(() => browse.deckHitAccepted({ seq: 9100, turn, phone: currentPhoneGeneration(), control: "card", label: "deck-hit:card", deck: selected, tabId: destination }));
  act(() => jest.advanceTimersByTime(0));
  act(() => jest.advanceTimersByTime(100));
  expect(currentTabs().selectedId).toBe(destination);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});

test("a cut JS refuses because its page is no longer in front gives the page its bar and body back and ends the deck's turn", () => {
  deckPull.cut.value = true;
  deckPull.stage.value = PULL_STAGE.handed;
  deckTurn.live.value = 11;
  pageBarShown.value = 0;
  pageBodyShown.value = 0;
  withTabs(3);
  browse.useBrowse.setState({ surface: "start" });
  act(() => browse.deckPullSettled(currentTabs().selectedId!, true, 0, "", 11, currentPhoneGeneration()));
  act(() => jest.advanceTimersByTime(16));
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(deckTurn.live.value).toBe(0);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  expect(deckPull.cut.value).toBe(false);
});

test("a cut made before a phone, Duo and back to phone round trip and delivered after it is dropped at dispatch: the page keeps its bar and body, and the next tap cuts again", async () => {
  if (Platform.OS !== "android") return;
  const { reportScreenLayout } = require("../state/app/screenLayout") as typeof import("../state/app/screenLayout");
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  tapTabs();
  expect(deckTurn.live.value).toBeGreaterThan(0);
  act(() => {
    reportScreenLayout({ layout: "wide" });
    reportScreenLayout({ layout: "phone" });
  });
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(currentTabs().selectedId).toBe(selected);
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(deckTurn.live.value).toBe(0);
  expect(deckTurn.prepared.value?.phone).toBe(currentPhoneGeneration());
  tapTabs();
  expect(deckPull.cut.value).toBe(true);
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("a Tabs tap right after an accepted swipe lands, before its commit, doesn't cut to the deck of the tab it left: it is held for the destination", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const from = currentTabs().selectedId!;
  expect(deckPull.target.value?.id).toBe(from);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  tapTabs();
  expect(deckPull.cut.value).toBe(false);
  expect(deckTurn.live.value).toBe(0);
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  expect(currentTabs().selectedId).toBe(id);
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("an accepted upward pull with cuts hands the deck its input turn on the release itself, with no frame wait or landing spring", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  act(() =>
    fireGestureHandler(getByGestureTestId("barSwipeUp"), [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, translationX: 0, translationY: -60, velocityX: 0, velocityY: -900 },
      { state: State.ACTIVE, translationX: 0, translationY: -320, velocityX: 0, velocityY: -900 },
      { state: State.END, translationX: 0, translationY: -320, velocityX: 0, velocityY: -900 },
    ]),
  );
  expect(deckTurn.live.value).toBeGreaterThan(0);
  expect(deckPull.cut.value).toBe(true);
  expect(deckPull.stage.value).toBe(PULL_STAGE.handed);
  expect(pageBodyShown.value).toBe(0);
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("deck-live and deck-drawn are shown by the same synchronous opacity update that moves the deck on screen, so the native mark lands in the traversal that draws it, and both re-arm when the turn ends", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const deck = hostWith(root, "tabDeck")!;
  expect(getAnimatedStyle(deck).transform).toEqual([{ translateX: 100_000 }]);
  expect(markOf(root, "deckLiveMark")).toBe("");
  expect(markOf(root, "deckDrawnMark")).toBe("");
  tapTabs();
  expect(getAnimatedStyle(deck).transform).toEqual([{ translateX: 0 }]);
  expect(markOf(root, "deckLiveMark")).toBe("deck-live");
  expect(markOf(root, "deckDrawnMark")).toBe("deck-drawn");
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(markOf(root, "deckDrawnMark")).toBe("deck-drawn");
  act(() => browse.openTab(currentTabs().selectedId!));
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(deckTurn.live.value).toBe(0);
  expect(markOf(root, "deckLiveMark")).toBe("");
  expect(markOf(root, "deckDrawnMark")).toBe("");
  unmount(root);
});

test("a standby whose controls haven't reported their bounds or whose privacy or space revision is stale doesn't cut: the Tabs press takes the JS path; a newer layout alone keeps the cut but refuses early control presses", () => {
  if (Platform.OS !== "android") return;
  const root = unlaidStandbyDeck();
  const selected = currentTabs().selectedId!;
  expect(deckPull.target.value?.id).toBe(selected);
  expect(deckReadyFor(selected)).toBe(false);
  tapTabs();
  expect(deckPull.cut.value).toBe(false);
  expect(deckTurn.live.value).toBe(0);
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
  const more = { left: 330, top: 40, right: 374, bottom: 84 };
  deckTurn.prepared.value = { ...preparedAt({ more }, 9), tabId: "t0" };
  deckTurn.layout.value = 9;
  expect(deckReadyFor("t0")).toBe(true);
  expect(deckControlsCurrent()).toBe(true);
  deckTurn.layout.value = 10;
  expect(deckReadyFor("t0")).toBe(true);
  expect(deckControlsCurrent()).toBe(false);
  deckTurn.live.value = 4242;
  deckTurn.reconciled.value = 0;
  expect(pressDeckControl("more", 350, 60)).toBe(false);
  deckTurn.layout.value = 9;
  expect(pressDeckControl("more", 350, 60)).toBe(true);
  deckTurn.press.value = null;
  deckTurn.live.value = 0;
  const revision = deckTurn.revision.value;
  deckTurn.revision.value = `${revision}x`;
  expect(deckReadyFor("t0")).toBe(false);
  deckTurn.revision.value = revision;
  deckTurn.prepared.value = { ...preparedAt({}, 9), tabId: "t0" };
  expect(deckReadyFor("t0")).toBe(false);
  deckTurn.prepared.value = null;
});

test("two deck controls pressed before React takes either: the first one wins and the second is refused on the UI thread", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const wasIncognito = useTabs.getState().incognito;
  tapTabs();
  pressControl("plus");
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  pressControl("privacy");
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(true);
  expect(useTabs.getState().incognito).toBe(wasIncognito);
  act(() => dismissSearch());
  unmount(root);
});

test("an early command never outlives its deck turn: a Plus queued for a turn that ended before React took it doesn't fire on the next deck opening", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  tapTabs();
  const turn = deckTurn.live.value;
  act(() => {
    browse.deckHitAccepted({ seq: 9200, turn, phone: currentPhoneGeneration(), control: "plus", label: "deck-hit:plus", deck: selected });
    deckTurn.live.value = 0;
  });
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(false);
  act(() => browse.openTab(selected));
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  await layOutControls(root);
  tapTabs();
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(searchState().open).toBe(false);
  unmount(root);
});

test("a spring landing carries the phone layout generation from the moment it started, so its completion delivered after a phone, Duo and back to phone round trip is refused", () => {
  withTabs(3);
  browsingNow();
  const id = currentTabs().selectedId!;
  const settled = jest.fn();
  const started = currentPhoneGeneration();
  act(() => {
    deckPull.target.value = { id, pull: 300 } as never;
    deckPull.stage.value = PULL_STAGE.idle;
  });
  act(() =>
    runOnUI((tab: string, done: typeof settled) => {
      "worklet";
      if (beginDeckPull(tab, 0)) settleDeckPull(true, 0, done);
    })(id, settled),
  );
  act(() => jest.advanceTimersByTime(16));
  expect(deckPull.stage.value).toBe(PULL_STAGE.landing);
  expect(deckPull.landingPhone.value).toBe(started);
  advancePhoneGeneration();
  advancePhoneGeneration();
  for (let step = 0; step < 120 && settled.mock.calls.length === 0; step++) act(() => jest.advanceTimersByTime(16));
  expect(settled).toHaveBeenCalled();
  const [, landed, , , , phone] = settled.mock.calls[0] as [string, boolean, number, string, number, number];
  expect(landed).toBe(true);
  expect(phone).toBe(started);
  act(() => browse.deckPullSettled(id, true, 0, "", 0, phone));
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  act(() => {
    deckPull.target.value = null;
  });
});

test("a card pressed in the frames after the cut poses on the UI thread at the lift and marks deck-hit:card in that same step, before any JS runs, and then opens", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  const hit = deckPull.hit.value!;
  tapTabs();
  const index = hit.ids.indexOf(selected);
  const point = { x: deckLeading(hit.g, index - hit.scroll) + hit.g.cardWidth / 2, y: hit.g.cardCenterY };
  const touch = { id: 0, ...point, absoluteX: point.x, absoluteY: point.y };
  const manager = { fail: jest.fn(), activate: jest.fn(), end: jest.fn(), begin: jest.fn() };
  const tap = getByGestureTestId("deckTap") as unknown as { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void; onTouchesUp: (event: unknown, manager: unknown) => void } };
  act(() => tap.handlers.onTouchesDown({ allTouches: [touch], changedTouches: [touch], numberOfTouches: 1 }, manager));
  act(() => tap.handlers.onTouchesUp({ allTouches: [], changedTouches: [touch], numberOfTouches: 0 }, manager));
  expect(deckTurn.hitMark.value).toBe("deck-hit:card");
  expect(markOf(root, "deckHitMark")).toBe("deck-hit:card");
  expect(pageBarPreviewShown.value).toBe(1);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(currentTabs().selectedId).toBe(selected);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});

test("while the page owns input the parked deck costs nothing on the UI thread: a hidden-deck refresh, a neighbour tab's update, frames going by and a repeated release write none of the deck's turn values, republish no snapshot and don't rebuild the Tabs gesture", async () => {
  if (Platform.OS !== "android") return;
  const { refreshHiddenDeck } = require("../state/browse/deckHold") as typeof import("../state/browse/deckHold");
  const root = await standbyDeck();
  const watched = [deckTurn.live, deckTurn.reconciled, deckTurn.pressed, deckTurn.hitMark, deckTurn.chromeTurn, deckTurn.prepared, deckTurn.layout, deckTurn.press] as { addListener: (id: number, listener: () => void) => void; removeListener: (id: number) => void }[];
  let writes = 0;
  watched.forEach((value, at) => value.addListener(4100 + at, () => void (writes += 1)));
  const layout = deckTurn.prepared.value!.layout;
  const tabsGesture = getByGestureTestId("floatingBarTabsTap");
  const neighbour = toNeighbour().id;
  act(() => refreshHiddenDeck());
  act(() => updateTabById(neighbour, { title: "Quiet Otters" }));
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(16));
  act(() => releaseDeckTurnOnUI(0));
  expect(writes).toBe(0);
  expect(deckTurn.prepared.value!.layout).toBe(layout);
  expect(getByGestureTestId("floatingBarTabsTap")).toBe(tabsGesture);
  watched.forEach((value, at) => value.removeListener(4100 + at));
  unmount(root);
});

const pressCardAtCut = (selectedOrOther: string, hit: { ids: readonly string[]; scroll: number; g: Parameters<typeof deckLeading>[0] }) => {
  const index = hit.ids.indexOf(selectedOrOther);
  const point = { x: deckLeading(hit.g, index - hit.scroll) + hit.g.cardWidth / 2, y: hit.g.cardCenterY };
  const touch = { id: 0, ...point, absoluteX: point.x, absoluteY: point.y };
  const manager = { fail: jest.fn(), activate: jest.fn(), end: jest.fn(), begin: jest.fn() };
  const tap = getByGestureTestId("deckTap") as unknown as { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void; onTouchesUp: (event: unknown, manager: unknown) => void } };
  act(() => tap.handlers.onTouchesDown({ allTouches: [touch], changedTouches: [touch], numberOfTouches: 1 }, manager));
  act(() => tap.handlers.onTouchesUp({ allTouches: [], changedTouches: [touch], numberOfTouches: 0 }, manager));
};

test("a Tabs tap before the parked controls report their bounds takes the JS path, and that deck's chrome takes touches and TalkBack as soon as it is shown", () => {
  if (Platform.OS !== "android") return;
  const root = unlaidStandbyDeck();
  tapTabs();
  expect(deckPull.cut.value).toBe(false);
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  const chrome = hostWith(root, "deckRedesignedChrome")!;
  expect(animatedProp(chrome, "pointerEvents")).toBe("box-none");
  expect(animatedProp(chrome, "importantForAccessibility")).toBe("auto");
  unmount(root);
});

test("a card pressed after Plus already took the cut's turn does nothing: no plain open reaches JS to close the search Plus opened", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  const hit = deckPull.hit.value!;
  tapTabs();
  pressControl("plus");
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  act(() => jest.advanceTimersByTime(0));
  expect(searchState().open).toBe(true);
  expect(deckTurn.reconciled.value).not.toBe(deckTurn.live.value);
  pressCardAtCut(selected, hit);
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(true);
  expect(browse.useBrowse.getState().surface).toBe("deck");
  act(() => dismissSearch());
  unmount(root);
});

test("a command delivered after its deck turn ended never reopens the deck, even with the tab it was pressed for back in front", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  tapTabs();
  const turn = deckTurn.live.value;
  act(() => {
    deckTurn.live.value = 0;
    browse.deckHitAccepted({ seq: 9300, turn, phone: currentPhoneGeneration(), control: "plus", label: "deck-hit:plus", deck: selected });
  });
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(searchState().open).toBe(false);
  unmount(root);
});

test("a window resize that stays in the phone layout keeps the parked deck ready to cut while JS is busy, but its early control presses wait until the controls are republished at the new size", async () => {
  if (Platform.OS !== "android") return;
  const { resizeRoot } = require("../state/browse/deckHold") as typeof import("../state/browse/deckHold");
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  expect(deckReadyFor(selected)).toBe(true);
  act(() => resizeRoot(411, 873));
  expect(deckReadyFor(selected)).toBe(true);
  expect(deckControlsCurrent()).toBe(false);
  tapTabs();
  expect(deckPull.cut.value).toBe(true);
  expect(deckTurn.live.value).toBeGreaterThan(0);
  const more = centreOf("more");
  expect(pressDeckControl("more", more.absoluteX, more.absoluteY)).toBe(false);
  expect(deckTurn.pressed.value).toBe("");
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  act(() => browse.openTab(selected));
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  expect(deckReadyFor(selected)).toBe(true);
  expect(deckControlsCurrent()).toBe(true);
  act(() => resizeRoot(393, 873));
  unmount(root);
});

type TurnFocus = { workletEventHandler: { worklet: (event: object) => void; eventNames: string[] } };

const focusOnTurn = (root: ReactTestRenderer) => {
  const field = root.root.findAll((node) => node.props.testID === "deckSearchField" && node.props.onFocusOnTurn !== undefined)[0]!;
  const handler = field.props.onFocusOnTurn as TurnFocus;
  expect(handler.workletEventHandler.eventNames).toEqual(["onFocus"]);
  return () => act(() => handler.workletEventHandler.worklet({}));
};

test("Search Tabs focused natively during the cut claims the turn's first command from its focus event: the keyboard keeps its native focus, deck-hit:search is marked on the UI thread, the field's own onFocus still reaches React, and nothing blurs it", async () => {
  if (Platform.OS !== "android") return;
  const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const commands = jest.spyOn(Reanimated, "dispatchCommand").mockImplementation(() => undefined);
  const root = await standbyDeck();
  const focused = focusOnTurn(root);
  tapTabs();
  focused();
  expect(deckTurn.hitMark.value).toBe("deck-hit:search");
  expect(markOf(root, "deckHitMark")).toBe("deck-hit:search");
  expect(commands).not.toHaveBeenCalled();
  const host = root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.type === "string")[0]!;
  act(() => host.props.onFocus({ nativeEvent: {} }));
  expect(counted).toHaveBeenCalledWith("search_tabs_opened");
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(searchState().open).toBe(false);
  unmount(root);
});

test("Search Tabs focused natively after Plus already took the cut's turn is blurred on the UI thread, so Plus stays the turn's only command", async () => {
  if (Platform.OS !== "android") return;
  const commands = jest.spyOn(Reanimated, "dispatchCommand").mockImplementation(() => undefined);
  const root = await standbyDeck();
  const focused = focusOnTurn(root);
  tapTabs();
  pressControl("plus");
  focused();
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  expect(commands).toHaveBeenCalledTimes(1);
  expect(commands.mock.calls[0]![1]).toBe("blur");
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(true);
  act(() => dismissSearch());
  unmount(root);
});

test("a field focused while no cut is waiting claims nothing and blurs nothing", async () => {
  if (Platform.OS !== "android") return;
  const commands = jest.spyOn(Reanimated, "dispatchCommand").mockImplementation(() => undefined);
  const root = await standbyDeck();
  focusOnTurn(root)();
  expect(deckTurn.hitMark.value).toBe("");
  expect(commands).not.toHaveBeenCalled();
  unmount(root);
});

test("Plus taken at its lift during the cut, then a card pressed after the entrance but before Plus's command has run: the card neither poses nor lifts a destination, More pressed then is swallowed, and Plus's search opens and stays open", async () => {
  if (Platform.OS !== "android") return;
  const { destination } = require("../state/browse/destination") as typeof import("../state/browse/destination");
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  const hit = deckPull.hit.value!;
  tapTabs();
  const plus = centreOf("plus");
  expect(pressDeckControl("plus", plus.absoluteX, plus.absoluteY)).toBe(true);
  const taken = liftDeckControl("plus", plus.absoluteX, plus.absoluteY)!;
  expect(taken.control).toBe("plus");
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(deckTurn.reconciled.value).toBe(deckTurn.live.value);
  const lifted = destination.turn.value;
  const phase = deckTurn.hitMark.value;
  pressCardAtCut(selected, hit);
  expect(destination.turn.value).toBe(lifted);
  expect(pageBarPreviewShown.value).toBe(0);
  expect(deckTurn.hitMark.value).toBe(phase);
  pressControl("more");
  expect(deckTurn.hitMark.value).toBe(phase);
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string")).toHaveLength(0);
  expect(browse.useBrowse.getState().surface).toBe("deck");
  act(() => browse.deckHitAccepted(taken));
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(true);
  expect(currentTabs().selectedId).toBe(selected);
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string")).toHaveLength(0);
  act(() => dismissSearch());
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  const posed = destination.turn.value;
  pressCardAtCut(selected, hit);
  expect(destination.turn.value).toBe(posed + 1);
  unmount(root);
});

const tabsButtonOf = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onPress === "function")[0]!;

const TOUCH_RELEASE = { nativeEvent: { changedTouches: [{ identifier: 0 }], touches: [] } };

const echoTabsTouch = (root: ReactTestRenderer) => act(() => tabsButtonOf(root).props.onPress(TOUCH_RELEASE));

const activateTabsWithTalkBack = (root: ReactTestRenderer) => {
  const node = root.root.findAll((each) => each.props.accessibilityLabel === "Tabs" && typeof each.props.onAccessibilityAction === "function")[0]!;
  act(() => node.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }));
};

for (const cardFirst of [true, false]) {
  test(`an early card tap during the cut opens that tab with exactly one deck entrance, and the deck never comes back, even when the Tabs press's own JS echo arrives after the card lifted (card ${cardFirst ? "before" : "after"} the entrance commit in JS)`, async () => {
    if (Platform.OS !== "android") return;
    const root = await standbyDeck();
    const selected = currentTabs().selectedId!;
    const hit = deckPull.hit.value!;
    const surfaces: string[] = [];
    const stop = browse.useBrowse.subscribe((now, was) => {
      if (now.surface !== was.surface) surfaces.push(now.surface);
    });
    const shows = jest.spyOn(browse, "showDeck");
    tapTabs();
    if (!cardFirst) act(() => jest.advanceTimersByTime(0));
    pressCardAtCut(selected, hit);
    expect(deckTurn.hitMark.value).toBe("deck-hit:card");
    echoTabsTouch(root);
    for (let step = 0; step < 60; step++) act(() => jest.advanceTimersByTime(50));
    stop();
    expect(surfaces).toEqual(["deck", "browsing"]);
    expect(shows).not.toHaveBeenCalled();
    expect(currentTabs().selectedId).toBe(selected);
    expect(browse.useBrowse.getState().surface).toBe("browsing");
    unmount(root);
  });
}

test("a TalkBack activation of Tabs, which has no touch, still opens the deck", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  activateTabsWithTalkBack(root);
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("a TalkBack activation of Tabs right after a tap was handled on the UI thread is not taken for that tap's echo: it opens the deck again", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  tapTabs();
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  act(() => browse.openTab(selected));
  act(() => jest.advanceTimersByTime(16));
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  activateTabsWithTalkBack(root);
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("a second deliberate Tabs tap cuts again on its own, and neither tap's touch echo, however late, opens the deck a second time", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  const shows = jest.spyOn(browse, "showDeck");
  const entrances: string[] = [];
  const stop = browse.useBrowse.subscribe((now, was) => {
    if (now.surface !== was.surface) entrances.push(now.surface);
  });
  tapTabs();
  echoTabsTouch(root);
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  act(() => browse.openTab(selected));
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  await layOutControls(root);
  tapTabs();
  expect(deckPull.cut.value).toBe(true);
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  act(() => jest.advanceTimersByTime(5000));
  echoTabsTouch(root);
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  stop();
  expect(shows).not.toHaveBeenCalled();
  expect(entrances).toEqual(["deck", "browsing", "deck"]);
  unmount(root);
});

test("the Tabs tap's JS fallback carries the phone layout generation it was tapped in, so one delivered after a phone, Duo and back to phone round trip opens nothing", async () => {
  if (Platform.OS !== "android") return;
  const { reportScreenLayout } = require("../state/app/screenLayout") as typeof import("../state/app/screenLayout");
  const root = unlaidStandbyDeck();
  const shows = jest.spyOn(browse, "showDeck");
  act(() => {
    fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]);
    reportScreenLayout({ layout: "wide" });
    reportScreenLayout({ layout: "phone" });
  });
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(shows).not.toHaveBeenCalled();
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});

const otherCardOnTop = (hit: { ids: readonly string[]; scroll: number; g: Parameters<typeof deckLeading>[0] }, selected: string) => {
  const y = hit.g.cardCenterY;
  for (let x = 0; x <= hit.g.width; x += 2) {
    const at = deckCardAt(hit.g, hit.ids.length, hit.scroll, x, y);
    const id = at >= 0 ? hit.ids[at] : undefined;
    if (id !== undefined && id !== selected) return { id, x, y };
  }
  throw new Error("no other card shows at the deck's centre line");
};

const pressPointAtCut = (point: { x: number; y: number }, phases: "down" | "tap" = "tap") => {
  const touch = { id: 0, ...point, absoluteX: point.x, absoluteY: point.y };
  const manager = { fail: jest.fn(), activate: jest.fn(), end: jest.fn(), begin: jest.fn() };
  const tap = getByGestureTestId("deckTap") as unknown as { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void; onTouchesUp: (event: unknown, manager: unknown) => void } };
  act(() => tap.handlers.onTouchesDown({ allTouches: [touch], changedTouches: [touch], numberOfTouches: 1 }, manager));
  if (phases === "tap") act(() => tap.handlers.onTouchesUp({ allTouches: [], changedTouches: [touch], numberOfTouches: 0 }, manager));
};

test("the deck's chrome is owned by the cut's turn from the Tabs tap through the entrance commit: its touches and TalkBack never let go in between, and a JS phase change before the commit can't take them back", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const chrome = () => hostWith(root, "deckRedesignedChrome")!;
  expect(animatedProp(chrome(), "pointerEvents")).toBe("none");
  tapTabs();
  const seen: string[] = [];
  const sample = () => seen.push(`${animatedProp(chrome(), "pointerEvents")}/${animatedProp(chrome(), "importantForAccessibility")}`);
  sample();
  act(() => jest.advanceTimersByTime(0));
  sample();
  for (let step = 0; step < 12; step++) {
    act(() => jest.advanceTimersByTime(16));
    sample();
  }
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(deckTurn.reconciled.value).toBe(deckTurn.live.value);
  expect(new Set(seen)).toEqual(new Set(["box-none/auto"]));
  unmount(root);
  deckTurn.live.value = 6100;
  deckTurn.reconciled.value = 0;
  deckTurn.chromeTurn.value = 6100;
  followDeckChromeOnUI(false);
  expect(deckTurn.chromeTurn.value).toBe(6100);
  expect(deckChromeOwned(deckTurn.live.value, deckTurn.chromeTurn.value, false)).toBe(true);
  deckTurn.reconciled.value = 6100;
  followDeckChromeOnUI(false);
  expect(deckChromeOwned(deckTurn.live.value, deckTurn.chromeTurn.value, true)).toBe(false);
  followDeckChromeOnUI(true);
  expect(deckChromeOwned(deckTurn.live.value, deckTurn.chromeTurn.value, false)).toBe(true);
  expect(deckChromeOwned(0, 6100, false)).toBe(false);
  expect(deckChromeOwned(0, 0, true)).toBe(true);
});

for (const ended of ["turn", "phone"] as const) {
  test(`a card lifted during the cut carries the turn, phone layout and deck its release worklet saw, so one delivered to JS after that ${ended === "turn" ? "deck turn was replaced" : "phone layout changed"} opens nothing`, async () => {
    if (Platform.OS !== "android") return;
    const root = await standbyDeck();
    const selected = currentTabs().selectedId!;
    const hit = deckPull.hit.value!;
    const other = otherCardOnTop(hit, selected);
    tapTabs();
    pressPointAtCut(other);
    expect(deckTurn.hitMark.value).toBe("deck-hit:card");
    const queued = jest.spyOn(browse, "deckHitAccepted");
    act(() => {
      if (ended === "turn") deckTurn.live.value += 77;
      else advancePhoneGeneration();
    });
    for (let step = 0; step < 10; step++) act(() => jest.advanceTimersByTime(50));
    expect(queued.mock.calls.filter(([command]) => command.control === "card")).toEqual([]);
    expect(currentTabs().selectedId).toBe(selected);
    unmount(root);
  });
}

test("a card lifted during the cut is queued with the turn its release worklet captured, not whatever turn is live when JS gets to it", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  const hit = deckPull.hit.value!;
  const other = otherCardOnTop(hit, selected);
  tapTabs();
  const turn = deckTurn.live.value;
  const queued = jest.spyOn(browse, "deckHitAccepted");
  pressPointAtCut(other);
  act(() => jest.advanceTimersByTime(0));
  const card = queued.mock.calls.map(([command]) => command).find((command) => command.control === "card");
  expect(card).toBeDefined();
  expect(card!.turn).toBe(turn);
  expect(card!.phone).toBe(currentPhoneGeneration());
  expect(card!.deck).toBe(selected);
  expect(card!.tabId).toBe(other.id);
  for (let step = 0; step < 10; step++) act(() => jest.advanceTimersByTime(100));
  expect(currentTabs().selectedId).toBe(other.id);
  unmount(root);
});

test("a card touched down while a command the cut took is still pending prepares no destination: the pending check comes before the card's press", async () => {
  if (Platform.OS !== "android") return;
  const { usePageBarPreview } = require("../state/browse/deckPull") as typeof import("../state/browse/deckPull");
  const { useDestination } = require("../state/browse/destination") as typeof import("../state/browse/destination");
  const root = await standbyDeck();
  const selected = currentTabs().selectedId!;
  const hit = deckPull.hit.value!;
  const other = otherCardOnTop(hit, selected);
  tapTabs();
  const plus = centreOf("plus");
  expect(pressDeckControl("plus", plus.absoluteX, plus.absoluteY)).toBe(true);
  const taken = liftDeckControl("plus", plus.absoluteX, plus.absoluteY)!;
  expect(taken).not.toBeNull();
  pressPointAtCut(other, "down");
  act(() => jest.advanceTimersByTime(0));
  expect(usePageBarPreview.getState().id).toBeNull();
  expect(useDestination.getState().prepared).not.toBe(other.id);
  act(() => browse.deckHitAccepted(taken));
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(true);
  act(() => dismissSearch());
  unmount(root);
});

test("a pull settle stamped with an earlier phone layout is dropped before it touches anything, so a tap noted while the current layout's deck lands still opens its card", () => {
  const { useDeckCommand } = require("../state/browse/deckCommands") as typeof import("../state/browse/deckCommands");
  withTabs(3);
  browsingNow();
  const id = currentTabs().selectedId!;
  const other = currentTabs().open.find((tab) => tab.id !== id)!.id;
  const stale = currentPhoneGeneration();
  advancePhoneGeneration();
  act(() => browse.noteDeckTapWhileLanding(4242));
  act(() => browse.deckPullSettled(id, true, 0, other, 0, stale));
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  act(() => browse.deckPullSettled(id, true, 0, other, 0, currentPhoneGeneration()));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  const command = useDeckCommand.getState().command;
  expect(command?.kind).toBe("open");
  expect(command && command.kind === "open" ? command.tappedAt : null).toBe(4242);
});

const menuItems = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string");

const TOUCH_PRESS = { nativeEvent: { changedTouches: [{ identifier: 0 }], touches: [{ identifier: 0 }], pageX: 300, pageY: 800 } };

for (const drift of [0, 15]) {
  test(`a Tabs press held past the long press with ${drift} dp of drift ends in Recent Tabs alone: the held gesture opens the menu, and Pressability's own long press or release of that touch opens nothing more`, async () => {
    if (Platform.OS !== "android") return;
    const root = await standbyDeck();
    expect(menuItems(root)).toHaveLength(0);
    act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsHold"), [{ state: State.BEGAN, absoluteX: 300, absoluteY: 800 }, { state: State.ACTIVE, absoluteX: 300 + drift, absoluteY: 800 }, { state: State.END, absoluteX: 300 + drift, absoluteY: 800 }]));
    act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.FAILED }]));
    if (drift === 0) act(() => tabsButtonOf(root).props.onLongPress(TOUCH_PRESS));
    else echoTabsTouch(root);
    for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
    expect(menuItems(root).length).toBeGreaterThan(0);
    expect(deckPull.cut.value).toBe(false);
    expect(deckTurn.live.value).toBe(0);
    expect(browse.useBrowse.getState().surface).toBe("browsing");
    unmount(root);
  });
}

test("Recent Tabs from TalkBack's long press action, which has no touch, still opens the menu with cuts on", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  const node = root.root.findAll((each) => each.props.accessibilityLabel === "Tabs" && typeof each.props.onAccessibilityAction === "function")[0]!;
  act(() => node.props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } }));
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(menuItems(root).length).toBeGreaterThan(0);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});

test("a held Tabs press made before a phone, Duo and back to phone round trip opens no menu once delivered", async () => {
  if (Platform.OS !== "android") return;
  const { reportScreenLayout } = require("../state/app/screenLayout") as typeof import("../state/app/screenLayout");
  const root = await standbyDeck();
  act(() => {
    fireGestureHandler(getByGestureTestId("floatingBarTabsHold"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]);
    reportScreenLayout({ layout: "wide" });
    reportScreenLayout({ layout: "phone" });
  });
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  expect(menuItems(root)).toHaveLength(0);
  unmount(root);
});

test("an early deck control pressed before a resize and released before its new bounds are republished runs nothing, and the controls are current again once they are republished", async () => {
  if (Platform.OS !== "android") return;
  const { resizeRoot } = require("../state/browse/deckHold") as typeof import("../state/browse/deckHold");
  const root = await standbyDeck();
  tapTabs();
  const more = centreOf("more");
  expect(pressDeckControl("more", more.absoluteX, more.absoluteY)).toBe(true);
  act(() => resizeRoot(411, 873));
  expect(deckControlsCurrent()).toBe(false);
  expect(liftDeckControl("more", more.absoluteX, more.absoluteY)).toBeNull();
  expect(deckTurn.hitMark.value).toBe("");
  expect(deckTurn.commandTurn.value).not.toBe(deckTurn.live.value);
  for (let frame = 0; frame < 20 && !deckControlsCurrent(); frame++) act(() => jest.advanceTimersByTime(16));
  expect(deckControlsCurrent()).toBe(true);
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
  expect(deckTurn.hitMark.value).toBe("");
  expect(menuItems(root)).toHaveLength(0);
  act(() => resizeRoot(393, 873));
  unmount(root);
});
