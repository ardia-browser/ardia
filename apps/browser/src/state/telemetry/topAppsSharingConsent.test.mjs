import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
const { noteTopAppsSharing, releaseTopAppsSharing } = await import("./topAppsSharing.ts");
after(() => client.setSharing(false, "settings"));

async function queued(prefix) {
  await client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event.startsWith(prefix));
}

test("top-app sharing events noted while sharing was off, and the count of ones dropped, are not sent when telemetry starts after sharing is turned on", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  for (let i = 0; i < 20; i++) noteTopAppsSharing("top_apps_mirrored", { tiles: i });
  client.setSharing(true, "settings");
  releaseTopAppsSharing();
  assert.deepEqual(await queued("top_apps_"), []);
  const { flushLocal } = await import("./localStore.ts");
  await flushLocal();
  assert.equal(stub.telemetryLocal.records().filter((r) => r.event === "top_apps_mirrored" && r.sent === false).length, 16);
  noteTopAppsSharing("top_apps_mirrored", { tiles: 99 });
  assert.deepEqual((await queued("top_apps_")).map((e) => e.properties.tiles), [99]);
});

