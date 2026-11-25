import assert from "node:assert/strict";
import { after, test } from "node:test";
import { noteBrowsingDataCleared, noteHistoryRowsRemoved, takeHistoryRemovalCounts } from "./historyRemovalCounts.ts";

globalThis.fetch = async () => ({ ok: true });
const stub = await import("../../test-native/index.ts");
const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((event) => event.event === "usage_counts").map((event) => event.properties) : [];
}

test("browsing data outcomes join the existing history counts and reset after collection", () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takeHistoryRemovalCounts();
  noteHistoryRowsRemoved("key", 3);
  noteBrowsingDataCleared(true);
  noteBrowsingDataCleared(false);
  noteBrowsingDataCleared(false);
  assert.deepEqual(takeHistoryRemovalCounts(), {
    history_removals_by_key: 1,
    history_removals_by_button: 0,
    history_removals_by_menu: 0,
    history_rows_removed_by_key: 3,
    history_rows_removed_by_button: 0,
    history_rows_removed_by_menu: 0,
    browsing_data_clears: 1,
    browsing_data_clear_failures: 2,
  });
  assert.ok(Object.values(takeHistoryRemovalCounts()).every((count) => count === 0));
});

test("browsing data outcomes are queued in usage_counts only with sharing enabled", async () => {
  client.setSharing(false, "settings");
  noteBrowsingDataCleared(false);
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), []);
  client.setSharing(true, "settings");
  noteBrowsingDataCleared(true);
  noteBrowsingDataCleared(false);
  usage.sessionEnding();
  const counts = await sentCounts();
  assert.deepEqual(counts.map((row) => [row.browsing_data_clears, row.browsing_data_clear_failures]), [[1, 1]]);
});
