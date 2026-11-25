import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const counts = await import("./openTabSyncCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((event) => event.event === "usage_counts").map((event) =>
    Object.fromEntries(Object.entries(event.properties).filter(([key]) => key.startsWith("sync_open_tabs_"))),
  );
}

test("open-tab sync counts collected while sharing is off never enter the upload queue", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  counts.noteOpenTabsPublished(9);
  counts.noteOpenTabsWoke();
  counts.noteOpenTabsApplied({ opened: 2, closed: 6, updated: 1 });
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), []);
  client.setSharing(true, "settings");
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), []);
});

test("sharing sends the open-tab sync counters once with the mass-close alarm and largest cycle", async () => {
  client.setSharing(true, "settings");
  counts.noteOpenTabsPublished(3);
  counts.noteOpenTabsWoke();
  counts.noteOpenTabsApplied({ opened: 2, closed: 5, updated: 1 });
  counts.noteOpenTabsApplied({ opened: 1, closed: 0, updated: 2 });
  usage.sessionEnding();
  const expected = [{
    sync_open_tabs_published: 3,
    sync_open_tabs_opened: 3,
    sync_open_tabs_closed: 5,
    sync_open_tabs_updated: 3,
    sync_open_tabs_wakes: 1,
    sync_open_tabs_mass_closes: 1,
    sync_open_tabs_cycle_max: 7,
  }];
  assert.deepEqual(await sentCounts(), expected);
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), expected);
});
