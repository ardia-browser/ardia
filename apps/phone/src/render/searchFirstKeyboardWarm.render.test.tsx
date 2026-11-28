import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import * as perf from "../state/app/interactionPerf";
import * as browse from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { presentSearch } from "../state/search/store";
import { useStageBar } from "../state/search/stageBar";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

type StageEvents = { onLift?: (lift: { lift: number; up: boolean; predicted?: boolean }) => void; onReveal?: (reveal: { late: boolean }) => void };

const mockSeen: { props: StageEvents | null } = { props: null };
const mockWarm = jest.fn<Promise<{ outcome: string; ms?: number }>, []>();
const mockEnd = jest.fn<void, []>();

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
  const system = { ...actual.system, prepareKeyboardWarmUp: () => undefined, warmKeyboard: () => mockWarm(), endKeyboardWarmUp: () => mockEnd() };
  return { ...actual, system, searchStageIsNative: onIPhone, SearchStage, SearchStagePanel: (props: object) => React.createElement(native.View, props), completingFieldIsNative: onIPhone, CompletingField };
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;

let lines: string[];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  lines = [];
  mockWarm.mockReset();
  mockEnd.mockReset();
  usePageUi.setState({ menuOpen: false, findOpen: false });
  jest.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
  jest.spyOn(perf, "countRender").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const tray = () =>
  renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
    { flushTimers: false },
  );

const settle = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

onIPhone("the keyboard is warmed once, 2.5 s after launch, so the first search finds it ready", async () => {
  mockWarm.mockResolvedValue({ outcome: "warmed", ms: 91 });
  const root = tray();
  await settle(2499);
  expect(mockWarm).not.toHaveBeenCalled();
  await settle(1);
  expect(mockWarm).toHaveBeenCalledTimes(1);
  expect(lines).toContain("PAGELAB search warm keyboard warmed 91ms attempt 1");
  expect(mockEnd).toHaveBeenCalledTimes(1);
  await settle(30_000);
  expect(mockWarm).toHaveBeenCalledTimes(1);
  unmount(root);
});

onIPhone("a busy moment (focus held, a touch, a scroll, a sheet) waits for a later idle one, six tries at most", async () => {
  mockWarm.mockResolvedValueOnce({ outcome: "focused" }).mockResolvedValueOnce({ outcome: "scrolling" }).mockResolvedValueOnce({ outcome: "warmed", ms: 80 });
  const root = tray();
  await settle(2500);
  await settle(1500);
  await settle(1500);
  expect(mockWarm).toHaveBeenCalledTimes(3);
  await settle(30_000);
  expect(mockWarm).toHaveBeenCalledTimes(3);
  unmount(root);
  mockWarm.mockReset();
  mockWarm.mockResolvedValue({ outcome: "touching" });
  const busy = tray();
  await settle(2500);
  for (let step = 0; step < 10; step += 1) await settle(1500);
  expect(mockWarm).toHaveBeenCalledTimes(6);
  expect(mockEnd).toHaveBeenCalled();
  unmount(busy);
});

onIPhone("while the page menu, Find or the deck is up, UIKit isn't asked, and leaving the screen lets the touch watcher go", async () => {
  mockWarm.mockResolvedValue({ outcome: "warmed", ms: 80 });
  usePageUi.setState({ menuOpen: true });
  const root = tray();
  await settle(2500);
  expect(mockWarm).not.toHaveBeenCalled();
  expect(lines).toContain("PAGELAB search warm keyboard overlay attempt 1");
  usePageUi.setState({ menuOpen: false, findOpen: true });
  await settle(1500);
  expect(mockWarm).not.toHaveBeenCalled();
  usePageUi.setState({ findOpen: false });
  browse.useBrowse.setState({ surface: "deck" });
  await settle(1500);
  expect(mockWarm).not.toHaveBeenCalled();
  browse.useBrowse.setState({ surface: "browsing" });
  await settle(1500);
  expect(mockWarm).toHaveBeenCalledTimes(1);
  unmount(root);
  mockEnd.mockReset();
  const early = tray();
  unmount(early);
  expect(mockEnd).toHaveBeenCalledTimes(1);
});

onIPhone("nothing is asked of UIKit while search is open", async () => {
  mockWarm.mockResolvedValue({ outcome: "warmed", ms: 80 });
  const root = tray();
  act(() => presentSearch("home", ""));
  await settle(2500);
  expect(mockWarm).not.toHaveBeenCalled();
  expect(lines).toContain("PAGELAB search warm keyboard searchOpen attempt 1");
  unmount(root);
});
