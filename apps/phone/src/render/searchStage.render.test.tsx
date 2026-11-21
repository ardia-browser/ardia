import { Dimensions, Keyboard, Platform, StyleSheet } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import { FloatingBar } from "../components/browsing/FloatingBar";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { presentSearch, useSearch } from "../state/search/store";
import { useStageBar } from "../state/search/stageBar";
import { currentTabs, useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

type StageProps = {
  shown: boolean;
  anchorNativeId?: string | null;
  faceNativeId?: string | null;
  focusNativeId?: string | null;
  revealNativeId?: string | null;
  rowsRevealNativeId?: string | null;
  fieldCenter?: number;
  commandTop?: number | null;
  landsDirectly?: boolean;
  morphLook?: { usesGlass: boolean; panelTint: string; panelDark: boolean; classicPanel: string };
  onLift?: (lift: { lift: number; up: boolean }) => void;
  onReveal?: (reveal: { late: boolean }) => void;
  onSettled?: (settled: { landed: boolean }) => void;
};

const mockFaceTaken = { then: (taken: () => void) => taken() };
const mockStage = { present: jest.fn(() => mockFaceTaken), holdLift: jest.fn(), releaseLift: jest.fn(), close: jest.fn(), finish: jest.fn() };
const mockSeen: { props: StageProps | null } = { props: null };
const mockFocus = jest.fn();
const mockSetText = jest.fn();

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  const React = jest.requireActual<typeof import("react")>("react");
  const native = jest.requireActual<typeof import("react-native")>("react-native");
  const onIPhone = () => native.Platform.OS === "ios";
  const SearchStage = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => mockStage, []);
    mockSeen.props = props as never;
    const { onLift, onReveal, onSettled, morphLook, anchorNativeId, faceNativeId, commandTop, fieldCenter, shown, ...rest } = props;
    return React.createElement(native.View, rest);
  });
  const CompletingField = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: () => mockFocus(), blur: () => undefined, setText: (...args: unknown[]) => mockSetText(...args) }), []);
    return React.createElement(native.View, { testID: "completingField", holdsScroll: props.holdsScroll, selectsAllOnFocus: props.selectsAllOnFocus, fieldNativeID: props.nativeID } as object);
  });
  return {
    ...actual,
    searchStageIsNative: onIPhone,
    SearchStage,
    SearchStagePanel: (props: object) => React.createElement(native.View, props),
    completingFieldIsNative: onIPhone,
    CompletingField,
  };
});

const iPhone = Platform.OS === "ios";
const onIPhone = iPhone ? test : test.skip;
const onAndroid = iPhone ? test.skip : test;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false });
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  Object.values(mockStage).forEach((call) => call.mockClear());
  mockFocus.mockClear();
  mockSetText.mockClear();
  mockSeen.props = null;
  act(() => storeNavigation(currentTabs().open[0]!.id, { url: "https://site0.example/", title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection: "up" } as unknown as PageState));
});

const mounted: Root[] = [];

afterEach(() => {
  mounted.splice(0).forEach(unmount);
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const page = (withBar = true) => {
  const root = renderSurface(
    <DesignProvider design="redesigned">
      {withBar ? <BrowsingScreen tab={currentTabs().open[0]!} /> : null}
      <SearchTray />
    </DesignProvider>,
  );
  mounted.push(root);
  return root;
};

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0];
const opacity = (node: ReactTestInstance | undefined) => {
  if (!node) throw new Error("missing view");
  const style = { ...StyleSheet.flatten(node.props.style), ...getAnimatedStyle(node) } as { opacity?: number };
  return style.opacity ?? 1;
};
const glassOf = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && node.props.shown !== undefined && typeof node.type !== "string")[0]!;
const centreSeen = (root: Root) => {
  const glyphs = opacity(host(root, "floatingBarCentreGlyphs"));
  if (glyphs > 0) expect(glassOf(root, "floatingBarAddress").props.shown).toBe(true);
  return glyphs;
};
const stage = () => mockSeen.props!;
const field = (root: Root) => root.root.findAll((node) => node.props.testID === "completingField" && typeof node.type === "string")[0];
const advance = (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) act(() => jest.advanceTimersByTime(16));
};
const open = () => act(() => presentSearch("page", ""));
const lift = (to: number, up: boolean) => act(() => stage().onLift?.({ lift: to, up }));
const reveal = (late = false) => act(() => stage().onReveal?.({ late }));
const drag = (events: Parameters<typeof fireGestureHandler>[1]) => {
  act(() => fireGestureHandler(getByGestureTestId("trayDismissDrag"), events));
  act(() => jest.advanceTimersByTime(0));
};

onIPhone("opening search shows the stage, hides the bar's centre pill once the stage has taken its face, and leaves the field and rows to the stage, which holds them hidden from present() and fades them on its own clock as main's face and field do, the field's capsule staying in view behind the face", () => {
  const root = page();
  expect(stage().shown).toBe(false);
  expect(centreSeen(root)).toBe(1);
  expect(host(root, "floatingBarCentre")!.props.nativeID).toBe("searchStageAnchor");
  open();
  expect(stage().shown).toBe(true);
  expect(stage().anchorNativeId).toBe("searchStageAnchor");
  expect(stage().faceNativeId).toBe("searchStageFace");
  expect(stage().commandTop).toBeNull();
  expect(centreSeen(root)).toBe(0);
  expect(stage().revealNativeId).toBe("searchStageReveal");
  expect(stage().rowsRevealNativeId).toBe("searchStageRowsReveal");
  expect(host(root, "trayFieldReveal")!.props.nativeID).toBe("searchStageReveal");
  expect(StyleSheet.flatten(host(root, "trayFieldReveal")!.props.style)?.backgroundColor).toBeUndefined();
  expect(StyleSheet.flatten(host(root, "trayFieldCapsule")!.props.style)?.backgroundColor).toBeDefined();
  expect(host(root, "trayFieldCapsule")!.findAll((node) => node.props.testID === "trayFieldReveal").length).toBeGreaterThan(0);
  expect(host(root, "trayRowsReveal")!.props.nativeID).toBe("searchStageRowsReveal");
  for (const id of ["trayFieldReveal", "trayRowsReveal"]) {
    expect(StyleSheet.flatten(host(root, id)!.props.style)?.opacity).toBeUndefined();
    reveal();
    advance(300);
    expect(StyleSheet.flatten(host(root, id)!.props.style)?.opacity).toBeUndefined();
  }
});

onIPhone("each open asks the stage to present once its content is mounted, and the centre pill stays under the face until the stage has taken it", () => {
  let faceTaken = () => undefined as void;
  mockStage.present.mockImplementationOnce(() => ({ then: (taken: () => void) => void (faceTaken = taken) }));
  const root = page();
  open();
  expect(mockStage.present).toHaveBeenCalledTimes(1);
  expect(host(root, "trayFieldReveal")).toBeDefined();
  expect(centreSeen(root)).toBe(1);
  act(() => faceTaken());
  expect(centreSeen(root)).toBe(0);
});

onIPhone("the field takes the keyboard as soon as the stage has presented, as main's present focuses, never before the panel is up nor on a timer after", () => {
  let presented = () => undefined as void;
  mockStage.present.mockImplementationOnce(() => ({ then: (taken: () => void) => void (presented = taken) }));
  page();
  open();
  advance(100);
  expect(mockFocus).not.toHaveBeenCalled();
  act(() => presented());
  expect(mockFocus).toHaveBeenCalledTimes(1);
});

onIPhone("a page's long address opens selected and showing its start, as main's field: the native field selects it all when the stage's focus lands, not at mount", () => {
  const root = page();
  act(() => presentSearch("page", "https://en.wikipedia.org/w/index.php?title=Pastel_de_nata&utm_medium=search&utm_source=ardia"));
  expect(field(root)!.props.selectsAllOnFocus).toBe(true);
});

onIPhone("the stage is told which native view is the field, so it focuses the field itself as it presents", () => {
  const root = page();
  open();
  expect(stage().focusNativeId).toBe("searchStageField");
  expect(field(root)!.props.fieldNativeID).toBe("searchStageField");
});

onIPhone("Clear empties the field where it stands, as main's does, so the field keeps the keyboard: no new field is mounted", () => {
  const root = page();
  act(() => presentSearch("page", "https://en.wikipedia.org/wiki/Pastel_de_nata"));
  const before = field(root);
  const version = useSearch.getState().fieldVersion;
  const clear = root.root.findAll((node) => node.props.accessibilityLabel === "Clear Text" && typeof node.props.onPress === "function")[0]!;
  act(() => clear.props.onPress());
  expect(mockSetText).toHaveBeenLastCalledWith("", false);
  expect(useSearch.getState().fieldVersion).toBe(version);
  expect(field(root)).toBe(before);
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Clear Text")).toHaveLength(0);
});

onIPhone("opening again while the panel closes presents again with the stage still shown, never flipping it off and on", () => {
  page();
  open();
  act(() => browse.cancelSearch());
  const shownSeen: boolean[] = [];
  const watch = setInterval(() => shownSeen.push(stage().shown), 1);
  open();
  advance(32);
  clearInterval(watch);
  expect(mockStage.present).toHaveBeenCalledTimes(2);
  expect(stage().shown).toBe(true);
  expect(shownSeen.every(Boolean)).toBe(true);
  expect(mockStage.finish).not.toHaveBeenCalled();
});

onIPhone("a cancel after an earlier Go closes as a cancel: every open starts its ending afresh", () => {
  page();
  open();
  act(() => void browse.submitSearch("example.com"));
  act(() => stage().onSettled?.({ landed: false }));
  open();
  act(() => browse.cancelSearch());
  expect(mockStage.close).toHaveBeenLastCalledWith("morph", 0);
});

onIPhone("nothing above the bar's glass fades: the capsule, the pill and the side buttons fade their glyphs and take Glass's own shown", () => {
  const root = page();
  open();
  advance(300);
  for (const id of ["floatingBarCentre", "floatingBarLeading", "floatingBarTrailing", "floatingBarFold"]) {
    const node = host(root, id);
    if (node) expect(opacity(node)).toBe(1);
  }
  expect(glassOf(root, "floatingBarAddress").props.shownMs).toBe(0);
  act(() => browse.cancelSearch());
  act(() => stage().onSettled?.({ landed: true }));
  expect(glassOf(root, "floatingBarAddress").props).toMatchObject({ shown: true, shownMs: 0 });
});

onIPhone("the side buttons shrink 0.8 and slide 12 points out while search is open, and come back after it closes", () => {
  const root = page();
  open();
  advance(200);
  const leading = getAnimatedStyle(host(root, "floatingBarLeading")!) as { opacity?: number; transform: Record<string, number>[] };
  expect(leading.opacity).toBeUndefined();
  expect(opacity(host(root, "floatingBarTabsGlyphs"))).toBe(0);
  expect(glassOf(root, "floatingBarTabs").props.shown).toBe(false);
  expect(glassOf(root, "floatingBarPlus").props.shown).toBe(false);
  expect(Object.assign({}, ...leading.transform)).toEqual({ translateX: -12, scale: 0.8 });
  expect(Object.assign({}, ...(getAnimatedStyle(host(root, "floatingBarTrailing")!) as { transform: Record<string, number>[] }).transform)).toEqual({ translateX: 12, scale: 0.8 });
  expect(host(root, "floatingBarPlus")).toBeDefined();
  act(() => browse.cancelSearch());
  advance(100);
  expect(opacity(host(root, "floatingBarTabsGlyphs"))).toBe(0);
  advance(800);
  expect(opacity(host(root, "floatingBarTabsGlyphs"))).toBeCloseTo(1, 2);
  expect(glassOf(root, "floatingBarTabs").props.shown).toBe(true);
});

onIPhone("cancel lands the panel in the bar's pill, Go departs, and without a pill to land in it drops", () => {
  const root = page();
  open();
  act(() => browse.cancelSearch());
  expect(mockStage.close).toHaveBeenLastCalledWith("morph", 0);
  expect(centreSeen(root)).toBe(0);
  act(() => stage().onSettled?.({ landed: true }));
  open();
  act(() => void browse.submitSearch("example.com"));
  expect(mockStage.close).toHaveBeenLastCalledWith("depart", 0);
  unmount(mounted.splice(mounted.indexOf(root), 1)[0]!);
  page(false);
  open();
  act(() => browse.cancelSearch());
  expect(mockStage.close).toHaveBeenLastCalledWith("drop", 0);
});

onIPhone("settling shows the pill at once with no fade, tells the stage to finish in that same hand-over, and only then unmounts the panel's content at low priority", () => {
  const root = page();
  open();
  reveal();
  act(() => browse.cancelSearch());
  expect(host(root, "trayFieldReveal")).toBeDefined();
  expect(mockStage.finish).not.toHaveBeenCalled();
  let barAtFinish = -1;
  mockStage.finish.mockImplementationOnce(() => void (barAtFinish = centreSeen(root)));
  act(() => stage().onSettled?.({ landed: true }));
  expect(barAtFinish).toBe(1);
  expect(host(root, "trayFieldReveal")).toBeUndefined();
  expect(stage().shown).toBe(false);
  expect(centreSeen(root)).toBe(1);
  expect(mockStage.finish).toHaveBeenCalledTimes(1);
});

onIPhone("a search that departs on Go brings the pill back with a fade instead", () => {
  const root = page();
  open();
  act(() => void browse.submitSearch("example.com"));
  expect(centreSeen(root)).toBeLessThan(1);
  advance(200);
  expect(centreSeen(root)).toBe(1);
});

onIPhone("a long address holds its scroll from the open until the reveal, and from the close until the stage settles", () => {
  const root = page();
  open();
  expect(field(root)!.props.holdsScroll).toBe(true);
  reveal();
  expect(field(root)!.props.holdsScroll).toBe(false);
  act(() => browse.cancelSearch());
  expect(field(root)!.props.holdsScroll).toBe(true);
  expect(host(root, "trayFieldLeaving")).toBeUndefined();
  act(() => stage().onSettled?.({ landed: true }));
  expect(field(root)).toBeUndefined();
});

onIPhone("the dim fades in once the stage says the panel is up, and fades with the drag as it pulls the panel down", () => {
  jest.spyOn(Keyboard, "isVisible").mockReturnValue(true);
  const root = page();
  act(() => presentSearch("page", "site0.example", null, { currentUrl: "https://site0.example/", currentTabId: currentTabs().open[0]!.id }));
  reveal();
  expect(opacity(host(root, "trayDim"))).toBe(0);
  lift(300, true);
  advance(250);
  expect(opacity(host(root, "trayDim"))).toBeCloseTo(1, 2);
  drag([
    { state: State.BEGAN, translationY: 0 },
    { state: State.ACTIVE, translationY: 0 },
    { state: State.ACTIVE, translationY: 60 },
  ]);
  expect(mockStage.holdLift).toHaveBeenCalledTimes(1);
  const travel = 274 + 300;
  expect(opacity(host(root, "trayDim"))).toBeCloseTo(1 - 60 / travel, 2);
});

onIPhone("a short drag springs the panel back, keeps the stage's lift for 650 ms and then lets it follow the keyboard again", () => {
  jest.spyOn(Keyboard, "isVisible").mockReturnValue(true);
  const root = page();
  open();
  reveal();
  lift(300, true);
  drag([
    { state: State.BEGAN, translationY: 0 },
    { state: State.ACTIVE, translationY: 0 },
    { state: State.ACTIVE, translationY: 30 },
    { state: State.END, translationY: 30, velocityY: -400 },
  ]);
  expect(mockStage.holdLift).toHaveBeenCalledTimes(1);
  expect(mockStage.close).not.toHaveBeenCalled();
  advance(600);
  expect(mockStage.releaseLift).not.toHaveBeenCalled();
  advance(100);
  expect(mockStage.releaseLift).toHaveBeenCalledTimes(1);
  expect((getAnimatedStyle(host(root, "trayDrag")!) as { transform: { translateY: number }[] }).transform[0]!.translateY).toBeCloseTo(0, 1);
});

onIPhone("a drag with the keyboard already down holds nothing and lets nothing go", () => {
  jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
  page();
  open();
  lift(24, true);
  drag([
    { state: State.BEGAN, translationY: 0 },
    { state: State.ACTIVE, translationY: 0 },
    { state: State.ACTIVE, translationY: 30 },
    { state: State.END, translationY: 30, velocityY: -400 },
  ]);
  advance(800);
  expect(mockStage.holdLift).not.toHaveBeenCalled();
});

onIPhone("a drag past the dismiss distance closes through the stage with the tray's velocity and springs nothing back", () => {
  const root = page();
  open();
  lift(300, true);
  drag([
    { state: State.BEGAN, translationY: 0 },
    { state: State.ACTIVE, translationY: 0 },
    { state: State.ACTIVE, translationY: 140 },
    { state: State.END, translationY: 140, velocityY: 1200 },
  ]);
  expect(mockStage.close).toHaveBeenCalledWith("morph", 1200);
  expect((getAnimatedStyle(host(root, "trayDrag")!) as { transform: { translateY: number }[] }).transform[0]!.translateY).toBe(140);
});

onIPhone("the stage gets the panel's look, the field's centre and, on a late reveal, a count that Incognito never sends", () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = page();
  open();
  expect(stage().fieldCenter).toBeCloseTo(9 + 47.5 / 2);
  expect(stage().morphLook).toMatchObject({ usesGlass: true, panelDark: false });
  reveal(true);
  expect(counted).toHaveBeenCalledWith("search_reveals_late");
  act(() => browse.cancelSearch());
  act(() => stage().onSettled?.({ landed: true }));
  counted.mockClear();
  act(() => useTabs.setState({ incognito: true }));
  open();
  expect(stage().morphLook).toMatchObject({ panelDark: true });
  reveal(true);
  expect(counted).not.toHaveBeenCalledWith("search_reveals_late");
});

onAndroid("Android keeps the sheet tray and its own motion: no stage, and the bar's centre never hides", () => {
  const root = page();
  open();
  expect(mockSeen.props).toBeNull();
  expect(host(root, "trayRoot")).toBeDefined();
  expect(host(root, "trayDim")).toBeDefined();
});

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const stageCardOf = (root: Root) => {
  let card: ReactTestInstance | null = host(root, "traySurface")!.parent;
  while (card && typeof card.type !== "string") card = card.parent;
  return StyleSheet.flatten(card!.props.style) as { paddingHorizontal?: number; paddingLeft?: number; paddingRight?: number };
};

for (const [name, hinge, right] of [["open Duo", "fullyOpen", 84], ["closed Duo", "closed", 84]] as const satisfies readonly (readonly [string, ScreenHinge, number])[]) {
  onIPhone(`on the ${name} the search panel stays out of the sensor strip and its clock: it ends 8 short of the strip, its inner edge`, () => {
    jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 0, bottom: 34, left: 0, right }));
    act(() => useScreenLayout.setState({ hinge }));
    const root = page();
    open();
    advance(400);
    expect(stageCardOf(root)).toMatchObject({ paddingLeft: 8, paddingRight: right + 8 });
    act(() => useScreenLayout.setState({ hinge: "none" }));
  });
}

onIPhone("with no hinge the search panel keeps its 8 a side", () => {
  const root = page();
  open();
  advance(400);
  const card = stageCardOf(root);
  expect(card.paddingHorizontal).toBe(8);
  expect(card.paddingRight).toBeUndefined();
});

const anchorSpan = (root: Root, width: number) => {
  let controls: ReactTestInstance | null = root.root.findAll((node) => node.type === FloatingBar)[0]!.parent;
  while (controls && (typeof controls.type !== "string" || StyleSheet.flatten(controls.props.style).bottom === undefined)) controls = controls.parent;
  const { left, right } = StyleSheet.flatten(controls!.props.style) as { left: number; right: number };
  const centre = { ...StyleSheet.flatten(host(root, "floatingBarCentre")!.props.style), ...getAnimatedStyle(host(root, "floatingBarCentre")!) } as { marginLeft?: number; marginRight?: number };
  return { left: left + 24 + (centre.marginLeft ?? 0), right: width - right - 24 - (centre.marginRight ?? 0) };
};

const DUO_SCREENS = [
  { name: "open Duo", width: 951, height: 669, hinge: "fullyOpen", anchor: { left: 527, right: 927 }, direct: true },
  { name: "closed Duo", width: 466, height: 678, hinge: "closed", anchor: { left: 24, right: 370 }, direct: false },
] as const satisfies readonly { name: string; width: number; height: number; hinge: ScreenHinge; anchor: { left: number; right: number }; direct: boolean }[];

for (const screen of DUO_SCREENS) {
  onIPhone(`on the ${screen.name} closing search lands on the address capsule as laid out, ${screen.anchor.left} to ${screen.anchor.right}, ${screen.direct ? "in one move" : "on the phone's path"}, and the capsule never moves after it lands`, () => {
    const portrait = Dimensions.get("window");
    Dimensions.set({ window: { ...portrait, width: screen.width, height: screen.height }, screen: { ...portrait, width: screen.width, height: screen.height } });
    jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 0, bottom: 34, left: 0, right: 84 }));
    act(() => useScreenLayout.setState({ hinge: screen.hinge }));
    const root = page();
    expect(anchorSpan(root, screen.width)).toEqual(screen.anchor);
    open();
    advance(400);
    expect(stage().landsDirectly).toBe(screen.direct);
    expect(anchorSpan(root, screen.width)).toEqual(screen.anchor);
    act(() => browse.cancelSearch());
    expect(mockStage.close).toHaveBeenLastCalledWith("morph", 0);
    for (let frame = 0; frame < 20; frame++) {
      act(() => jest.advanceTimersByTime(16));
      expect(anchorSpan(root, screen.width)).toEqual(screen.anchor);
    }
    act(() => stage().onSettled?.({ landed: true }));
    for (let frame = 0; frame < 20; frame++) {
      act(() => jest.advanceTimersByTime(16));
      expect(anchorSpan(root, screen.width)).toEqual(screen.anchor);
    }
    act(() => useScreenLayout.setState({ hinge: "none" }));
    Dimensions.set({ window: portrait, screen: portrait });
  });
}

onIPhone("with no hinge the stage keeps the phone's landing path", () => {
  page();
  open();
  expect(stage().landsDirectly).toBe(false);
});
