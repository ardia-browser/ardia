import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act } from "react-test-renderer";
import { Dimensions } from "react-native";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { DesignProvider } from "../components/ui";
import * as browse from "../state/browse/store";
import { setRootSize } from "../state/app/rootSize";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { dismissSearch } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { currentTabs, selectTabById } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  return { ...actual, pageReportsDrawn: () => true };
});

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const PORTRAIT = Dimensions.get("window");

beforeEach(() => {
  jest.useFakeTimers();
  cutTabSwitches(true);
  setPreference("tabSwipeHintShown", true);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  cutTabSwitches(false);
  act(() => setRootSize(0, 0));
  Dimensions.set({ window: PORTRAIT, screen: PORTRAIT });
  act(() => useScreenLayout.setState({ hinge: "none" }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function Page() {
  const tab = useSelectedTab();
  return tab ? <BrowsingScreen tabId={tab.id} /> : null;
}

function openOn(width: number, height: number, insets: { top: number; bottom: number; left: number; right: number }, hinge: ScreenHinge) {
  Dimensions.set({ window: { ...PORTRAIT, width, height }, screen: { ...PORTRAIT, width, height } });
  act(() => setRootSize(width, height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => insets);
  act(() => useScreenLayout.setState({ hinge }));
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, arrivalCover: null, leaving: null });
  return renderSurface(
    <DesignProvider design="redesigned">
      <Page />
    </DesignProvider>,
  );
}

function barPan(distance: number) {
  const steps = [0, Math.sign(distance) * 20, distance * 0.5, distance, distance].map((translationX, at, all) => ({ state: at === 0 ? State.BEGAN : at === all.length - 1 ? State.END : State.ACTIVE, translationX, velocityX: 0, translationY: 0, velocityY: 0 }));
  act(() => fireGestureHandler(getByGestureTestId("tabPager"), steps));
  for (let left = 600; left > 0; left -= 16) act(() => jest.advanceTimersByTime(16));
}

test("on the open Duo a slow 230-point swipe along the 400-wide address capsule switches tabs, where half the 951-point screen used to be needed, and a 150-point one springs back", () => {
  const root = openOn(951, 669, { top: 0, bottom: 34, left: 0, right: 84 }, "fullyOpen");
  const middle = currentTabs().selectedId;
  barPan(150);
  expect(currentTabs().selectedId).toBe(middle);
  barPan(230);
  expect(currentTabs().selectedId).not.toBe(middle);
  unmount(root);
});

test("with no hinge at the same width a 230-point swipe stays short of half the screen and switches nothing, as on any iPhone", () => {
  const root = openOn(951, 669, { top: 0, bottom: 34, left: 0, right: 0 }, "none");
  const middle = currentTabs().selectedId;
  barPan(230);
  expect(currentTabs().selectedId).toBe(middle);
  barPan(480);
  expect(currentTabs().selectedId).not.toBe(middle);
  unmount(root);
});
