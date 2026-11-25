import { StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import * as perf from "../state/app/interactionPerf";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { framesUntil, landOpeningPage, renderSurface, unmount, withTabs } from "../../test/render/harness";

let renders: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(9);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
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

const LAYOUT_KEYS = ["width", "height", "top", "left", "right", "bottom", "margin", "padding", "flex"];

test("a card grows with no page mounted, then the page and its cover mount once each when the spring lands and render no more through the hand-over; the growing card animates no layout", () => {
  const root = renderSurface(<Surfaces />);
  renders = [];
  act(() => sendDeckCommand({ kind: "openFocused" }));
  const seen = new Map<string, Set<string>>();
  let landed = false;
  for (let frame = 0; frame < 90 && useBrowse.getState().surface === "deck"; frame++) {
    act(() => jest.advanceTimersByTime(16));
    if (!landed && useBrowse.getState().opening === null) expect(renders.filter((name) => name === "BrowsingScreen" || name === "PageCover")).toEqual([]);
    if (!landed && useBrowse.getState().opening !== null) {
      expect({ screen: renders.filter((name) => name === "BrowsingScreen").length, cover: renders.filter((name) => name === "PageCover").length }).toEqual({ screen: 1, cover: 1 });
      landed = landOpeningPage(root);
    }
    root.root
      .findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")
      .forEach((card, index) => {
        for (const [key, value] of Object.entries(getAnimatedStyle(card) ?? {})) {
          const values = seen.get(`${index}:${key}`) ?? new Set<string>();
          values.add(JSON.stringify(value));
          seen.set(`${index}:${key}`, values);
        }
      });
  }
  expect(landed).toBe(true);
  expect(useBrowse.getState().surface).toBe("browsing");
  act(() => jest.advanceTimersByTime(1000));
  expect(renders.filter((name) => name === "BrowsingScreen")).toHaveLength(1);
  expect(renders.filter((name) => name === "PageCover")).toHaveLength(1);
  const changing = [...seen.entries()].filter(([, values]) => values.size > 1).map(([key]) => key.split(":")[1]!);
  expect(changing).toEqual(expect.arrayContaining(["transform"]));
  expect(changing.filter((key) => LAYOUT_KEYS.some((layout) => key.toLowerCase().startsWith(layout)))).toEqual([]);
  unmount(root);
});

test("the cards' container always reaches the screen's bottom, so a full-size card isn't cut off above the bar and nothing about it changes when a card opens or the deck settles", () => {
  const root = renderSurface(<Surfaces />);
  const container = () => StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "deckCards" && typeof node.type === "string")[0]!.props.style);
  expect(container().height).toBe(873);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  expect(container().height).toBe(873);
  unmount(root);
});
