import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import * as perf from "../state/app/interactionPerf";
import * as browse from "../state/browse/store";
import { presentSearch, useSearch } from "../state/search/store";
import type { TrayRow } from "../state/search/omnibox";
import { useStageBar } from "../state/search/stageBar";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

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

const ROWS: TrayRow[] = ["sintra", "nata", "swift", "otters", "lisbon"].map((query, index) => ({ key: `q${index}`, kind: "query", title: query, url: `https://duckduckgo.com/?q=${query}`, query }));

let renders: Map<string, number>;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  renders = new Map();
  jest.spyOn(perf, "countRender").mockImplementation((component: string) => void renders.set(component, (renders.get(component) ?? 0) + 1));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const rowRenders = () => renders.get("SuggestionRow") ?? 0;

onIPhone("opening search draws each row once: the stage's lift, reveal and keyboard events move the panel without drawing its rows again", () => {
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  act(() => presentSearch("home", ""));
  act(() => useSearch.setState({ rows: ROWS }));
  act(() => jest.advanceTimersByTime(16));
  expect(rowRenders()).toBe(ROWS.length);
  renders.clear();
  act(() => mockSeen.props?.onLift?.({ lift: 336, up: false, predicted: true }));
  act(() => mockSeen.props?.onReveal?.({ late: false }));
  act(() => mockSeen.props?.onLift?.({ lift: 336, up: true }));
  act(() => jest.advanceTimersByTime(400));
  expect(renders.get("TrayLayer") ?? 0).toBeGreaterThan(0);
  expect(rowRenders()).toBe(0);
  act(() => useSearch.setState({ rows: ROWS.slice(1) }));
  expect(rowRenders()).toBe(ROWS.length - 1);
  unmount(root);
});
