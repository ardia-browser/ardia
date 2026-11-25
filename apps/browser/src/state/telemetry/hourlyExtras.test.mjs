import assert from "node:assert/strict";
import { test } from "node:test";
const { USAGE_COUNTS_EVENT, usageWithExtras } = await import("./hourlyExtras.ts");

function harness(extrasPerTake) {
  const sent = [];
  let clock = 0;
  let takes = 0;
  const usage = usageWithExtras(
    (event, props, _consent, options) => sent.push({ event, props, options }),
    () => extrasPerTake[takes++] ?? { intro_shown: 0 },
    () => clock,
  );
  return { sent, usage, advance: (minutes) => (clock += minutes * 60_000) };
}

test("the hour's extras ride in the same usage_counts event as main's counts", () => {
  const { sent, usage, advance } = harness([{ intro_shown: 2 }]);
  advance(60);
  usage.withHourlyExtras(() => usage.capture(USAGE_COUNTS_EVENT, { tabs_opened: 3, period_minutes: 60 }, null), null);
  assert.deepEqual(sent, [{ event: USAGE_COUNTS_EVENT, props: { intro_shown: 2, tabs_opened: 3, period_minutes: 60 }, options: {} }]);
});

test("an hour with only extras still sends one usage_counts with its period", () => {
  const { sent, usage, advance } = harness([{ intro_shown: 1 }]);
  advance(61);
  usage.withHourlyExtras(() => {}, null);
  assert.deepEqual(sent, [{ event: USAGE_COUNTS_EVENT, props: { intro_shown: 1, period_minutes: 61 }, options: undefined }]);
});

test("an hour with nothing sends nothing, and the next period starts when the hour ends", () => {
  const { sent, usage, advance } = harness([{ intro_shown: 0 }, { intro_shown: 4 }]);
  advance(60);
  usage.withHourlyExtras(() => {}, null);
  assert.equal(sent.length, 0);
  advance(30);
  usage.withHourlyExtras(() => {}, null);
  assert.deepEqual(sent, [{ event: USAGE_COUNTS_EVENT, props: { intro_shown: 4, period_minutes: 30 }, options: undefined }]);
});

test("other events pass through untouched and take no extras", () => {
  const { sent, usage } = harness([{ intro_shown: 9 }]);
  usage.capture("app_session_ended", { duration_minutes: 5 }, null, { urgent: true });
  assert.deepEqual(sent, [{ event: "app_session_ended", props: { duration_minutes: 5 }, options: { urgent: true } }]);
  usage.withHourlyExtras(() => {}, null);
  assert.equal(sent.at(-1).props.intro_shown, 9);
});

test("PRRT 4606978513 a stale usage_counts recorded on its own, outside the hour's drain, leaves the period's extras for the hour's report", () => {
  const { sent, usage, advance } = harness([{ intro_shown: 5 }]);
  usage.capture(USAGE_COUNTS_EVENT, { auto_pip_kept_visible: 1 }, null);
  advance(60);
  usage.withHourlyExtras(() => {}, null);
  assert.deepEqual(sent, [
    { event: USAGE_COUNTS_EVENT, props: { auto_pip_kept_visible: 1 }, options: {} },
    { event: USAGE_COUNTS_EVENT, props: { intro_shown: 5, period_minutes: 60 }, options: undefined },
  ]);
});
