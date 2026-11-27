import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const counts = await import("./openTabSyncCounts.ts");
const safety = await import("./syncSafetyCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentCounts(fields = (key) => key.startsWith("sync_open_tabs_")) {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((event) => event.event === "usage_counts").map((event) =>
    Object.fromEntries(Object.entries(event.properties).filter(([key]) => fields(key))),
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
  counts.noteOpenTabClosesSent(client.consentToken(), 4);
  counts.noteOpenTabClosesSent(client.consentToken(), 6);
  usage.sessionEnding();
  const expected = [{
    sync_open_tabs_published: 3,
    sync_open_tabs_opened: 3,
    sync_open_tabs_closed: 5,
    sync_open_tabs_updated: 3,
    sync_open_tabs_wakes: 1,
    sync_open_tabs_mass_closes: 1,
    sync_open_tabs_mass_close_sends: 1,
    sync_open_tabs_cycle_max: 7,
  }];
  assert.deepEqual(await sentCounts(), expected);
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), expected);
});

const SAFETY_FIELDS = new Set(["sync_session_rebases", "sync_profiles_missing_here", "sync_join_waits"]);

test("sync's data-safety counts go out in the same hourly event, then start again from zero", async () => {
  client.setSharing(true, "settings");
  usage.sessionEnding();
  await sentCounts();
  stub.docs.delete("telemetry-queue.json");
  const token = client.consentToken();
  safety.noteSessionRebase(token);
  safety.noteMissingProfiles(token, 2);
  safety.noteMissingProfiles(token, 1);
  safety.noteJoinWait(token);
  safety.noteJoinWait(token);
  safety.noteJoinWait(null);
  counts.noteOpenTabsPublished(1);
  usage.sessionEnding();
  const sent = await sentCounts((key) => SAFETY_FIELDS.has(key));
  assert.deepEqual(sent.at(-1), { sync_session_rebases: 1, sync_profiles_missing_here: 2, sync_join_waits: 2 });
  assert.deepEqual(safety.takeSyncDataCounts(), { ...counts.takeOpenTabSyncCounts(), sync_session_rebases: 0, sync_profiles_missing_here: 0, sync_join_waits: 0 });
});

test("a mass-close send counts only under the consent of the cycle that made it, never after sharing turned on later", async () => {
  client.setSharing(false, "settings");
  const before = client.consentToken();
  client.setSharing(true, "settings");
  usage.sessionEnding();
  await sentCounts();
  stub.docs.delete("telemetry-queue.json");
  counts.noteOpenTabClosesSent(before, 7);
  const earlier = client.consentToken();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  counts.noteOpenTabClosesSent(earlier, 9);
  counts.noteOpenTabsPublished(1);
  usage.sessionEnding();
  const sent = await sentCounts((key) => key === "sync_open_tabs_mass_close_sends");
  assert.deepEqual(sent.at(-1), { sync_open_tabs_mass_close_sends: 0 }, "a send from before sharing was on, or from an earlier sharing period, isn't counted");
  counts.noteOpenTabClosesSent(client.consentToken(), 5);
  usage.sessionEnding();
  assert.deepEqual((await sentCounts((key) => key === "sync_open_tabs_mass_close_sends")).at(-1), { sync_open_tabs_mass_close_sends: 1 });
});
