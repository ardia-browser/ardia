import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { TabDeck } from "../components/tabs/TabDeck";
import { useBrowse } from "../state/browse/store";
import { presentSearch, useSearch } from "../state/search/store";
import type { TrayRow } from "../state/search/omnibox";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const fadeModule = require("@ardia/phone-native/src/fade") as typeof import("@ardia/phone-native/src/fade");

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("each deck card's header fades its trailing 14 points through the native fade view, as Compose's DstIn and SwiftUI's mask", () => {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />);
  const fades = root.root.findAll((node) => node.type === fadeModule.FadeView && node.props.testID === "deckHeaderFade");
  expect(fades.length).toBeGreaterThanOrEqual(2);
  for (const fade of fades) expect(fade.props.trailing).toEqual({ length: 14 });
  unmount(root);
});

const ROW_HEIGHT = 56;
const ROOM = 200;
const rows: TrayRow[] = ["otters", "otter facts", "otter videos", "otters cafe", "otters club", "otters meaning"].map((query, index) => ({
  key: `q${index}`,
  kind: "query",
  title: query,
  url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  query,
}));

function overflowingTray() {
  withTabs(1);
  useBrowse.setState({ surface: "start" });
  presentSearch("start", "otter");
  useSearch.setState({ rows, text: "otter" });
  const root = renderSurface(<SearchTray />);
  act(() => root.root.findAll((node) => node.props.testID === "trayRows" && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: ROOM } } }));
  act(() =>
    rows.forEach((_row, index) =>
      root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * ROW_HEIGHT, width: 393, height: ROW_HEIGHT } } }),
    ),
  );
  return root;
}

const rowOpacity = (root: ReturnType<typeof renderSurface>, index: number) =>
  StyleSheet.flatten(root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.type === "string")[0]!.props.style)?.opacity ?? 1;

test("where the native fade exists, overflowing tray rows fade at the bottom as SwiftUI's mask (30% of the room down to 15%), and no row is dimmed whole", () => {
  const native = jest.spyOn(fadeModule, "fadeIsNative").mockImplementation(() => true);
  const root = overflowingTray();
  const list = root.root.findAll((node) => node.type === fadeModule.FadeView && node.props.testID === "trayRowList")[0]!;
  expect(list.props.bottom.length).toBeCloseTo(ROOM * 0.3, 6);
  expect(list.props.bottom.floor).toBe(0.15);
  expect(rows.map((_row, index) => rowOpacity(root, index))).toEqual(rows.map(() => 1));
  native.mockRestore();
  unmount(root);
});

test("without it, the rows keep today's per-row fade and the list asks for none", () => {
  const native = jest.spyOn(fadeModule, "fadeIsNative").mockImplementation(() => false);
  const root = overflowingTray();
  const list = root.root.findAll((node) => node.type === fadeModule.FadeView && node.props.testID === "trayRowList")[0]!;
  expect(list.props.bottom).toBeUndefined();
  expect(rowOpacity(root, 3)).toBeLessThan(0.5);
  native.mockRestore();
  unmount(root);
});

test("when typing shrinks the rows and grows them back to the same places, the list fades as soon as the rows are laid out again, not one keystroke later", () => {
  const native = jest.spyOn(fadeModule, "fadeIsNative").mockImplementation(() => true);
  const root = overflowingTray();
  const list = () => root.root.findAll((node) => node.type === fadeModule.FadeView && node.props.testID === "trayRowList")[0]!;
  const layOut = (count: number) =>
    act(() => {
      for (let index = 0; index < count; index++)
        root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * ROW_HEIGHT, width: 393, height: ROW_HEIGHT } } });
    });
  expect(list().props.bottom).toBeDefined();
  act(() => useSearch.setState({ rows: rows.slice(0, 2), text: "otters" }));
  layOut(2);
  expect(list().props.bottom).toBeUndefined();
  act(() => useSearch.setState({ rows, text: "otter" }));
  layOut(rows.length);
  expect(list().props.bottom).toBeDefined();
  native.mockRestore();
  unmount(root);
});
