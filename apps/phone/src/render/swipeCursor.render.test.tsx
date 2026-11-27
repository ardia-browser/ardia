import { getAnimatedStyle } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Dimensions, Platform } from "react-native";
import { useSyncExternalStore } from "react";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { besideIn, heldPose, restOf, swipeRefusal, zeroArmedTurn } from "../components/browsing/TabPager";
import { FloatingBar, hereShown, landedBackHere, landedLeafShown, type SwipeAddresses } from "../components/browsing/FloatingBar";
import * as browse from "../state/browse/store";
import * as pageStore from "../state/pages/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { traceLab } from "../platform/lab";
import { searchState, dismissSearch } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { archiveTabById, currentTabs, selectTabById, useTabs } from "../state/tabs/store";
import { findTab } from "../state/tabs/tabsState";
import { display } from "../state/search/omnibox";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  return { ...actual, pageReportsDrawn: () => true };
});

let lines: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  cutTabSwitches(true);
  setPreference("tabSwipeHintShown", true);
  lines = [];
  traceLab(true, (line) => void lines.push(line));
});

afterEach(() => {
  traceLab(false);
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

const browsingNow = () => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, arrivalCover: null, leaving: null });

const width = () => Dimensions.get("window").width;

type Step = { state: State; translationX: number; velocityX: number };

function flick(dx: -1 | 1, distance = 200, velocity = 1800, ending: State = State.END) {
  const steps: Step[] = [
    { state: State.BEGAN, translationX: 0, velocityX: 0 },
    { state: State.ACTIVE, translationX: dx * 20, velocityX: dx * velocity },
    { state: State.ACTIVE, translationX: dx * distance * 0.6, velocityX: dx * velocity },
    { state: State.ACTIVE, translationX: dx * distance, velocityX: dx * velocity },
    { state: ending, translationX: dx * distance, velocityX: dx * velocity },
  ];
  act(() => fireGestureHandler(getByGestureTestId("tabPager"), steps.map((step) => ({ ...step, translationY: 0, velocityY: 0 }))));
}

const frames = (ms: number) => {
  for (let left = ms; left > 0; left -= 16) act(() => jest.advanceTimersByTime(Math.min(16, left)));
};

const opacityOf = (node: ReactTestInstance) => getAnimatedStyle(node).opacity;
const marksOf = (root: ReactTestRenderer, testID: string) => root.root.findAll((node) => node.props.testID === testID && node.props.jestAnimatedStyle !== undefined);
const outgoingX = (root: ReactTestRenderer) => {
  const outgoing = root.root.findAll((node) => typeof node.type === "string" && (getAnimatedStyle(node)?.transform as object[] | undefined)?.some((step) => "scale" in step) === true)[0]!;
  return (Object.assign({}, ...(getAnimatedStyle(outgoing).transform as object[])) as { translateX: number }).translateX;
};
function holdingJs() {
  const held: (() => void)[] = [];
  const spy = jest.spyOn(global, "queueMicrotask").mockImplementation((task) => void held.push(task));
  return {
    runFirst: () => {
      const first = held.shift();
      const waiting = held.length;
      act(() => first?.());
      act(() => jest.advanceTimersByTime(0));
      for (let pass = 0; pass < 8 && held.length > waiting; pass++) {
        const rendered = held.splice(waiting);
        act(() => rendered.forEach((task) => task()));
      }
    },
    release: () => {
      spy.mockRestore();
      act(() => held.splice(0).forEach((task) => task()));
    },
  };
}
const placeholderCount = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "pagerAhead" && typeof node.type === "string").length;
const swipeLines = () => lines.filter((line) => line.startsWith("PAGELAB swipe"));
const order = () => browse.swipeOrder();

function startAt(count: number, index: number) {
  withTabs(count);
  selectTabById(currentTabs().open[index]!.id);
  browsingNow();
  return renderSurface(<Page />);
}

test("five rapid flicks 150 to 300 ms apart, before any page draws, each advance one tab from the one on screen", () => {
  const root = startAt(7, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  const gaps = [150, 220, 300, 180];
  const covers: string[] = [];
  for (let at = 0; at < 5; at++) {
    flick(dx);
    if (at < gaps.length) frames(gaps[at]!);
    else frames(48);
    covers.push(browse.useBrowse.getState().arrivalCover ?? "");
  }
  const wanted = line[start + step * 5]!;
  expect(currentTabs().selectedId).toBe(wanted);
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: wanted, covered: wanted });
  expect(new Set(covers).size).toBe(5);
  const accepted = swipeLines().filter((entry) => entry.includes("accepted"));
  expect(accepted).toHaveLength(5);
  accepted.forEach((entry, at) => {
    expect(entry).toContain(`source=${line[start + step * at]}`);
    expect(entry).toContain(`candidate=${line[start + step * (at + 1)]}`);
    expect(entry).toMatch(/projected=-?\d+/);
  });
  unmount(root);
});

test("flicks that land before JS has run the first commit still advance in order, and none invalidates the one before", () => {
  const root = startAt(5, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  flick(dx);
  flick(dx);
  flick(dx);
  frames(64);
  expect(currentTabs().selectedId).toBe(line[start + step * 3]);
  expect(swipeLines().filter((entry) => entry.includes("refused"))).toEqual([]);
  unmount(root);
});

test("a flick back before JS has run the first commit returns to the tab still on screen and leaves no arrival card waiting on its drawn page", () => {
  const root = startAt(4, 1);
  const first = currentTabs().selectedId!;
  act(() => browse.pageDrawn(first));
  const line = order();
  const start = line.indexOf(first);
  const dx: -1 | 1 = line[start + 1] ? -1 : 1;
  flick(dx);
  flick(dx === -1 ? 1 : -1);
  frames(64);
  expect(currentTabs().selectedId).toBe(first);
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, arrivalCover: null });
  const back = marksOf(root, "pagerBackMark")[0];
  expect(back?.props.markWhenShown).toBe(`dest-face:${first}`);
  unmount(root);
});

test("a second flick from a landed tab starts at zero from it: its first travel toward the next tab holds the landed card, and travel back reveals the tab it left", () => {
  const w = width();
  expect(restOf("b", "a", "z", "b", w)).toBe(-w);
  expect(restOf("z", "a", "z", "b", w)).toBe(w);
  expect(restOf("a", "a", "z", "b", w)).toBe(0);
  expect(restOf("c", "a", "z", "b", w)).toBeNull();
  expect(heldPose(-w, -40, w)).toBe(-w);
  expect(heldPose(-w, 100, w)).toBe(-w + 100);
  expect(heldPose(-w, w * 3, w)).toBe(0);
  expect(heldPose(w, 40, w)).toBe(w);
  expect(heldPose(w, -100, w)).toBe(w - 100);
  expect(besideIn(["a", "b", "c"], "b", 1)).toBe("c");
  expect(besideIn(["a", "b", "c"], "a", -1)).toBe("");
});

test("each refused swipe logs why: no neighbour that way is an edge, too little travel is short, a lift moving back is opposed and a lost touch is cancelled", () => {
  expect(swipeRefusal("", 500, 400)).toBe("edge");
  expect(swipeRefusal("b", 120, 400)).toBe("short");
  expect(swipeRefusal("b", 260, 400)).toBe("opposed");
  const root = startAt(3, 0);
  const line = order();
  const atEdge = line.indexOf(currentTabs().selectedId!) === 0 ? 1 : -1;
  flick(atEdge as -1 | 1, 200, 1800);
  flick((-atEdge) as -1 | 1, 40, 0);
  flick((-atEdge) as -1 | 1, 200, 1800, State.CANCELLED);
  frames(32);
  const refused = swipeLines().filter((entry) => entry.includes("refused"));
  expect(refused.map((entry) => /reason=(\S+)/.exec(entry)?.[1])).toEqual(["edge", "short", "cancelled"]);
  expect(refused.every((entry) => /turn=\d+ source=\S+ candidate=\S+ projected=-?\d+/.test(entry))).toBe(true);
  unmount(root);
});

test("a refused or cancelled swipe is back at zero on its release, and its zero mark is armed for that very turn before the release and raised by it", () => {
  const root = startAt(3, 1);
  const before = currentTabs().selectedId!;
  const line = order();
  const dx: -1 | 1 = line[line.indexOf(before) + 1] ? -1 : 1;
  const zero = () => marksOf(root, "pagerZeroMark")[0]!;
  const armed = () => zero().props.jestAnimatedProps?.value?.markWhenShown as string;
  expect(armed()).toBe("swipe-zero:1");
  expect(opacityOf(zero())).toBe(0);
  flick(dx, 40, 0);
  expect(opacityOf(zero())).toBe(1);
  expect(armed()).toBe("swipe-zero:1");
  expect(outgoingX(root)).toBe(0);
  act(() => jest.advanceTimersByTime(0));
  expect(swipeLines().at(-1)).toContain("turn=1");
  flick(dx, 200, 1800, State.CANCELLED);
  expect(opacityOf(zero())).toBe(1);
  expect(outgoingX(root)).toBe(0);
  expect(armed()).toBe("swipe-zero:2");
  expect(currentTabs().selectedId).toBe(before);
  frames(32);
  expect(currentTabs().selectedId).toBe(before);
  expect(zeroArmedTurn(4, 2, 0)).toBe(5);
  expect(zeroArmedTurn(4, 4, 0)).toBe(4);
  expect(zeroArmedTurn(4, 4, 1)).toBe(5);
  unmount(root);
});

test("an accepted flick raises the landed card's face mark and the bar's mark for its destination on the release, and the bar speaks the destination before the commit", () => {
  const root = startAt(3, 1);
  const line = order();
  const from = currentTabs().selectedId!;
  const right = line[line.indexOf(from) + 1];
  const dx: -1 | 1 = right ? -1 : 1;
  const wanted = right ?? line[line.indexOf(from) - 1]!;
  const face = () => marksOf(root, "pagerFaceMark").find((node) => node.props.markWhenShown === `dest-face:${wanted}`)!;
  const bar = () => marksOf(root, "landedBarMark").find((node) => node.props.markWhenShown === `dest-bar:${wanted}`)!;
  expect(opacityOf(face())).toBe(0);
  expect(opacityOf(bar())).toBe(0);
  flick(dx);
  expect(currentTabs().selectedId).toBe(from);
  expect(opacityOf(face())).toBe(1);
  expect(opacityOf(bar())).toBe(1);
  const spoken = root.root.findAll((node) => typeof node.props.jestAnimatedProps?.value?.accessibilityValue?.text === "string").map((node) => node.props.jestAnimatedProps.value.accessibilityValue.text as string);
  expect(spoken.length > 0).toBe(Platform.OS === "android");
  expect(spoken.every((text) => text.includes(display(findTab(currentTabs(), wanted)!.url).host))).toBe(true);
  expect(hereShown(wanted, from, "", wanted)).toBe(false);
  expect(hereShown(from, from, "", wanted)).toBe(true);
  expect(hereShown("elsewhere", from, "", wanted)).toBe(true);
  expect(landedLeafShown(wanted, wanted, from)).toBe(true);
  expect(landedLeafShown(wanted, wanted, wanted)).toBe(false);
  expect(landedBackHere(from, from, from)).toBe(true);
  expect(landedBackHere("", from, from)).toBe(false);
  frames(48);
  expect(currentTabs().selectedId).toBe(wanted);
  unmount(root);
});

test("an Address tap after the second of two quick flicks is held for the latest destination, not dropped by the first commit", () => {
  const root = startAt(5, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  flick(dx);
  flick(dx);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  frames(64);
  expect(currentTabs().selectedId).toBe(line[start + step * 2]);
  expect(searchState().open).toBe(true);
  unmount(root);
});

test("five flicks 250 ms apart while JS renders nothing in between all advance, each projecting past the commit threshold from the tab the last one landed on, and a placeholder card shows each destination beyond the mounted neighbours", () => {
  const root = startAt(8, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  const travel = Math.round(width() * 0.46);
  const ahead = (id: string) => root.root.findAll((node) => node.props.testID === "pagerAhead" && node.props.jestAnimatedStyle !== undefined && node.findAll((child) => child.props.markWhenShown === `dest-face:${id}`).length > 0)[0];
  const js = holdingJs();
  for (let at = 0; at < 5; at++) {
    flick(dx, travel, 1650);
    if (at === 0) js.runFirst();
    const landedOn = line[start + step * (at + 1)]!;
    if (at >= 1 && at <= 3) {
      const card = ahead(landedOn)!;
      expect(card).toBeDefined();
      expect(opacityOf(card)).toBe(1);
      const mark = marksOf(root, "pagerAheadMark").find((node) => node.props.markWhenShown === `dest-face:${landedOn}`)!;
      expect(opacityOf(mark)).toBe(1);
    }
  }
  expect(currentTabs().selectedId).toBe(line[start]);
  js.release();
  frames(64);
  expect(currentTabs().selectedId).toBe(line[start + step * 5]);
  expect(placeholderCount(root)).toBe(0);
  const verdicts = swipeLines().filter((entry) => / turn=\d+ /.test(entry) && !/stale|closed|archived|neighbour/.test(entry));
  expect(verdicts).toHaveLength(5);
  verdicts.forEach((entry, at) => {
    expect(entry).toContain("accepted");
    expect(entry).toContain(`source=${line[start + step * at]}`);
    const projected = Math.abs(Number(/projected=(-?\d+)/.exec(entry)![1]));
    expect(projected).toBeGreaterThan(width() / 2);
    expect(Math.abs(projected - travel - 1650 * 0.12)).toBeLessThan(2);
  });
  unmount(root);
});

test("a destination archived after its lift but before the new order renders is refused against the open tabs: the source stays, the pager goes back to centre, and no cover waits for it", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const root = startAt(3, 1);
  act(() => useTabs.setState({ archive: [] }));
  const from = currentTabs().selectedId!;
  const line = order();
  const right = line[line.indexOf(from) + 1];
  const dx: -1 | 1 = right ? -1 : 1;
  const wanted = right ?? line[line.indexOf(from) - 1]!;
  flick(dx);
  act(() => {
    archiveTabById(wanted);
    jest.advanceTimersByTime(0);
  });
  frames(48);
  expect(currentTabs().selectedId).toBe(from);
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, arrivalCover: null });
  expect(outgoingX(root)).toBe(0);
  expect(swipeLines().some((entry) => entry.includes("refused") && entry.includes("reason=archived"))).toBe(true);
  frames(5_000);
  expect(browse.useBrowse.getState().arriving).toBeNull();
  unmount(root);
});

test("an Address tap after flicking there and back before either commit is held for the tab the cursor is on and opens search once the return commits", () => {
  const root = startAt(4, 1);
  const first = currentTabs().selectedId!;
  act(() => browse.pageDrawn(first));
  const line = order();
  const dx: -1 | 1 = line[line.indexOf(first) + 1] ? -1 : 1;
  flick(dx);
  flick(dx === -1 ? 1 : -1);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  frames(64);
  expect(currentTabs().selectedId).toBe(first);
  expect(searchState().open).toBe(true);
  unmount(root);
});

test("after two flicks ahead of the render, the Address speaks the tab the cursor landed on, two tabs from the one still rendered", () => {
  if (Platform.OS !== "android") return;
  const root = startAt(5, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  flick(dx);
  flick(dx);
  const wanted = line[start + step * 2]!;
  const spoken = root.root.findAll((node) => typeof node.props.jestAnimatedProps?.value?.accessibilityValue?.text === "string").map((node) => node.props.jestAnimatedProps.value.accessibilityValue.text as string);
  expect(spoken.length).toBeGreaterThan(0);
  expect(spoken.every((text) => text.includes(display(findTab(currentTabs(), wanted)!.url).host))).toBe(true);
  frames(64);
  unmount(root);
});

test("without cuts, as on iPhone, a pan begun after a spring lands but before its commit runs catches the page from the tab still rendered and drops that commit as before, so the two lifts switch one tab, not two", () => {
  cutTabSwitches(false);
  const root = startAt(4, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  const incomingAt = () => Math.min(...root.root.findAll((node) => node.props.testID === "pagerEdgeShadow" && node.props.jestAnimatedStyle !== undefined).map((node) => Math.abs((Object.assign({}, ...((getAnimatedStyle(node).transform ?? []) as object[])) as { translateX?: number }).translateX ?? width())));
  flick(dx);
  const held: (() => void)[] = [];
  const holding = jest.spyOn(global, "queueMicrotask").mockImplementation((task) => void held.push(task));
  let caught = false;
  for (let tick = 0; tick < 400 && !caught; tick++) {
    act(() => void jest.advanceTimersToNextTimer());
    caught = incomingAt() < 6;
    if (!caught) act(() => held.splice(0).forEach((task) => task()));
  }
  expect(caught).toBe(true);
  expect(currentTabs().selectedId).toBe(line[start]);
  flick(dx);
  holding.mockRestore();
  act(() => held.splice(0).forEach((task) => task()));
  act(() => jest.advanceTimersByTime(0));
  expect(currentTabs().selectedId).toBe(line[start + step]);
  frames(1_000);
  expect(currentTabs().selectedId).toBe(line[start + step]);
  expect(swipeLines().filter((entry) => entry.includes("accepted")).every((entry) => entry.includes(`source=${line[start]}`))).toBe(true);
  unmount(root);
});

test("placeholder cards are mounted only through a swipe sequence: none while idle, mounted from a pan's start, and gone once every lift has committed or been refused", () => {
  const root = startAt(8, 0);
  const placeholders = () => placeholderCount(root);
  expect(placeholders()).toBe(0);
  const line = order();
  const dx: -1 | 1 = line.indexOf(currentTabs().selectedId!) === 0 ? -1 : 1;
  const js = holdingJs();
  flick(dx);
  js.runFirst();
  flick(dx);
  expect(placeholders()).toBeGreaterThan(0);
  js.release();
  frames(64);
  expect(placeholders()).toBe(0);
  flick(dx, 40, 0);
  frames(32);
  expect(placeholders()).toBe(0);
  flick((-dx) as -1 | 1, 200, 1800, State.CANCELLED);
  frames(32);
  expect(placeholders()).toBe(0);
  unmount(root);
});

const textsIn = (node: ReactTestInstance): string[] => node.findAll((child) => typeof child.props.children === "string" && typeof child.type === "string").map((child) => child.props.children as string);

function visibleAddresses(root: ReactTestRenderer): string[] {
  const leaves = root.root.findAll((node) => typeof node.props.testID === "string" && /^floatingBar(AddressStack|Landed(Left|Self|Right))$/.test(node.props.testID) && node.props.jestAnimatedStyle !== undefined && typeof node.type === "string");
  return leaves.filter((node) => getAnimatedStyle(node).opacity !== 0).map((node) => [...new Set(textsIn(node))].join(" "));
}

function middleOfFive() {
  withTabs(5);
  browsingNow();
  const from = currentTabs().selectedId!;
  const others = browse.swipeOrder().filter((id) => id !== from);
  const line = [...others.slice(0, 2), from, ...others.slice(2)];
  browse.useBrowse.setState({ frozenOrder: line });
  expect(browse.swipeOrder()).toEqual(line);
  return { line, at: 2 };
}

for (const toward of ["right", "left"] as const)
for (const rebaseFirst of [false, true])
  test(`toward the ${toward} neighbour, from the lift through each JS turn of the commit, its render and the rebase${rebaseFirst ? ", with the UI rebase landing before the render" : ""}, the bar's visible address is the destination at every step and its bar mark rises once`, () => {
    const { line, at } = middleOfFive();
    const root = renderSurface(<Page />);
    const from = currentTabs().selectedId!;
    expect(line[at]).toBe(from);
    const dx: -1 | 1 = toward === "right" ? -1 : 1;
    const wanted = line[toward === "right" ? at + 1 : at - 1]!;
    const host = (id: string) => display(findTab(currentTabs(), id)!.url).host;
    const destination = host(wanted);
    const source = host(from);
    expect(destination).not.toBe(source);
    expect(visibleAddresses(root)).toEqual([source]);
    const held: (() => void)[] = [];
    const holding = jest.spyOn(global, "queueMicrotask").mockImplementation((task) => void held.push(task));
    const rises: string[] = [];
    const barMarks = () => marksOf(root, "landedBarMark").filter((node) => opacityOf(node) === 1).map((node) => node.props.markWhenShown as string);
    let shown = new Set(barMarks());
    const step = (label: string) => {
      const visible = visibleAddresses(root);
      expect({ label, visible }).toEqual({ label, visible: [destination] });
      const now = new Set(barMarks());
      for (const mark of now) if (!shown.has(mark)) rises.push(mark);
      shown = now;
    };
    flick(dx);
    step("lift");
    if (rebaseFirst) {
      const swipe = root.root.findAll((node) => node.type === FloatingBar)[0]!.props.swipe as SwipeAddresses;
      act(() => {
        swipe.from.value = wanted;
        swipe.offset.value = 0;
      });
      step("rebase before render");
    }
    for (let turn = 0; turn < 40 && held.length > 0; turn++) {
      const task = held.shift()!;
      act(() => task());
      step(`js turn ${turn}`);
    }
    holding.mockRestore();
    act(() => jest.advanceTimersByTime(0));
    step("timers");
    frames(64);
    step("settled");
    expect(currentTabs().selectedId).toBe(wanted);
    expect(rises).toEqual([`dest-bar:${wanted}`]);
    unmount(root);
  });

const lagging = { id: "", listeners: new Set<() => void>() };
const followLagging = (listener: () => void) => {
  lagging.listeners.add(listener);
  return () => void lagging.listeners.delete(listener);
};

function LaggingPage() {
  const id = useSyncExternalStore(followLagging, () => lagging.id);
  return <BrowsingScreen tabId={id} />;
}

const showLagging = (id: string) =>
  act(() => {
    lagging.id = id;
    lagging.listeners.forEach((listener) => listener());
  });

for (const toward of ["right", "left"] as const)
  test(`toward the ${toward} neighbour, a render that still shows the source after the commit, with a new swipe order but the same neighbours, leaves the cursor on the destination, so the bar never shows the source again`, () => {
    const { line, at } = middleOfFive();
    const from = currentTabs().selectedId!;
    lagging.id = from;
    const root = renderSurface(<LaggingPage />);
    const dx: -1 | 1 = toward === "right" ? -1 : 1;
    const wanted = line[toward === "right" ? at + 1 : at - 1]!;
    const host = (id: string) => display(findTab(currentTabs(), id)!.url).host;
    const destination = host(wanted);
    expect(visibleAddresses(root)).toEqual([host(from)]);
    flick(dx);
    expect(visibleAddresses(root)).toEqual([destination]);
    frames(48);
    expect(currentTabs().selectedId).toBe(wanted);
    expect(visibleAddresses(root)).toEqual([destination]);
    const reordered = [...browse.swipeOrder()];
    const far = reordered.map((_, index) => index).filter((index) => Math.abs(index - reordered.indexOf(from)) > 1);
    expect(far.length).toBeGreaterThan(1);
    [reordered[far[0]!], reordered[far[1]!]] = [reordered[far[1]!]!, reordered[far[0]!]!];
    act(() => browse.useBrowse.setState({ frozenOrder: reordered }));
    frames(48);
    expect(visibleAddresses(root)).toEqual([destination]);
    showLagging(wanted);
    expect(visibleAddresses(root)).toEqual([destination]);
    frames(64);
    expect(visibleAddresses(root)).toEqual([destination]);
    unmount(root);
  });
