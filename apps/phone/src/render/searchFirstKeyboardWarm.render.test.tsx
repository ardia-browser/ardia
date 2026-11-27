import { AppState, Keyboard, Platform, TextInput } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import * as perf from "../state/app/interactionPerf";
import * as browse from "../state/browse/store";
import { presentSearch } from "../state/search/store";
import { useStageBar } from "../state/search/stageBar";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import type { ReactTestRenderer } from "react-test-renderer";

type StageEvents = { onLift?: (lift: { lift: number; up: boolean; predicted?: boolean }) => void; onReveal?: (reveal: { late: boolean }) => void };

const mockSeen: { props: StageEvents | null } = { props: null };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  const React = jest.requireActual<typeof import("react")>("react");
  const native = jest.requireActual<typeof import("react-native")>("react-native");
  const presented = { then: (done: () => void) => done() };
  const stage = { present: () => presented, holdLift: () => undefined, releaseLift: () => undefined, close: () => undefined, finish: () => undefined };
  const SearchStage = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => stage, []);
    mockSeen.props = props as StageEvents;
    const { onLift, onReveal, onSettled, onLanding, morphLook, anchorNativeId, faceNativeId, commandTop, fieldCenter, shown, ...rest } = props;
    return React.createElement(native.View, rest);
  });
  const CompletingField = React.forwardRef((_props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: () => undefined, blur: () => undefined, setText: () => undefined }), []);
    return React.createElement(native.View, { testID: "completingField" });
  });
  const onIPhone = () => native.Platform.OS === "ios";
  return { ...actual, searchStageIsNative: onIPhone, SearchStage, SearchStagePanel: (props: object) => React.createElement(native.View, props), completingFieldIsNative: onIPhone, CompletingField };
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;

let lines: string[];
let focused: string[];
let appState = "active";

Object.defineProperty(AppState, "currentState", { configurable: true, get: () => appState });

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  lines = [];
  focused = [];
  jest.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
  jest.spyOn(perf, "countRender").mockImplementation(() => undefined);
  jest.spyOn(TextInput.State, "currentlyFocusedInput").mockReturnValue(null);
  jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
  appState = "active";
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const warmField = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "searchKeyboardWarmUp" && typeof node.type !== "string");

const tray = () =>
  renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
    { flushTimers: false },
  );

const watchFocus = (root: ReactTestRenderer) => {
  const [field] = warmField(root);
  const instance = field.instance as { focus: () => void; blur: () => void };
  jest.spyOn(instance, "focus").mockImplementation(() => void focused.push("focus"));
  jest.spyOn(instance, "blur").mockImplementation(() => void focused.push("blur"));
};

onIPhone("a hidden field takes focus and gives it back once, 2.5 s after launch, so the first search finds the keyboard ready", () => {
  const root = tray();
  expect(warmField(root).length).toBeGreaterThan(0);
  watchFocus(root);
  act(() => jest.advanceTimersByTime(2499));
  expect(focused).toEqual([]);
  act(() => jest.advanceTimersByTime(1));
  expect(focused).toEqual(["focus", "blur"]);
  expect(lines).toContain("PAGELAB search warm keyboard");
  expect(warmField(root)).toHaveLength(0);
  unmount(root);
});

onIPhone("the warm-up never takes focus from search, a page's keyboard or another field, and never runs in the background", () => {
  for (const block of ["search", "keyboard", "field", "background"] as const) {
    const root = tray();
    watchFocus(root);
    if (block === "search") act(() => presentSearch("home", ""));
    if (block === "keyboard") jest.spyOn(Keyboard, "isVisible").mockReturnValue(true);
    if (block === "field") jest.spyOn(TextInput.State, "currentlyFocusedInput").mockReturnValue({} as never);
    if (block === "background") appState = "background";
    act(() => jest.advanceTimersByTime(2500));
    expect(focused).toEqual([]);
    expect(lines).toContain("PAGELAB search warm keyboard skipped");
    expect(warmField(root)).toHaveLength(0);
    unmount(root);
    lines = [];
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
    jest.spyOn(TextInput.State, "currentlyFocusedInput").mockReturnValue(null);
    appState = "active";
  }
});
