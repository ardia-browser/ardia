import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentInputSourceKeys() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts" && "input_source_keys_webkit" in e.properties).map((e) => e.properties.input_source_keys_webkit);
}

test("英数 and かな keys pressed while sharing is off are dropped when sharing turns on, and later ones are counted", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  stub.inputSourceKeys.pending = 4;
  client.setSharing(true, "onboarding");
  usage.sessionEnding();
  assert.deepEqual(await sentInputSourceKeys(), []);
  stub.inputSourceKeys.pending = 2;
  usage.sessionEnding();
  assert.deepEqual(await sentInputSourceKeys(), [2]);
  stub.inputSourceKeys.pending = 5;
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  usage.sessionEnding();
  assert.ok(!(await sentInputSourceKeys()).includes(5));
  client.setSharing(false, "settings");
});

test("英数 and かな keys handled in a WebKit tab are sent with the hourly counts only while sharing is on, and taken once", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  stub.inputSourceKeys.pending = 4;
  usage.sessionEnding();
  assert.deepEqual(await sentInputSourceKeys(), []);
  client.setSharing(true, "onboarding");
  stub.inputSourceKeys.pending = 3;
  usage.sessionEnding();
  assert.deepEqual(await sentInputSourceKeys(), [3]);
  assert.equal(stub.inputSourceKeys.pending, 0);
  stub.inputSourceKeys.pending = 0.5;
  usage.sessionEnding();
  assert.deepEqual(await sentInputSourceKeys(), [3]);
});
