import { getAnimatedStyle } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Platform, TextInput } from "react-native";
import { Surfaces } from "../App";
import { deckPull, pageBarShown, pageBodyShown, PULL_STAGE } from "../state/browse/deckPull";
import { currentPhoneGeneration, deckTurn, type DeckHitCommand } from "../state/browse/deckTurn";
import * as browse from "../state/browse/store";
import * as system from "../platform/system";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { dismissSearch, preparedIdleKey, searchState } from "../state/search/store";
import { setSearchEngine } from "../state/search/omnibox";
import { revealStandbyFromDeck, standbyPrepared, standbyShownEarly } from "../state/search/standbyReveal";
import { setPreference } from "../state/settings/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  return { ...actual, pageReportsDrawn: () => true };
});

let mockNativeField = false;

jest.mock("../platform/completingField", () => {
  const actual = jest.requireActual<typeof import("../platform/completingField")>("../platform/completingField");
  return { ...actual, completingFieldIsNative: () => mockNativeField };
});

beforeEach(() => {
  jest.useFakeTimers();
  cutTabSwitches(true);
  setPreference("tabSwipeHintShown", true);
  mockNativeField = false;
});

afterEach(() => {
  act(() => {
    deckTurn.live.value = 0;
    deckTurn.reconciled.value = 0;
    deckTurn.press.value = null;
    deckTurn.pressed.value = "";
    deckTurn.hitMark.value = "";
    deckPull.stage.value = PULL_STAGE.idle;
    deckPull.cut.value = false;
    pageBarShown.value = 1;
    pageBodyShown.value = 1;
  });
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  cutTabSwitches(false);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const browsingNow = () => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });

const CONTROL_BOXES = {
  more: { x: 330, y: 0, width: 44, height: 44 },
  search: { x: 70, y: 0, width: 250, height: 48 },
  plus: { x: 330, y: 0, width: 48, height: 48 },
  privacy: { x: 16, y: 0, width: 48, height: 48 },
} as const;

const hostWith = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];

const layOutControls = async (root: ReactTestRenderer) => {
  for (const [control, layout] of Object.entries(CONTROL_BOXES)) {
    const host = hostWith(root, `deckHit-${control}`);
    expect(host).toBeDefined();
    act(() => host!.props.onLayout({ nativeEvent: { layout } }));
  }
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(16));
};

const standbyDeck = async () => {
  withTabs(3);
  browsingNow();
  const { setRootSize } = require("../state/app/rootSize") as typeof import("../state/app/rootSize");
  act(() => setRootSize(393, 873));
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  await layOutControls(root);
  return root;
};

const tapTabs = () => act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));

const pressPlus = () => {
  const bounds = deckTurn.prepared.value!.controls.plus!;
  const at = { absoluteX: (bounds.left + bounds.right) / 2, absoluteY: (bounds.top + bounds.bottom) / 2, x: 1, y: 1 };
  act(() => fireGestureHandler(getByGestureTestId("deckHit:plus"), [{ state: State.BEGAN, ...at }, { state: State.ACTIVE, ...at }, { state: State.END, ...at }]));
};

const sheetOf = (root: ReactTestRenderer) => hostWith(root, "trayStandby") ?? hostWith(root, "trayRoot")!;

const sheetShown = (root: ReactTestRenderer) => getAnimatedStyle(sheetOf(root)).opacity as number;

const fieldNode = (root: ReactTestRenderer) => sheetOf(root).findAll((node) => node.props.jestAnimatedProps !== undefined && typeof node.props.onTypedChange === "function")[0]!;

const animatedField = (root: ReactTestRenderer) => (fieldNode(root).props.jestAnimatedProps as { value: { revealFocus?: number } }).value;

const searchUiMark = (root: ReactTestRenderer) => {
  const node = root.root.findAll((each) => each.props.testID === "traySearchUiMark" && each.props.jestAnimatedProps !== undefined)[0]!;
  return { drawn: node.props.drawn === true, mark: (node.props.jestAnimatedProps as { value: { markWhenShown?: string } }).value.markWhenShown ?? "" };
};

const fieldOf = (layer: ReactTestInstance) => layer.findAll((node) => node.type === TextInput)[0]!;

const runJS = () => {
  for (let step = 0; step < 3; step++) act(() => jest.advanceTimersByTime(100));
};

test("a deck + claimed in the frames after the cut shows the prepared editor in the same UI step that marks deck-hit:plus, focused natively under a search-ui mark shown by the sheet's own opacity, before any JS runs; JS then adopts that very sheet", async () => {
  if (Platform.OS !== "android") return;
  mockNativeField = true;
  const root = await standbyDeck();
  const waiting = sheetOf(root);
  expect(waiting.props.testID).toBe("trayStandby");
  expect(sheetShown(root)).toBe(0);
  tapTabs();
  pressPlus();
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  const generation = standbyPrepared.value.generation;
  expect(generation).toBeGreaterThan(0);
  expect(standbyShownEarly.value.generation).toBe(generation);
  expect(standbyShownEarly.value.deckTurn).toBe(deckTurn.live.value);
  expect(sheetShown(root)).toBe(1);
  expect(animatedField(root).revealFocus).toBe(generation);
  expect(searchUiMark(root)).toEqual({ drawn: false, mark: `search-ui:${generation}` });
  expect(searchState().open).toBe(false);
  runJS();
  expect(searchState().open).toBe(true);
  expect(hostWith(root, "trayRoot") === waiting).toBe(true);
  expect(sheetShown(root)).toBe(1);
  expect(animatedField(root).revealFocus).toBe(generation);
  unmount(root);
});

test("the waiting sheet is prepared for the deck's origin, tab, layout generation and privacy: a deck + from another privacy mode, phone layout or tab shows nothing early and still opens search through JS", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  tapTabs();
  const prepared = standbyPrepared.value;
  expect(prepared.origin).toBe("page");
  expect(prepared.phone).toBe(currentPhoneGeneration());
  expect(prepared.tabId).toBe(currentTabs().selectedId);
  const turn = deckTurn.live.value;
  const hit: DeckHitCommand = { seq: 9901, turn, phone: currentPhoneGeneration(), control: "plus", label: "deck-hit:plus", deck: prepared.tabId };
  expect(revealStandbyFromDeck({ ...hit, phone: hit.phone + 1 }).generation).toBe(0);
  expect(revealStandbyFromDeck({ ...hit, deck: "elsewhere" }).generation).toBe(0);
  expect(revealStandbyFromDeck({ ...hit, turn: turn + 1 }).generation).toBe(0);
  expect(revealStandbyFromDeck({ ...hit, control: "more", label: "deck-hit:more" }).generation).toBe(0);
  const revision = deckTurn.revision.value;
  deckTurn.revision.value = `1:${revision.slice(2)}`;
  expect(revealStandbyFromDeck(hit).generation).toBe(0);
  pressPlus();
  expect(deckTurn.hitMark.value).toBe("deck-hit:plus");
  expect(standbyShownEarly.value.generation).toBe(0);
  expect(sheetShown(root)).toBe(0);
  deckTurn.revision.value = revision;
  runJS();
  expect(searchState().open).toBe(true);
  expect(sheetShown(root)).toBe(1);
  unmount(root);
});

test("text typed into the deck's early editor before JS adopts it opens as the search's text", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  tapTabs();
  pressPlus();
  const typing = sheetOf(root).findAll((node) => typeof node.props.onTyped === "function")[0]!;
  act(() => typing.props.onTyped("ot"));
  expect(searchState().open).toBe(false);
  runJS();
  expect(searchState().open).toBe(true);
  expect(searchState().text).toBe("ot");
  unmount(root);
});

test("a Go from the deck's early editor before JS adopts it is held, then submitted once by the adopted search", async () => {
  if (Platform.OS !== "android") return;
  mockNativeField = true;
  const submits = jest.spyOn(browse, "submitSearch").mockImplementation(() => true);
  const root = await standbyDeck();
  tapTabs();
  pressPlus();
  const waiting = sheetOf(root);
  act(() => fieldOf(waiting).props.onChangeText("otters"));
  act(() => fieldOf(waiting).props.onSubmitEditing());
  expect(submits).not.toHaveBeenCalled();
  runJS();
  expect(searchState().open).toBe(true);
  expect(submits).toHaveBeenCalledTimes(1);
  expect(submits.mock.calls[0]![0]).toBe("otters");
  act(() => fieldOf(sheetOf(root)).props.onSubmitEditing());
  expect(submits).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("a tap on the dim of the deck's early sheet before JS adopts it closes that press: search never opens and the deck stays", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  tapTabs();
  pressPlus();
  expect(sheetShown(root)).toBe(1);
  const dim = sheetOf(root).findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0]!;
  act(() => dim.props.onPressIn());
  runJS();
  expect(searchState().open).toBe(false);
  expect(sheetShown(root)).toBe(0);
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("a deck + whose turn ends before JS takes it hides the early sheet on the UI thread and hands its editor back, JS opens nothing, and its draft and held Go never reach a later search", async () => {
  if (Platform.OS !== "android") return;
  mockNativeField = true;
  const submits = jest.spyOn(browse, "submitSearch").mockImplementation(() => true);
  const root = await standbyDeck();
  tapTabs();
  pressPlus();
  expect(sheetShown(root)).toBe(1);
  const waiting = sheetOf(root);
  act(() => fieldOf(waiting).props.onChangeText("otters"));
  act(() => fieldOf(waiting).props.onSubmitEditing());
  act(() => {
    deckTurn.live.value = 0;
  });
  expect(sheetShown(root)).toBe(0);
  expect(animatedField(root).revealFocus).toBe(0);
  runJS();
  expect(searchState().open).toBe(false);
  expect(sheetShown(root)).toBe(0);
  act(() => browse.newTab());
  runJS();
  expect(searchState().open).toBe(true);
  expect(searchState().text).toBe("");
  expect(submits).not.toHaveBeenCalled();
  unmount(root);
});

test("a deck + that JS runs but doesn't adopt is withdrawn once the turn's command settles, and the editor's draft is cleared", async () => {
  if (Platform.OS !== "android") return;
  const root = await standbyDeck();
  jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  tapTabs();
  pressPlus();
  const typing = sheetOf(root).findAll((node) => typeof node.props.onTyped === "function")[0]!;
  act(() => typing.props.onTyped("ot"));
  runJS();
  expect(searchState().open).toBe(false);
  expect(sheetShown(root)).toBe(0);
  expect(standbyShownEarly.value.generation).toBe(0);
  unmount(root);
});

test("after a search that offered the clipboard closes, text and a Go typed into the next early deck editor still open and submit: the offer the new search drops doesn't throw away a valid reveal's draft", async () => {
  if (Platform.OS !== "android") return;
  mockNativeField = true;
  jest.spyOn(system, "clipboardOffer").mockResolvedValue("text");
  const submits = jest.spyOn(browse, "submitSearch").mockImplementation(() => true);
  const root = await standbyDeck();
  act(() => browse.newTab());
  await act(async () => {
    await Promise.resolve();
  });
  expect(searchState().rows.some((row) => row.key === "paste")).toBe(true);
  act(() => dismissSearch());
  for (let step = 0; step < 40; step++)
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  expect(searchState().open).toBe(false);
  expect(hostWith(root, "trayStandby")).toBeDefined();
  await layOutControls(root);
  tapTabs();
  pressPlus();
  expect(sheetShown(root)).toBe(1);
  const waiting = sheetOf(root);
  act(() => fieldOf(waiting).props.onChangeText("otters"));
  act(() => fieldOf(waiting).props.onSubmitEditing());
  runJS();
  expect(searchState().open).toBe(true);
  expect(searchState().text).toBe("otters");
  expect(submits).toHaveBeenCalledTimes(1);
  expect(submits.mock.calls[0]![0]).toBe("otters");
  expect(hostWith(root, "trayRoot") === waiting).toBe(true);
  unmount(root);
});

test("rows that change between an early deck + and JS taking it, here a new search engine, re-key the adopted sheet's rows but keep the draft and held Go that press typed", async () => {
  if (Platform.OS !== "android") return;
  mockNativeField = true;
  const submits = jest.spyOn(browse, "submitSearch").mockImplementation(() => true);
  const root = await standbyDeck();
  tapTabs();
  pressPlus();
  const waiting = sheetOf(root);
  act(() => fieldOf(waiting).props.onChangeText("otters"));
  act(() => fieldOf(waiting).props.onSubmitEditing());
  const before = preparedIdleKey();
  setSearchEngine("duckduckgo");
  expect(preparedIdleKey()).not.toBe(before);
  runJS();
  expect(searchState().open).toBe(true);
  expect(searchState().text).toBe("otters");
  expect(submits).toHaveBeenCalledTimes(1);
  expect(submits.mock.calls[0]![0]).toBe("otters");
  expect(hostWith(root, "trayRoot") === waiting).toBe(true);
  setSearchEngine("google");
  unmount(root);
});
