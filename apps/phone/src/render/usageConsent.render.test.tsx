const mockConsent: boolean[] = [];

jest.mock("../platform/telemetry", () => ({
  ...jest.requireActual("../platform/telemetry"),
  canPostTelemetry: () => false,
  setUsageConsent: (sharing: boolean) => mockConsent.push(sharing),
  takePendingCounts: () => ({}),
}));

const { setUsageSharing, startTelemetry } = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");

test("native counts follow usage consent: told the saved choice at start, then every change", () => {
  jest.useFakeTimers();
  startTelemetry();
  expect(mockConsent).toEqual([false]);
  setUsageSharing(true, "settings");
  setUsageSharing(false, "settings");
  expect(mockConsent).toEqual([false, true, false]);
  jest.useRealTimers();
});

test("a lab can read today's usage counts and whether sharing is on, without sending anything", () => {
  jest.useFakeTimers();
  const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
  telemetry.startTelemetry();
  telemetry.setUsageSharing(true, "settings");
  telemetry.countUsage("tabs_opened");
  telemetry.countUsage("tabs_opened");
  telemetry.countUsage("searches");
  const today = telemetry.usageToday();
  expect(today.sharing).toBe(true);
  expect(today.counts).toEqual({ tabs_opened: 2, searches: 1 });
  expect(today.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  telemetry.setUsageSharing(false, "settings");
  expect(telemetry.usageToday()).toEqual({ day: null, counts: {}, sharing: false });
  jest.useRealTimers();
});
