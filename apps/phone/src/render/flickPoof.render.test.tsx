import { Platform } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { TabDeck } from "../components/tabs/TabDeck";
import { appDesign } from "../components/ui";
import { deckGeometry } from "../lib/deckGeometry";
import { POOF } from "../lib/poof";
import * as browse from "../state/browse/store";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { pages } from "../platform/pages";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const TABS_MADE = 1_790_000_000_000;

jest.spyOn(pages, "close").mockImplementation(async () => undefined as never);
jest.spyOn(pages, "saveState").mockImplementation(async () => null as never);

let closing: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(TABS_MADE + 60_000);
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  closing = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
});

afterEach(() => {
  closing.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const bursts = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.pointerEvents === "none" && node.props.accessibilityElementsHidden === true && node.children.length === POOF.count + 1);

const puffCentre = (burst: ReactTestInstance) => {
  const puffs = burst.children.filter((child): child is ReactTestInstance => typeof child !== "string");
  const centres = puffs.map((puff) => {
    const host = puff.findAll((node) => typeof node.type === "string")[0]!;
    const style = getAnimatedStyle(host) as { top: number; height: number };
    return style.top + style.height / 2;
  });
  return centres.reduce((sum, y) => sum + y, 0) / centres.length;
};

const g = deckGeometry(393, 873, 40, 24, 0, Platform.OS, appDesign, deckHeaderBottom());
const size = g.cardWidth * POOF.sizeShare;

const flick = (rise: number) =>
  act(() =>
    fireGestureHandler(getByGestureTestId("deckPan"), [
      { state: State.BEGAN, x: 200, y: g.cardCenterY, absoluteX: 200, absoluteY: g.cardCenterY, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, x: 200, y: g.cardCenterY - 20, absoluteX: 200, absoluteY: g.cardCenterY - 20, translationX: 0, translationY: -20, velocityX: 0, velocityY: -900 },
      { state: State.ACTIVE, x: 200, y: g.cardCenterY - rise, absoluteX: 200, absoluteY: g.cardCenterY - rise, translationX: 0, translationY: -rise, velocityX: 0, velocityY: -1800 },
      { state: State.END, x: 200, y: g.cardCenterY - rise, absoluteX: 200, absoluteY: g.cardCenterY - rise, translationX: 0, translationY: -rise, velocityX: 0, velocityY: -1800 },
    ]),
  );

test("a card flicked up closes with the same poof the menu's Close Tab plays, centred where the flying card is", () => {
  const root = renderSurface(<TabDeck />);
  flick(160);
  act(() => jest.advanceTimersByTime(16));
  const flicked = bursts(root);
  expect(flicked).toHaveLength(1);
  const centre = puffCentre(flicked[0]!);
  expect(centre).toBeGreaterThan(0);
  expect(centre).toBeLessThan(g.cardCenterY - 160);
  for (let frame = 0; frame < 40; frame++) act(() => jest.advanceTimersByTime(16));
  expect(closing.mock.calls.length + (3 - currentTabs().open.length)).toBe(1);
  act(() => jest.advanceTimersByTime(1000));
  expect(bursts(root)).toHaveLength(0);
  unmount(root);
});

test("a card dragged to the top of the screen before its flick still bursts in full view, half the poof's size below the status bar, not off the top", () => {
  const rise = g.cardCenterY - 30;
  expect(g.cardCenterY - rise - g.cardHeight * 0.18).toBeLessThan(g.safeTop + size * 0.5);
  const root = renderSurface(<TabDeck />);
  flick(rise);
  act(() => jest.advanceTimersByTime(16));
  const burst = bursts(root);
  expect(burst).toHaveLength(1);
  const centre = puffCentre(burst[0]!);
  expect(centre).toBeGreaterThanOrEqual(g.safeTop + size * 0.5 - 3);
  expect(centre).toBeLessThan(g.safeTop + size * 0.5 + 3);
  unmount(root);
});

test("from the menu the poof is the same burst, at the resting card", () => {
  const root = renderSurface(<TabDeck />);
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  act(() => jest.advanceTimersByTime(16));
  const burst = bursts(root);
  expect(burst).toHaveLength(1);
  expect(puffCentre(burst[0]!)).toBeCloseTo(g.cardCenterY - g.cardHeight * 0.18, -1);
  unmount(root);
});
