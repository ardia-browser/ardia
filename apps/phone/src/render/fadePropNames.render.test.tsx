import { DesignProvider } from "../components/ui";
import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { TabDeck } from "../components/tabs/TabDeck";
import { useBrowse } from "../state/browse/store";
import { presentSearch, useSearch } from "../state/search/store";
import type { TrayRow } from "../state/search/omnibox";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const fadeModule = require("@ardia/phone-native/src/fade") as typeof import("@ardia/phone-native/src/fade");
const fadeProps = require("@ardia/phone-native/src/fadeProps") as typeof import("@ardia/phone-native/src/fadeProps");

const EDGES = ["top", "bottom", "leading", "trailing"] as const;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Mounted = { props: Record<string, unknown> };

function check(fade: Mounted) {
  const style = Object.keys(StyleSheet.flatten(fade.props.style as never) ?? {});
  const edges = Object.fromEntries(EDGES.filter((edge) => fade.props[edge]).map((edge) => [edge, fade.props[edge]]));
  const sent = Object.keys(fadeProps.nativeFadeProps(edges));
  const usedEdges = Object.keys(edges);
  const oldCollisions = EDGES.filter((edge) => style.includes(edge));
  return { style, sent, usedEdges, oldCollisions };
}

test("the deck header's fade sends names its absolute-fill style doesn't have; the old names collided only on edges it doesn't use", () => {
  withTabs(3);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<TabDeck />);
  const fades = root.root.findAll((node) => node.type === fadeModule.FadeView && node.props.testID === "deckHeaderFade");
  expect(fades.length).toBeGreaterThanOrEqual(2);
  for (const fade of fades) {
    const { style, sent, usedEdges, oldCollisions } = check(fade);
    expect(sent).toEqual(["trailingFade"]);
    expect(sent.filter((name) => style.includes(name))).toEqual([]);
    expect(oldCollisions.sort()).toEqual(["bottom", "top"]);
    expect(usedEdges).toEqual(["trailing"]);
    expect(oldCollisions.filter((edge) => usedEdges.includes(edge))).toEqual([]);
  }
  unmount(root);
});

const rows: TrayRow[] = ["otters", "otter facts", "otter videos", "otters cafe", "otters club", "otters meaning"].map((query, index) => ({
  key: `q${index}`,
  kind: "query",
  title: query,
  url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  query,
}));

test("the tray's row list sends its bottom fade as bottomFade, which no layout prop or style key shares", () => {
  const native = jest.spyOn(fadeModule, "fadeIsNative").mockImplementation(() => true);
  withTabs(1);
  useBrowse.setState({ surface: "start" });
  presentSearch("start", "otter");
  useSearch.setState({ rows, text: "otter" });
  const root = renderSurface(<DesignProvider design="original"><SearchTray /></DesignProvider>);
  act(() => root.root.findAll((node) => node.props.testID === "trayRows" && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 200 } } }));
  act(() =>
    rows.forEach((_row, index) =>
      root.root.findAll((node) => node.props.testID === `trayRow:${index}` && typeof node.props.onLayout === "function")[0]?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * 56, width: 393, height: 56 } } }),
    ),
  );
  const list = root.root.findAll((node) => node.type === fadeModule.FadeView && node.props.testID === "trayRowList")[0]!;
  const { style, sent, usedEdges, oldCollisions } = check(list);
  expect(usedEdges).toEqual(["bottom"]);
  expect(sent).toEqual(["bottomFade"]);
  expect(sent.filter((name) => style.includes(name))).toEqual([]);
  expect(oldCollisions).toEqual([]);
  native.mockRestore();
  unmount(root);
});
