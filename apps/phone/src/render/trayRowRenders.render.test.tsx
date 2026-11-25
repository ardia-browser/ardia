import { act } from "react-test-renderer";
import { DesignProvider, appDesign } from "../components/ui";
import { SearchTray } from "../components/search/SearchTray";
import * as perf from "../state/app/interactionPerf";
import * as browse from "../state/browse/store";
import { presentSearch, useSearch } from "../state/search/store";
import type { TrayRow } from "../state/search/omnibox";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const queries = (titles: string[]): TrayRow[] => titles.map((query, index) => ({ key: `q${index}`, kind: "query", title: query, url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`, query }));

let renders = 0;

beforeEach(() => {
  jest.useFakeTimers();
  renders = 0;
  jest.spyOn(perf, "countRender").mockImplementation((component: string) => {
    if (component === "SuggestionRow") renders += 1;
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const layOutRows = (root: Root, count: number, height: number) =>
  act(() => {
    for (let index = 0; index < count; index++) {
      root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * height, width: 393, height } } });
    }
  });

test("a keystroke draws each suggestion row once: the rows' new heights redraw the list's fade, not the rows", () => {
  withTabs(1);
  browse.useBrowse.setState({ surface: "start" });
  const rows = queries(["otters", "otter facts", "otter videos"]);
  act(() => presentSearch("start", "otter"));
  act(() => useSearch.setState({ rows, text: "otter" }));
  const root = renderSurface(
    <DesignProvider design={appDesign}>
      <SearchTray />
    </DesignProvider>,
  );
  act(() => {
    root.root.findAll((node) => node.props.testID === "trayRows" && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 400 } } });
  });
  layOutRows(root, rows.length, 56);
  renders = 0;
  layOutRows(root, rows.length, 64);
  expect(renders).toBe(0);
  act(() => useSearch.setState({ text: "otters" }));
  expect(renders).toBe(rows.length);
  renders = 0;
  layOutRows(root, rows.length, 56);
  expect(renders).toBe(0);
  unmount(root);
});
