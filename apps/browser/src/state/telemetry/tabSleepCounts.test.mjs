import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteCaptureIndicatorCleared, noteTabSlept, takeTabSleepCounts } = await import("./tabSleepCounts.ts");
const takePinnedTabsSleptByMemorySaver = () => takeTabSleepCounts().pinned_tabs_slept_by_memory_saver;
after(() => client.setSharing(false, "settings"));

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("only a pinned tab that Memory Saver's timer put to sleep counts", () => {
  noteTabSlept(true, "proactive");
  noteTabSlept(false, "proactive");
  noteTabSlept(true, "external");
  noteTabSlept(true, "urgent");
  noteTabSlept(true, "suggested");
  noteTabSlept(true, "frozen");
  noteTabSlept(true, null);
  assert.equal(takePinnedTabsSleptByMemorySaver(), 1);
  assert.equal(takePinnedTabsSleptByMemorySaver(), 0, "taking the count starts it again at zero");
});

test("an hour with only pinned tabs put to sleep still sends usage_counts, and the count resets after", async () => {
  client.setSharing(true, "onboarding");
  noteTabSlept(true, "proactive");
  noteTabSlept(true, "proactive");
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pinned_tabs_slept_by_memory_saver, 2);
  assert.equal(sent[0].capture_indicators_cleared, 0);
  noteCaptureIndicatorCleared();
  usage.sessionEnding();
  assert.deepEqual((await usageCounts()).map((p) => [p.capture_indicators_cleared, p.pinned_tabs_slept_by_memory_saver]), [[0, 2], [1, 0]]);
  usage.sessionEnding();
  assert.equal((await usageCounts()).length, 2);
});

test("the sleep policy's counters only add up while sharing is on", async () => {
  const { setConsentPeriod } = await import("./consentPeriod.ts");
  const { noteSleepVeto, noteTabSleptOverBudget, noteMemoryPressure, noteBudgetSweep } = await import("./tabSleepCounts.ts");
  const fields = ["sleep_kept_download", "tabs_slept_over_budget", "tabs_slept_under_memory_warning", "memory_pressure_criticals", "tabs_over_budget_skipped_loading"];
  const noteAll = () => {
    noteSleepVeto("download");
    noteTabSleptOverBudget(undefined, "warning");
    noteMemoryPressure("critical");
    noteBudgetSweep(2, 0);
  };
  takeTabSleepCounts();
  setConsentPeriod(false, null);
  noteAll();
  const off = takeTabSleepCounts();
  assert.deepEqual(fields.map((f) => off[f]), [0, 0, 0, 0, 0], "nothing is kept while sharing is off");
  setConsentPeriod(true, "sleep-counters-test");
  noteAll();
  const on = takeTabSleepCounts();
  assert.deepEqual(fields.map((f) => on[f]), [1, 1, 1, 1, 2]);
  setConsentPeriod(false, null);
});
