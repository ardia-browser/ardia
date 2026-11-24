import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import * as perf from "../state/app/interactionPerf";
import { useBrowse } from "../state/browse/store";
import { currentTabs, rewriteTab, selectTabById, updateTabById } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let renders: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(4);
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null });
  renders = [];
  jest.spyOn(perf, "countRender").mockImplementation((component: string) => {
    renders.push(component);
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const front = () => currentTabs().selectedId!;
const pageRenders = () => renders.filter((name) => name === "Surfaces" || name === "BrowsingScreen");

test("a fresh picture of the page in front, or a tab behind it changing its picture, re-renders neither the surfaces nor the page's chrome", () => {
  const root = renderSurface(<Surfaces />);
  renders = [];
  act(() => updateTabById(front(), { snapshotFileName: "file:///snapshots/front-quiet.jpg" }));
  const behind = currentTabs().open.find((tab) => tab.id !== front())!;
  act(() => updateTabById(behind.id, { themeColorHex: "#112233" }));
  act(() => rewriteTab(front()));
  expect(pageRenders()).toEqual([]);
  unmount(root);
});

test("a new title for the page in front reaches its chrome without re-rendering the surfaces above it", () => {
  const root = renderSurface(<Surfaces />);
  renders = [];
  act(() => updateTabById(front(), { title: "A New Title" }));
  expect(renders.filter((name) => name === "Surfaces")).toEqual([]);
  expect(renders.filter((name) => name === "BrowsingScreen").length).toBeGreaterThan(0);
  unmount(root);
});

test("selecting a tab shows it before its last-active time is written, and the write lands after the frame", () => {
  const { tabDatabase } = require("../state/store/database") as typeof import("../state/store/database");
  const { readOpenTabs, writeTabs } = require("../state/store/browserDatabase") as typeof import("../state/store/browserDatabase");
  writeTabs(tabDatabase(), currentTabs().open, []);
  const root = renderSurface(<Surfaces />);
  const next = currentTabs().open.find((tab) => tab.id !== front())!;
  const writtenBefore = readOpenTabs(tabDatabase()).find((tab) => tab.id === next.id)!.lastActive;
  act(() => selectTabById(next.id));
  expect(front()).toBe(next.id);
  expect(readOpenTabs(tabDatabase()).find((tab) => tab.id === next.id)!.lastActive).toBe(writtenBefore);
  act(() => jest.advanceTimersByTime(50));
  expect(readOpenTabs(tabDatabase()).find((tab) => tab.id === next.id)!.lastActive).toBe(currentTabs().open.find((tab) => tab.id === next.id)!.lastActive);
  unmount(root);
});
