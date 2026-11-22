import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const queuedEvent = (event) => ({ uuid: `u-${event}`, event, distinct_id: "install", timestamp: new Date(0).toISOString(), properties: {} });

test("9 a queue written in an earlier consent period isn't sent after a restart, and one from the current period is", async () => {
  stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, epoch: "current-period" }));
  stub.docs.set("telemetry-queue.json", JSON.stringify({ version: 1, events: [queuedEvent("from_an_earlier_period")], logs: [], epoch: "earlier-period" }));
  const client = await import("./client.ts");
  client.loadChoice();
  assert.equal(client.isSharing(), true);
  client.capture("after_restart", {}, client.consentNow());
  await client.saveQueueNow();
  const events = JSON.parse(stub.docs.get("telemetry-queue.json")).events.map((e) => e.event);
  assert.deepEqual(events, ["after_restart"]);
  client.setSharing(false, "settings");
});
