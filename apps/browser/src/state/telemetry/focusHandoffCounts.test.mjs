import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentUsageCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events
    .filter((e) => e.event === "usage_counts")
    .map((e) => Object.fromEntries(Object.entries(e.properties).filter(([key]) => key.startsWith("focus_handoff"))));
}

test("focus handoff outcomes and pickup times are sent with the hourly counts, odd values become 0, and the native counts are taken once", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  stub.focusHandoffCounts.pending = { [client.consentEpoch()]: { delivered: 4, timedOut: 1, superseded: 2, dropped: 3, pickupUnder400ms: 2, pickup400To1000ms: 1, pickupOver1s: 1, typed: 9, bogus: -2 } };
  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [
    {
      focus_handoffs_delivered: 4,
      focus_handoffs_timed_out: 1,
      focus_handoffs_superseded: 2,
      focus_handoff_inputs_dropped: 3,
      focus_handoff_pickups_under_400ms: 2,
      focus_handoff_pickups_400_1000ms: 1,
      focus_handoff_pickups_over_1s: 1,
    },
  ]);
  assert.deepEqual(stub.focusHandoffCounts.pending, {});
});

test("focus handoffs from while sharing was off are never sent, and handoffs after sharing turns on are", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  stub.focusHandoffCounts.pending = { "": { delivered: 5, timedOut: 2 } };
  client.setSharing(true, "settings");
  usage.sessionEnding();
  assert.ok((await sentUsageCounts()).every((sent) => !sent.focus_handoffs_delivered && !sent.focus_handoffs_timed_out));
  stub.focusHandoffCounts.pending = { [client.consentEpoch()]: { delivered: 1 } };
  usage.sessionEnding();
  assert.equal((await sentUsageCounts()).at(-1).focus_handoffs_delivered, 1);
});

test("D hand-offs from while sharing was off or from an earlier consent period aren't counted and aren't kept in the local copy", async () => {
  const { flushLocal } = await import("./localStore.ts");
  await flushLocal();
  const already = stub.telemetryLocal.records().length;
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const earlier = client.consentEpoch();
  client.setSharing(false, "settings");
  stub.focusHandoffCounts.pending = { "": { delivered: 2, pickupUnder400ms: 2 } };
  usage.sessionEnding();
  client.setSharing(true, "settings");
  stub.focusHandoffCounts.pending = { [earlier]: { timedOut: 3 }, [client.consentEpoch()]: { delivered: 1 } };
  usage.sessionEnding();
  await flushLocal();
  const local = stub.telemetryLocal.records().slice(already).filter((r) => r.event === "usage_counts" && (r.properties.focus_handoffs_delivered || r.properties.focus_handoffs_timed_out));
  assert.deepEqual(local.map((r) => [r.sent, r.properties.focus_handoffs_delivered ?? 0, r.properties.focus_handoffs_timed_out ?? 0]), [[true, 1, 0]]);
  const sent = await sentUsageCounts();
  assert.equal(sent.at(-1).focus_handoffs_delivered, 1);
  assert.ok(sent.every((p) => !p.focus_handoffs_timed_out));
});
