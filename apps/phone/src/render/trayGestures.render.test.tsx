import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { StyleSheet } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import * as browse from "../state/browse/store";
import * as search from "../state/search/store";
import * as telemetry from "../state/telemetry/telemetry";
import { presentSearch, useSearch } from "../state/search/store";
import type { TrayRow } from "../state/search/omnibox";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const ROW_HEIGHT = 56;

const queries = (titles: string[]): TrayRow[] =>
  titles.map((query, index) => ({
    key: `q${index}`,
    kind: "query",
    title: query,
    url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    query,
  }));

const rows = queries(["otters", "otter facts", "otter videos"]);
const manyRows = queries(["otters", "otter facts", "otter videos", "otters cafe", "otters club", "otters meaning", "otters in india"]);
const ROOM_ABOVE_KEYBOARD = 200;

function openTray(shownRows: TrayRow[] = rows, room: number = ROW_HEIGHT * shownRows.length, design: Design = "original") {
  withTabs(1);
  browse.useBrowse.setState({ surface: "start" });
  presentSearch("start", "otter");
  useSearch.setState({ rows: shownRows, text: "otter" });
  const root = renderSurface(
    <DesignProvider design={design}>
      <SearchTray />
    </DesignProvider>,
  );
  act(() => {
    root.root.findAll((node) => node.props.testID === "trayRows" && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: room } } });
  });
  act(() => {
    shownRows.forEach((_row, index) => {
      const row = root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.props.onLayout === "function")[0];
      row?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * ROW_HEIGHT, width: 393, height: ROW_HEIGHT } } });
    });
  });
  return root;
}

function gesture(testId: string, events: Parameters<typeof fireGestureHandler>[1]) {
  act(() => fireGestureHandler(getByGestureTestId(testId), events));
  act(() => jest.runOnlyPendingTimers());
}

const rowCentre = (index: number) => ({ x: 120, y: index * ROW_HEIGHT + ROW_HEIGHT / 2 });

describe("the tray's touches", () => {
  let activate: jest.SpyInstance;
  let cancel: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    activate = jest.spyOn(browse, "activateRow").mockImplementation(() => undefined);
    cancel = jest.spyOn(browse, "cancelSearch").mockImplementation(() => undefined);
  });

  afterEach(() => {
    activate.mockRestore();
    cancel.mockRestore();
    jest.useRealTimers();
  });

  function rowButton(root: ReturnType<typeof openTray>, index: number) {
    const row = root.root.findAll((node) => node.props.testID === `trayRow:${index}`)[0]!;
    return row.findAll((node) => typeof node.props.onPress === "function" && typeof node.props.onLongPress === "function")[0]!;
  }

  test("a plain tap on a row opens that row through its own button, with no gesture recogniser involved", () => {
    const root = openTray();
    act(() => rowButton(root, 1).props.onPress({}));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][0]).toBe(rows[1]);
    unmount(root);
  });

  test("in the original design a tap on a row's refine arrow fills the field with that search instead of opening it (main's redesign has no arrow)", () => {
    const refine = jest.spyOn(search, "setSearchText").mockImplementation(() => undefined);
    const root = openTray(rows, undefined, "original");
    const arrow = root.root.findAll((node) => node.props.accessibilityLabel === "Refine otter facts" && typeof node.props.onPress === "function")[0]!;
    act(() => arrow.props.onPress({}));
    expect(refine).toHaveBeenCalledWith("otter facts ");
    expect(activate).not.toHaveBeenCalled();
    refine.mockRestore();
    unmount(root);
  });

  test("holding a row opens its menu and doesn't open the row", () => {
    const root = openTray();
    act(() => rowButton(root, 0).props.onLongPress({ nativeEvent: { pageY: 600 } }));
    const menus = root.root.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onDismiss === "function");
    expect(menus.flatMap((menu) => menu.props.items.map((item: { label: string }) => item.label))).toContain("Search in Incognito Tab");
    expect(activate).not.toHaveBeenCalled();
    unmount(root);
  });

  test("a scrub that ends on a row opens the row it ends on", () => {
    const root = openTray();
    const from = rowCentre(0);
    const to = rowCentre(2);
    gesture("trayRowsScrub", [
        { state: State.BEGAN, ...from, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, ...from, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, x: to.x, y: (from.y + to.y) / 2, translationX: 0, translationY: (to.y - from.y) / 2 },
        { state: State.ACTIVE, ...to, translationX: 0, translationY: to.y - from.y },
        { state: State.END, ...to, translationX: 0, translationY: to.y - from.y },
    ]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][0]).toBe(rows[2]);
    unmount(root);
  });

  test("with more rows than room above the keyboard, the next row peeks faded and the scrub reaches every row by its laid-out frame", () => {
    const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
    const root = openTray(manyRows, ROOM_ABOVE_KEYBOARD);
    const list = root.root.findAll((node) => node.props.testID === "trayRowList" && typeof node.type === "string")[0]!;
    expect(StyleSheet.flatten(list.props.style).height).toBe(ROOM_ABOVE_KEYBOARD);
    const opacity = (index: number) => StyleSheet.flatten(root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.type === "string")[0]!.props.style)?.opacity ?? 1;
    expect(opacity(0)).toBe(1);
    expect(opacity(2)).toBe(1);
    expect(opacity(3)).toBeGreaterThan(0.15);
    expect(opacity(3)).toBeLessThan(0.5);
    const from = rowCentre(0);
    const to = rowCentre(5);
    gesture("trayRowsScrub", [
        { state: State.BEGAN, ...from, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, ...from, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, ...to, translationX: 0, translationY: to.y - from.y },
        { state: State.END, ...to, translationX: 0, translationY: to.y - from.y },
    ]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][0]).toBe(manyRows[5]);
    expect(counted).toHaveBeenCalledWith("tray_hidden_rows_opened");
    counted.mockRestore();
    unmount(root);
  });

  test("rows that fit aren't faded", () => {
    const root = openTray();
    const faded = rows.map((_row, index) => StyleSheet.flatten(root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.type === "string")[0]!.props.style)?.opacity ?? 1);
    expect(faded).toEqual([1, 1, 1]);
    unmount(root);
  });

  test("a tap on Close Search closes the tray once", () => {
    const root = openTray();
    const close = root.root.findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0];
    expect(close).toBeDefined();
    act(() => close!.props.onPressIn({}));
    act(() => close!.props.onPress?.({}));
    expect(cancel).toHaveBeenCalledTimes(1);
    unmount(root);
  });

  test("a drag down from the field closes the tray", () => {
    const root = openTray();
    gesture("trayDismissDrag", [
        { state: State.BEGAN, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: 200, velocityY: 1500 },
        { state: State.END, translationY: 400, velocityY: 2000 },
    ]);
    expect(cancel).toHaveBeenCalledTimes(1);
    unmount(root);
  });
});
