import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { deckGeometry } from "../lib/deckGeometry";
import { noteSnapshotPageTop } from "../lib/shownSnapshots";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { framesUntil, landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

const STORED = "#2B5B84";
const PAGE_TOP = 52;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  useTabs.setState((state) => ({ open: state.open.map((tab) => ({ ...tab, themeColorHex: STORED, snapshotFileName: `file:///snapshots/${tab.id}.jpg` })) }));
  for (const tab of currentTabs().open) noteSnapshotPageTop(`file:///snapshots/${tab.id}.jpg`, PAGE_TOP);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const translateY = (node: ReactTestInstance) => ((getAnimatedStyle(node).transform as { translateY?: number }[] | undefined) ?? []).reduce((sum, step) => sum + (step.translateY ?? 0), 0);
const scaleY = (node: ReactTestInstance) => ((getAnimatedStyle(node).transform as { scaleY?: number }[] | undefined) ?? []).reduce((value, step) => (step.scaleY === undefined ? value : step.scaleY), 1);

test("an opening card grows a bar band in the page's bar colour from its first frame, and lands its picture where the page view sat when it was captured", () => {
  const g = deckGeometry(393, 873, 40, 24);
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  const bands = root.root.findAll((node) => node.props.testID === "deckCardBarBand" && typeof node.type === "string");
  expect(bands.length).toBeGreaterThan(0);
  for (const band of bands) expect(StyleSheet.flatten(band.props.style).backgroundColor).toBe(STORED);
  let grown = 0;
  let drop = 0;
  let landed = false;
  for (let frame = 0; frame < 90 && useBrowse.getState().surface === "deck"; frame++) {
    act(() => jest.advanceTimersByTime(16));
    if (!landed && useBrowse.getState().opening !== null) landed = landOpeningPage(root);
    for (const band of root.root.findAll((node) => node.props.testID === "deckCardBarBand" && typeof node.type === "string")) grown = Math.max(grown, scaleY(band));
    for (const face of root.root.findAll((node) => node.props.testID === "deckCardFace" && typeof node.type === "string")) drop = Math.max(drop, translateY(face));
  }
  expect(grown).toBeGreaterThan(0.95);
  expect(drop * (g.width / g.cardWidth)).toBeGreaterThan(PAGE_TOP - 4);
  expect(drop * (g.width / g.cardWidth)).toBeLessThanOrEqual(PAGE_TOP + 0.001);
  unmount(root);
});
