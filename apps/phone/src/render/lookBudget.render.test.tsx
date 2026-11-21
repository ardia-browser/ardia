import { act } from "react-test-renderer";
import { useArchiveCard } from "../state/browse/archiveCard";
import { setPreference } from "../state/settings/store";

const platformTelemetry = require("../platform/telemetry") as typeof import("../platform/telemetry");
const posted: string[] = [];
jest.spyOn(platformTelemetry, "postTelemetry").mockImplementation(async (body: string) => {
  posted.push(body);
  return 200;
});
jest.spyOn(platformTelemetry, "canPostTelemetry").mockImplementation(() => true);
const look = require("../platform/look") as typeof import("../platform/look");
const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
const { TabDeck } = require("../components/tabs/TabDeck") as typeof import("../components/tabs/TabDeck");
const { useBrowse } = require("../state/browse/store") as typeof import("../state/browse/store");
const { renderSurface, unmount, withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");
const { State } = require("react-native-gesture-handler") as typeof import("react-native-gesture-handler");
const { fireGestureHandler, getByGestureTestId } = require("react-native-gesture-handler/jest-utils") as typeof import("react-native-gesture-handler/jest-utils");

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("app_launched carries the look this launch shows: the budget's verdict with the system's Reduce Motion and Reduce Transparency, as one of four values", async () => {
  const system = jest.spyOn(look, "systemLook").mockImplementation(async () => ({ reduceMotion: true, reduceTransparency: false }));
  const asked: unknown[] = [];
  const mode = jest.spyOn(look.lookBudget, "mode").mockImplementation((given) => {
    asked.push(given);
    return "no_motion";
  });
  telemetry.setUsageSharing(true, "settings");
  await act(async () => {
    await telemetry.reportLaunch(Date.now());
  });
  for (let tick = 0; tick < 10 && !posted.some((body) => body.includes("app_launched")); tick++) {
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
  }
  expect(asked).toEqual([{ reduceMotion: true, reduceTransparency: false }]);
  const launch = posted.find((body) => body.includes("app_launched"));
  expect(launch).toBeDefined();
  expect(launch).toContain("look_mode");
  expect(launch).toContain("no_motion");
  telemetry.setUsageSharing(false, "settings");
  system.mockRestore();
  mode.mockRestore();
});

test("the deck tells the budget's probe it is idle only while settled and untouched, with no sheet, menu or tray, and passes the system's Reduce Motion", () => {
  const calls: { idle: boolean; reduceMotion: boolean }[] = [];
  const probe = jest.spyOn(look, "useLookBudgetProbe").mockImplementation((idle, system) => {
    calls.push({ idle, reduceMotion: system.reduceMotion });
  });
  withTabs(9);
  setPreference("archiveCardShown", false);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const first = renderSurface(<TabDeck />);
  act(() => jest.advanceTimersByTime(300));
  expect(useArchiveCard.getState().showing).toBe(true);
  expect(calls.at(-1)?.idle).toBe(false);
  unmount(first);
  setPreference("archiveCardShown", true);
  useArchiveCard.setState({ showing: false });
  const root = renderSurface(<TabDeck />);
  expect(calls.at(-1)?.idle).toBe(true);
  act(() =>
    fireGestureHandler(getByGestureTestId("deckPan"), [
      { state: State.BEGAN, x: 200, y: 400, absoluteX: 200, absoluteY: 400, translationX: 0, translationY: 0, velocityX: 0 },
      { state: State.ACTIVE, x: 200, y: 400, absoluteX: 200, absoluteY: 400, translationX: 0, translationY: 0, velocityX: 0 },
      { state: State.ACTIVE, x: 330, y: 400, absoluteX: 330, absoluteY: 400, translationX: 130, translationY: 0, velocityX: 200 },
    ]),
  );
  act(() => jest.advanceTimersByTime(16));
  expect(calls.at(-1)?.idle).toBe(false);
  act(() =>
    fireGestureHandler(getByGestureTestId("deckPan"), [
      { state: State.ACTIVE, x: 330, y: 400, absoluteX: 330, absoluteY: 400, translationX: 130, translationY: 0, velocityX: 200 },
      { state: State.END, x: 330, y: 400, absoluteX: 330, absoluteY: 400, translationX: 130, translationY: 0, velocityX: 200 },
    ]),
  );
  act(() => jest.advanceTimersByTime(2000));
  expect(calls.at(-1)?.idle).toBe(true);
  act(() => useBrowse.setState({ sheet: "spaces" }));
  expect(calls.at(-1)?.idle).toBe(false);
  act(() => useBrowse.setState({ sheet: null }));
  expect(calls.at(-1)?.idle).toBe(true);
  expect(calls.every((call) => call.reduceMotion === false)).toBe(true);
  probe.mockRestore();
  unmount(root);
});
