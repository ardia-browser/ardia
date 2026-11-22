import { Profiler } from "react";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import { DesignProvider, Toggle } from "../components/ui";
import type { Design } from "../lib/design";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { showDeck, useBrowse } from "../state/browse/store";
import { storeNavigation, type PageState } from "../state/pages/store";
import { dismissSearch, presentSearch, useSearch } from "../state/search/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const DESIGNS: Design[] = ["redesigned", "original"];

const loading = (progress: number) => ({ url: "https://slow.example/", title: "Slow", isLive: true, isLoading: true, progress, failure: null, canGoBack: false, canGoForward: false }) as unknown as PageState;

const app = (design: Design, onCommit: () => void) =>
  renderSurface(
    <Profiler id="app" onRender={onCommit}>
      <DesignProvider design={design}>
        <Surfaces />
      </DesignProvider>
    </Profiler>,
  );

for (const design of DESIGNS) {
  test(`in the ${design} design, after Go React commits nothing while the tray leaves and the new page loads, so no commit holds back the UI thread's departure (the page's loading line runs there too)`, () => {
    useBrowse.setState({ surface: "start", sheet: null });
    act(() => presentSearch("home", "otters"));
    let commits = 0;
    const root = app(design, () => (commits += 1));
    act(() => jest.advanceTimersByTime(800));
    const input = root.root.findAll((node) => typeof node.props.onSubmitEditing === "function" || (typeof node.props.onSubmit === "function" && node.props.testID === "completingField"))[0]!;
    act(() => (input.props.onSubmitEditing ? input.props.onSubmitEditing({ nativeEvent: { text: "otters" } }) : input.props.onSubmit("otters")));
    expect(useSearch.getState().open).toBe(false);
    expect(useBrowse.getState().surface).toBe("browsing");
    expect(root.root.findAll((node) => node.props.testID === "loadingLine" && typeof node.type === "string")).toHaveLength(1);
    commits = 0;
    for (let frame = 0; frame < 30; frame++) act(() => jest.advanceTimersByTime(16));
    expect(commits).toBe(0);
    unmount(root);
  });
}

type Motion = { name: string; start: () => void; from: "browsing" | "deck" };

const MOTIONS: Motion[] = [
  { name: "the tray rises", from: "browsing", start: () => presentSearch("page", "") },
  { name: "the deck opens", from: "browsing", start: () => void showDeck() },
  { name: "a card opens", from: "deck", start: () => sendDeckCommand({ kind: "openSelected" }) },
];

const commitsDuring = (design: Design, motion: Motion, pageReportsEachFrame: boolean) => {
  act(() => dismissSearch());
  act(() => jest.advanceTimersByTime(1000));
  withTabs(3);
  const page = currentTabs().selectedId!;
  act(() => storeNavigation(page, loading(0.1)));
  useBrowse.setState({ surface: motion.from, sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  let commits = 0;
  const root = app(design, () => (commits += 1));
  act(() => jest.advanceTimersByTime(1500));
  commits = 0;
  act(() => motion.start());
  for (let frame = 1; frame <= 45; frame++) {
    if (pageReportsEachFrame) act(() => storeNavigation(page, loading(Math.min(0.95, 0.1 + frame * 0.02))));
    act(() => jest.advanceTimersByTime(16));
  }
  unmount(root);
  return commits;
};

for (const design of DESIGNS) {
  for (const motion of MOTIONS) {
    test(`in the ${design} design, a page reporting its load progress every frame while ${motion.name} adds no React commit, so nothing holds back the motion on the UI thread`, () => {
      const quiet = commitsDuring(design, motion, false);
      const reporting = commitsDuring(design, motion, true);
      expect(reporting).toBe(quiet);
    });
  }
}

test("a settings switch slides on the UI thread: after the tap, its knob and colour commit nothing while they move", () => {
  let commits = 0;
  let value = false;
  const root = renderSurface(
    <Profiler id="toggle" onRender={() => (commits += 1)}>
      <Toggle label="Block Trackers" value={value} onChange={(next) => (value = next)} />
    </Profiler>,
  );
  act(() =>
    root.update(
      <Profiler id="toggle" onRender={() => (commits += 1)}>
        <Toggle label="Block Trackers" value onChange={(next) => (value = next)} />
      </Profiler>,
    ),
  );
  commits = 0;
  for (let frame = 0; frame < 30; frame++) act(() => jest.advanceTimersByTime(16));
  expect(commits).toBe(0);
  unmount(root);
});
