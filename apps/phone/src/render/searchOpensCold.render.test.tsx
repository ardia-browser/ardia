import { act } from "react-test-renderer";
import { dismissSearch, presentSearch } from "../state/search/store";
import { setIncognito } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { withTabs } from "../../test/render/harness";

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const cold = () => counted.mock.calls.filter(([name]) => name === "search_opens_cold").length;

test("a search that opens with no rows ready for its scope is counted once as cold, a warm one isn't, and Incognito is never counted", () => {
  act(() => presentSearch("home", ""));
  expect(cold()).toBe(1);
  act(() => jest.advanceTimersByTime(500));
  act(() => dismissSearch());
  act(() => presentSearch("home", ""));
  expect(cold()).toBe(1);
  act(() => dismissSearch());
  act(() => void setIncognito(true));
  act(() => presentSearch("home", ""));
  expect(cold()).toBe(1);
});
