import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: false, decidedAt: 1, askDoneAt: 1, installId: "i", crashCursor: 0, lastVersion: null, sessionOpen: false }));
const { noteTopAppsSharing, releaseTopAppsSharing } = await import("./topAppsSharing.ts");
const client = await import("./client.ts");
const choice = await import("./choice.ts");
after(() => client.setSharing(false, "settings"));

test("top-app events held before the choice loads keep the period from the first load, even when a reload later finds sharing on", async () => {
  noteTopAppsSharing("top_apps_mirrored", { tiles: 1 });
  choice.loadChoice();
  client.setSharing(true, "settings");
  choice.reloadChoice();
  releaseTopAppsSharing();
  await client.saveQueueNow();
  const queued = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event.startsWith("top_apps_"));
  assert.deepEqual(queued, []);
});
