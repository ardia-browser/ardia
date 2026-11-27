import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false, processStart: Date.now() - 1500 });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const journeys = await import("./journeys.ts");
after(() => client.setSharing(false, "settings"));

async function sentLaunches() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{\"events\":[]}");
  return saved.events.filter((e) => e.event === "perf_launch");
}

test("a launch whose consent was taken before sharing went off and on again is never measured or sent in the new period", async () => {
  client.loadChoice();
  assert.equal(client.isSharing(), true);
  journeys.startJourneys(null);
  const atStart = client.consentNow();
  assert.ok(atStart);

  await client.setSharing(false, "settings");
  await client.setSharing(true, "settings");
  assert.ok(client.consentNow());
  assert.notEqual(client.consentNow(), atStart);
  assert.equal(journeys.devJourneys().on, true);

  journeys.launchCommitted(atStart, Date.now() - 20);
  assert.deepEqual(journeys.devJourneys().pending, []);
  journeys.journeysEnding();
  assert.deepEqual(await sentLaunches(), []);
});
