import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import * as browse from "../state/browse/store";
import * as telemetry from "../state/telemetry/telemetry";
import { dismissSearch, presentSearch, searchState } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let keyboard: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  browse.useBrowse.setState({ surface: "start", sheet: null });
  keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  keyboard.mockRestore();
  jest.useRealTimers();
});

const panelOffset = (root: ReturnType<typeof renderSurface>) => {
  const panel = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
  const transform = (getAnimatedStyle(panel) as { transform?: { translateY?: number }[] }).transform ?? [];
  return transform.find((step) => step.translateY !== undefined)?.translateY ?? 0;
};

const renderTray = () =>
  renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );

test("the launch tray is at rest on its first frame, before any keyboard, so a tap in the first second lands on a tray the user can see", () => {
  const reported = jest.spyOn(telemetry, "reportLaunchTray").mockResolvedValue();
  presentSearch("home", "", null, null, "atRest");
  const root = renderTray();
  expect(panelOffset(root)).toBeLessThanOrEqual(0);
  expect(reported).toHaveBeenCalledTimes(1);
  unmount(root);
  reported.mockRestore();
});

test("a tray raised by a tap still waits for the keyboard, landing on its own only after the landing delay, and times no launch", () => {
  const reported = jest.spyOn(telemetry, "reportLaunchTray").mockResolvedValue();
  presentSearch("home", "");
  const root = renderTray();
  expect(panelOffset(root)).toBeGreaterThan(100);
  act(() => jest.advanceTimersByTime(2000));
  expect(panelOffset(root)).toBeLessThanOrEqual(0);
  expect(reported).not.toHaveBeenCalled();
  unmount(root);
  reported.mockRestore();
});

test("a cold start with Auto-Open Keyboard raises the launch tray at rest, and only that presentation", () => {
  presentSearch("home", "", null, null, "atRest");
  expect(searchState().arrival).toBe("atRest");
  act(() => dismissSearch());
  presentSearch("page", "");
  expect(searchState().arrival).toBe("rises");
});
