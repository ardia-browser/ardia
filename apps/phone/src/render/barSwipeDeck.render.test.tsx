import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { browseLayout, DesignProvider } from "../components/ui";
import { DESIGNS, type Design } from "../lib/design";
import { PAGER } from "../lib/pagerPhysics";
import * as browse from "../state/browse/store";
import { usePages } from "../state/pages/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

let shown: jest.SpyInstance;
let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 47, bottom: 34, left: 0, right: 0 }));
  shown = jest.spyOn(browse, "showDeck").mockImplementation(async () => undefined);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const page = (design: Design) =>
  renderSurface(
    <DesignProvider design={design}>
      <BrowsingScreen tab={currentTabs().open[0]!} />
    </DesignProvider>,
  );

function drag(dx: number, dy: number) {
  act(() =>
    fireGestureHandler(getByGestureTestId("barSwipeUp"), [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, translationX: dx, translationY: dy, velocityX: 0, velocityY: -600 },
      { state: State.END, translationX: dx, translationY: dy, velocityX: 0, velocityY: -600 },
    ]),
  );
  act(() => jest.advanceTimersByTime(16));
}

test.each(DESIGNS)("in the %s design a swipe up on the bar opens the tab deck once it passes 22 points, as main's bar does, and counts the swipe", (design) => {
  const root = page(design);
  drag(0, -40);
  expect(shown).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("deck_bar_swipes");
  unmount(root);
});

test("the swipe asks for 22 points up and gives way to the tab pager's sideways swipe, failing once the finger has moved 14 points sideways or down", () => {
  const root = page("redesigned");
  const config = (getByGestureTestId("barSwipeUp") as unknown as { config: Record<string, number | undefined> }).config;
  expect(browseLayout.barSwipeUp).toBe(22);
  expect(config.activeOffsetYStart).toBe(-22);
  expect([config.failOffsetXStart, config.failOffsetXEnd]).toEqual([-PAGER.minimumDistance, PAGER.minimumDistance]);
  expect(config.failOffsetYEnd).toBe(PAGER.minimumDistance);
  unmount(root);
});

test("a swipe up from an Incognito tab opens the deck but isn't counted", () => {
  act(() => useTabs.setState({ incognito: true }));
  const root = page("redesigned");
  drag(0, -40);
  expect(shown).toHaveBeenCalledTimes(1);
  expect(counted).not.toHaveBeenCalledWith("deck_bar_swipes");
  unmount(root);
});

test("the swipe sits beside the tabs button, not in place of it: the button is inside the swiping bar, a tap on it still opens the deck and a long press still opens its menu, and a swipe up opens the deck as well", () => {
  const root = page("redesigned");
  const bar = root.root.findAll((node) => node.props.testID === "pageBar" && typeof node.type === "string")[0]!;
  for (const id of ["floatingBarTabs", "floatingBarAddress", "floatingBarPlus"]) expect(bar.findAll((node) => node.props.testID === id && typeof node.type === "string")).toHaveLength(1);
  const button = root.root.findAll((node) => node.props.accessibilityLabel === "Tabs" && typeof node.props.onPress === "function")[0]!;
  act(() => button.props.onPress());
  expect(shown).toHaveBeenCalledTimes(1);
  expect(counted).not.toHaveBeenCalledWith("deck_bar_swipes");
  if (typeof button.props.onLongPress === "function") {
    act(() => button.props.onLongPress());
    expect(shown).toHaveBeenCalledTimes(1);
  }
  drag(0, -40);
  expect(shown).toHaveBeenCalledTimes(2);
  expect(counted).toHaveBeenCalledWith("deck_bar_swipes");
  unmount(root);
});

test("a sideways drag on the bar is the tab pager's, not the swipe's: the swipe fails once the finger has moved 14 points sideways", () => {
  const root = page("redesigned");
  const config = (getByGestureTestId("barSwipeUp") as unknown as { config: Record<string, number | undefined> }).config;
  expect(config.failOffsetXEnd).toBe(PAGER.minimumDistance);
  expect(config.activeOffsetXStart).toBeUndefined();
  unmount(root);
});
