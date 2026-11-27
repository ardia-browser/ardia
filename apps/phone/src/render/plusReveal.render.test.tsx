import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { TextInput } from "react-native";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { dismissSearch, presentSearch, searchState, typeSearch } from "../state/search/store";
import { dropEarlyStandby, earlyRevealCurrent, pressedReveal, revealStandbyOnPress, standbyPrepared, standbyShownEarly, withinPressRect } from "../state/search/standbyReveal";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { currentTabs, selectTabById, useTabs } from "../state/tabs/store";
import { floatingBarLayout } from "../components/ui";
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

let keyboard: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  cutTabSwitches(true);
  setPreference("tabSwipeHintShown", true);
  mockNativeField = false;
  keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
});

afterEach(() => {
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

const browsingNow = () => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });

type Handlers = {
  onTouchesDown: (event: object, manager: object) => void;
  onTouchesUp: (event: object, manager: object) => void;
  onTouchesCancelled: (event: object, manager: object) => void;
  onFinalize: (event: object, success: boolean) => void;
};

const SIZE = floatingBarLayout.control;

function setUp() {
  withTabs(2);
  browsingNow();
  const presses = jest.spyOn(browse, "newTab");
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <Page />
      <SearchTray />
    </DesignProvider>,
  );
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
  const waiting = () => host("trayStandby")[0]!;
  const layer = () => host("trayStandby")[0] ?? host("trayRoot")[0]!;
  const shown = () => getAnimatedStyle(layer()).opacity as number;
  const watcher = () => (getByGestureTestId("floatingBarPlusTouch") as unknown as { handlers: Handlers }).handlers;
  const manager = { fail: jest.fn(), activate: jest.fn(), begin: jest.fn(), end: jest.fn() };
  const down = (pointers = 1, x = 20, y = 20) => act(() => watcher().onTouchesDown({ numberOfTouches: pointers, changedTouches: [{ x, y }], allTouches: [{ x, y }] }, manager));
  const up = (pointers = 0, x = 20, y = 20) => act(() => watcher().onTouchesUp({ numberOfTouches: pointers, changedTouches: [{ x, y }], allTouches: [] }, manager));
  const tap = (heldMs = 40, x = 20, y = 20) => {
    down(1, 20, 20);
    act(() => jest.advanceTimersByTime(heldMs));
    up(0, x, y);
  };
  const flush = () => act(() => jest.advanceTimersByTime(20));
  const flushJS = () => act(() => jest.advanceTimersByTime(0));
  const plus = () => root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onPress === "function")[0]!;
  const dim = () => waiting().findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0]!;
  return { root, host, waiting, layer, shown, watcher, manager, down, up, tap, flush, flushJS, plus, dim, presses };
}

const revealFocusOf = (field: ReactTestInstance) => (field.props.jestAnimatedProps as { value: { revealFocus?: number } } | undefined)?.value.revealFocus ?? 0;

const fieldOf = (layer: ReactTestInstance) => layer.findAll((node) => node.type === TextInput)[0]!;

async function closeAndWait() {
  act(() => dismissSearch());
  for (let step = 0; step < 40; step++)
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
}

const finish = (root: ReactTestRenderer) => {
  unmount(root);
  keyboard.mockRestore();
};

test("an accepted touch on + shows the waiting sheet on the UI thread before any JS runs, and that one event is the press: the button's own touch release adds nothing", () => {
  const t = setUp();
  expect(t.shown()).toBe(0);
  t.tap();
  expect(t.manager.fail).toHaveBeenCalled();
  expect(t.manager.activate).not.toHaveBeenCalled();
  expect(t.shown()).toBe(1);
  expect(searchState().open).toBe(false);
  expect(t.presses).not.toHaveBeenCalled();
  act(() => t.plus().props.onPress({ nativeEvent: { changedTouches: [{ pageX: 1, pageY: 1 }], touches: [] } }));
  expect(t.presses).not.toHaveBeenCalled();
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  expect(searchState().open).toBe(true);
  act(() => jest.advanceTimersByTime(400));
  const live = t.host("trayRoot");
  expect(live).toHaveLength(1);
  expect(getAnimatedStyle(live[0]!).opacity).toBe(1);
  finish(t.root);
});

test("a screen reader's or keyboard's activation of +, which carries no touch, still opens search through the same reveal", () => {
  const t = setUp();
  act(() => t.plus().props.onPress());
  expect(t.presses).toHaveBeenCalledTimes(1);
  expect(searchState().open).toBe(true);
  expect(t.shown()).toBe(1);
  finish(t.root);
});

test("a touch that moves out and back in is a press like Pressable's, released anywhere in Pressable's retention rect; released outside it is nothing at all", () => {
  const t = setUp();
  expect(withinPressRect(SIZE + 19, -19, SIZE, SIZE)).toBe(true);
  expect(withinPressRect(20, SIZE + 29, SIZE, SIZE)).toBe(true);
  expect(withinPressRect(20, SIZE + 31, SIZE, SIZE)).toBe(false);
  expect(withinPressRect(-21, 20, SIZE, SIZE)).toBe(false);
  t.down();
  t.up(0, 20, SIZE + 200);
  t.flush();
  expect(t.shown()).toBe(0);
  expect(t.presses).not.toHaveBeenCalled();
  t.down();
  t.up(0, SIZE + 10, 10);
  expect(t.shown()).toBe(1);
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  expect(searchState().open).toBe(true);
  finish(t.root);
});

test("short and slow taps both press +: with no long press on the button, Pressable presses on release however long the hold", async () => {
  const t = setUp();
  t.tap(2000);
  expect(t.shown()).toBe(1);
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  await closeAndWait();
  expect(t.host("trayStandby")).toHaveLength(1);
  expect(t.shown()).toBe(0);
  t.tap(30);
  expect(t.shown()).toBe(1);
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(2);
  expect(searchState().open).toBe(true);
  finish(t.root);
});

test("a second finger on + makes one press, when the last finger lifts inside, never one per finger", () => {
  const t = setUp();
  t.down(1);
  t.down(2);
  t.up(1);
  t.flush();
  expect(t.shown()).toBe(0);
  expect(t.presses).not.toHaveBeenCalled();
  expect(t.manager.fail).not.toHaveBeenCalled();
  t.up(0);
  expect(t.shown()).toBe(1);
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  finish(t.root);
});

test("a touch cancelled by an overlay, a dialog or another gesture taking over never reveals or presses, and the next tap still does", () => {
  const t = setUp();
  t.down();
  act(() => t.watcher().onTouchesCancelled({ numberOfTouches: 0, changedTouches: [{ x: 20, y: 20 }], allTouches: [] }, t.manager));
  act(() => t.watcher().onFinalize({}, false));
  t.up();
  t.flush();
  expect(t.shown()).toBe(0);
  expect(t.presses).not.toHaveBeenCalled();
  t.down();
  act(() => t.watcher().onFinalize({}, false));
  t.up();
  t.flush();
  expect(t.shown()).toBe(0);
  expect(t.presses).not.toHaveBeenCalled();
  t.tap();
  expect(t.shown()).toBe(1);
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  finish(t.root);
});

test("the waiting editor is paired with its tab, layout and privacy: a press from another pairing presses without showing it early", () => {
  const t = setUp();
  const prepared = standbyPrepared.value;
  expect(prepared.generation).toBeGreaterThan(0);
  expect(prepared.tabId).toBe(currentTabs().selectedId);
  expect(revealStandbyOnPress(prepared.tabId, prepared.layout, !prepared.incognito).generation).toBe(0);
  expect(revealStandbyOnPress("elsewhere", prepared.layout, prepared.incognito).generation).toBe(0);
  expect(revealStandbyOnPress(prepared.tabId, "wide|none|1x1|1", prepared.incognito).generation).toBe(0);
  expect(standbyShownEarly.value.generation).toBe(0);
  const early = revealStandbyOnPress(prepared.tabId, prepared.layout, prepared.incognito);
  expect(early.generation).toBe(prepared.generation);
  act(() => dropEarlyStandby(early.press));
  t.flush();
  expect(t.shown()).toBe(0);
  finish(t.root);
});

test("the early reveal only shows a sheet prepared for the origin and privacy mode the press asks for; anything else waits for its own commit", async () => {
  const t = setUp();
  const prepared = standbyPrepared.value;
  revealStandbyOnPress(prepared.tabId, prepared.layout, prepared.incognito);
  expect(t.shown()).toBe(1);
  act(() => presentSearch("start", ""));
  t.flush();
  expect(standbyShownEarly.value.generation).toBe(0);
  expect(t.shown()).toBe(1);
  await closeAndWait();
  act(() => useTabs.setState({ incognito: true }));
  t.flush();
  expect(revealStandbyOnPress(prepared.tabId, prepared.layout, false).generation).toBe(0);
  act(() => useTabs.setState({ incognito: false }));
  finish(t.root);
});

test("+ pressed while a tab swipe has landed but not committed only queues: nothing shows early for the outgoing tab", () => {
  const t = setUp();
  const swipe = t.root.root.findAll((node) => Boolean(node.props.swipe?.offset) && typeof node.props.onPlus === "function")[0];
  expect(swipe).toBeDefined();
  const offset = swipe!.props.swipe.offset as { value: number };
  offset.value = 390;
  const held = t.presses.mockImplementation(() => undefined);
  t.tap();
  expect(t.shown()).toBe(0);
  t.flush();
  offset.value = 0;
  held.mockRestore();
  finish(t.root);
});

test("an older press's drop never clears a newer reveal of the same sheet", () => {
  const t = setUp();
  const prepared = standbyPrepared.value;
  const first = revealStandbyOnPress(prepared.tabId, prepared.layout, prepared.incognito);
  const second = revealStandbyOnPress(prepared.tabId, prepared.layout, prepared.incognito);
  expect(second.press).not.toBe(first.press);
  act(() => dropEarlyStandby(first.press));
  t.flush();
  expect(t.shown()).toBe(1);
  act(() => dropEarlyStandby(second.press));
  t.flush();
  expect(t.shown()).toBe(0);
  const refused = t.presses.mockImplementationOnce(() => undefined);
  t.tap();
  t.tap();
  t.flush();
  t.flush();
  expect(refused).toHaveBeenCalledTimes(2);
  expect(searchState().open).toBe(true);
  expect(t.shown()).toBe(1);
  finish(t.root);
});

test("a tap on the dim of a sheet shown early, before JS has taken the press, closes that press: search never opens", () => {
  const t = setUp();
  t.tap();
  expect(t.shown()).toBe(1);
  act(() => t.dim().props.onPressIn());
  t.flush();
  expect(t.presses).not.toHaveBeenCalled();
  expect(searchState().open).toBe(false);
  expect(t.shown()).toBe(0);
  t.tap();
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  expect(searchState().open).toBe(true);
  finish(t.root);
});

test("the native press focuses the waiting editor itself: its reveal generation reaches the field in the frame that shows the sheet, and JS asks for no focus", () => {
  mockNativeField = true;
  const t = setUp();
  const field = fieldOf(t.waiting());
  const focus = jest.spyOn(field.instance as { focus(): void }, "focus");
  focus.mockClear();
  const fieldNode = () => t.layer().findAll((node) => node.props.jestAnimatedProps !== undefined && typeof node.props.onTypedChange === "function")[0]!;
  expect(revealFocusOf(fieldNode())).toBe(0);
  const markNode = () => t.root.root.findAll((node) => node.props.testID === "traySearchUiMark" && node.props.jestAnimatedProps !== undefined)[0]!;
  const mark = () => (markNode().props.jestAnimatedProps as { value: { markWhenShown?: string } }).value.markWhenShown ?? "";
  expect(markNode().props.drawn).toBeUndefined();
  expect(mark()).toBe(`search-ui:${standbyPrepared.value.generation}`);
  t.tap();
  const generation = standbyShownEarly.value.generation;
  expect(generation).toBeGreaterThan(0);
  expect(revealFocusOf(fieldNode())).toBe(generation);
  expect(mark()).toBe(`search-ui:${generation}`);
  t.flush();
  act(() => jest.advanceTimersByTime(400));
  expect(searchState().open).toBe(true);
  expect(revealFocusOf(fieldNode())).toBe(generation);
  expect(focus).not.toHaveBeenCalled();
  finish(t.root);
});

test("a refused early reveal hands the editor back: its reveal generation returns to zero so the field blurs and clears", () => {
  mockNativeField = true;
  const t = setUp();
  const fieldNode = () => t.layer().findAll((node) => node.props.jestAnimatedProps !== undefined && typeof node.props.onTypedChange === "function")[0]!;
  t.presses.mockImplementation(() => undefined);
  t.tap();
  expect(revealFocusOf(fieldNode())).toBeGreaterThan(0);
  t.flush();
  t.flush();
  expect(revealFocusOf(fieldNode())).toBe(0);
  expect(t.shown()).toBe(0);
  finish(t.root);
});

test("text typed into the editor the press focused, before JS takes the press, opens as the search's text; a rapid reopen does the same", async () => {
  const t = setUp();
  const typeInto = (text: string) => {
    const typing = t.layer().findAll((node) => typeof node.props.onTyped === "function")[0]!;
    act(() => typing.props.onTyped(text));
  };
  const kept = t.waiting();
  t.tap();
  typeInto("ot");
  expect(searchState().open).toBe(false);
  t.flush();
  expect(searchState().open).toBe(true);
  expect(searchState().text).toBe("ot");
  act(() => jest.advanceTimersByTime(400));
  expect(t.host("trayRoot")[0] === kept).toBe(true);
  expect(searchState().text).toBe("ot");
  await closeAndWait();
  expect(t.host("trayStandby")).toHaveLength(1);
  t.tap();
  typeInto("ra");
  t.flush();
  expect(searchState().text).toBe("ra");
  act(() => jest.advanceTimersByTime(400));
  expect(searchState().text).toBe("ra");
  typeInto("rabbit");
  act(() => jest.advanceTimersByTime(40));
  expect(searchState().text).toBe("rabbit");
  finish(t.root);
});

test("rows and the frosted panel load the frame after the sheet goes live, so the first live frame only carries the editor and the solid face", () => {
  const t = setUp();
  t.tap();
  t.flushJS();
  const live = () => t.host("trayRoot")[0]!;
  const rows = () => live().findAll((node) => typeof node.type === "function" && (node.type as { name?: string }).name === "TrayRows");
  expect(rows()).toHaveLength(0);
  const frosts = () => live().findAll((node) => typeof node.type !== "string" && /Frost/.test((node.type as { displayName?: string; name?: string }).displayName ?? (node.type as { name?: string }).name ?? ""));
  expect(frosts()).toHaveLength(0);
  act(() => jest.advanceTimersByTime(20));
  expect(rows()).toHaveLength(1);
  expect(live().findAll((node) => node.props.testID === "searchPanelFace" && typeof node.type === "string")).toHaveLength(1);
  finish(t.root);
});

test("a draft queued in a private search never lands in the regular search that opens before its frame: queued text belongs to its own session and privacy", () => {
  withTabs(2);
  act(() => useTabs.setState({ incognito: true }));
  act(() => presentSearch("page", ""));
  act(() => typeSearch("secret"));
  act(() => dismissSearch());
  act(() => useTabs.setState({ incognito: false }));
  act(() => presentSearch("page", ""));
  act(() => jest.advanceTimersByTime(40));
  expect(searchState().text).toBe("");
  act(() => typeSearch("otters"));
  act(() => jest.advanceTimersByTime(40));
  expect(searchState().text).toBe("otters");
  act(() => typeSearch("otters in"));
  act(() => useTabs.setState({ incognito: true }));
  act(() => jest.advanceTimersByTime(40));
  expect(searchState().text).toBe("otters");
  act(() => useTabs.setState({ incognito: false }));
});

const typeNatively = (layer: ReactTestInstance, text: string) => act(() => fieldOf(layer).props.onChangeText(text));

test("a draft typed into the early editor is cleared before the sheet goes live when JS refuses to adopt it, so a search opened another way starts empty in field and store alike", () => {
  mockNativeField = true;
  const t = setUp();
  t.presses.mockImplementation(() => presentSearch("start", ""));
  t.tap();
  typeNatively(t.waiting(), "ot");
  expect(fieldOf(t.waiting()).props.value).toBe("ot");
  t.flush();
  act(() => jest.advanceTimersByTime(40));
  expect(searchState().open).toBe(true);
  expect(searchState().text).toBe("");
  expect(fieldOf(t.layer()).props.value).toBe("");
  finish(t.root);
});

test("a Go from the early editor after its press was refused opens nothing: only a field that owns the open search submits", () => {
  mockNativeField = true;
  const t = setUp();
  const submits = jest.spyOn(browse, "submitSearch");
  t.presses.mockImplementationOnce(() => undefined);
  t.tap();
  typeNatively(t.waiting(), "ot");
  t.flush();
  expect(searchState().open).toBe(false);
  act(() => fieldOf(t.waiting()).props.onSubmitEditing());
  expect(submits).not.toHaveBeenCalled();
  t.tap();
  t.flush();
  expect(searchState().open).toBe(true);
  typeNatively(t.layer(), "otters");
  act(() => fieldOf(t.layer()).props.onSubmitEditing());
  expect(submits).toHaveBeenCalledTimes(1);
  finish(t.root);
});

test("a tap on the dim closes the press it dismisses by token, and every earlier press on that sheet with it: two queued presses then the dim open nothing", () => {
  const t = setUp();
  t.down();
  t.up();
  t.down();
  t.up();
  expect(t.presses).not.toHaveBeenCalled();
  expect(standbyShownEarly.value.press).toBeGreaterThan(1);
  act(() => t.dim().props.onPressIn());
  t.flush();
  t.flush();
  expect(t.presses).not.toHaveBeenCalled();
  expect(searchState().open).toBe(false);
  expect(t.shown()).toBe(0);
  t.tap();
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  expect(searchState().open).toBe(true);
  finish(t.root);
});

test("once JS has taken the press and the sheet is live, the first tap on the dim closes search and nothing reopens it", async () => {
  const t = setUp();
  t.tap();
  t.flush();
  expect(searchState().open).toBe(true);
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  const dim = t.layer().findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0]!;
  act(() => dim.props.onPressIn());
  act(() => dim.props.onPress());
  expect(searchState().open).toBe(false);
  t.flush();
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  expect(searchState().open).toBe(false);
  expect(t.presses).toHaveBeenCalledTimes(1);
  finish(t.root);
});

test("the first tap on a live sheet's dim closes it even when aborting the last suggestion fetch throws", async () => {
  const t = setUp();
  t.tap();
  t.flush();
  const aborts = jest.spyOn(AbortController.prototype, "abort");
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  act(() => typeSearch("otters"));
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
  aborts.mockImplementation(() => {
    throw new Error("abort listener failed");
  });
  const dim = t.layer().findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0]!;
  expect(() => act(() => dim.props.onPressIn())).toThrow("abort listener failed");
  aborts.mockRestore();
  expect(searchState().open).toBe(false);
  finish(t.root);
});

test("the + a press opened search from stays mounted under the open sheet, hidden from touch and TalkBack, so that press's own touch-end still reaches its responder and the first dim tap after it closes search", async () => {
  const t = setUp();
  const responder = () => t.root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === "New Tab" && typeof node.props.onResponderRelease === "function")[0];
  const slot = () => t.root.root.findAll((node) => node.props.testID === "floatingBarPlusSlot" && typeof node.type === "string")[0]!;
  const pressed = responder();
  expect(pressed).toBeDefined();
  expect(slot().props.pointerEvents).toBe("box-none");
  t.down();
  t.up();
  t.flush();
  expect(searchState().open).toBe(true);
  expect(responder() === pressed).toBe(true);
  expect(slot().props.pointerEvents).toBe("none");
  expect(slot().props.importantForAccessibility).toBe("no-hide-descendants");
  act(() => pressed!.props.onResponderRelease({ nativeEvent: { changedTouches: [{ pageX: 1, pageY: 1 }], touches: [], timestamp: Date.now() }, persist: () => undefined, currentTarget: pressed, target: pressed }));
  expect(t.presses).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(1300);
  });
  const dim = t.layer().findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0]!;
  act(() => dim.props.onPressIn());
  expect(searchState().open).toBe(false);
  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(slot().props.pointerEvents).toBe("box-none");
  finish(t.root);
});

test("a press is revalidated before JS runs it: a sheet revealed for a tab that is no longer selected is refused with its draft, and the press opens the sheet prepared for the tab now shown, empty", () => {
  const t = setUp();
  const typeInto = (text: string) => {
    const typing = t.layer().findAll((node) => typeof node.props.onTyped === "function")[0]!;
    act(() => typing.props.onTyped(text));
  };
  const carried: number[] = [];
  t.presses.mockImplementation(() => {
    carried.push(pressedReveal().generation);
    presentSearch("page", "", false);
  });
  t.tap();
  const early = standbyShownEarly.value.generation;
  expect(early).toBeGreaterThan(0);
  expect(earlyRevealCurrent(standbyShownEarly.value)).toBe(true);
  typeInto("ot");
  const other = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!.id;
  act(() => selectTabById(other));
  expect(standbyPrepared.value.generation).not.toBe(early);
  expect(standbyPrepared.value.tabId).toBe(other);
  expect(earlyRevealCurrent({ generation: early, press: 1, deckTurn: 0 })).toBe(false);
  t.flush();
  expect(t.presses).toHaveBeenCalledTimes(1);
  expect(carried).toEqual([0]);
  expect(searchState().open).toBe(true);
  expect(searchState().text).toBe("");
  finish(t.root);
});
