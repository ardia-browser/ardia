import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const { noteChainHealthy, noteChainMissing, takeCycleWork, takeSnapshotWrites, timedCycle } = await import("./cycleWork.ts");
after(() => client.setSharing(false, "settings"));

const none = { cycles: 0, ms: 0, longestMs: 0 };

test("a sync cycle that runs while sharing is off is never counted, even once sharing is turned on", async () => {
  client.setSharing(false, "settings");
  takeCycleWork();
  await timedCycle(Date.now() - 40, Promise.resolve());
  client.setSharing(true, "onboarding");
  assert.deepEqual(takeCycleWork(), none);
});

test("a cycle under way when sharing changes is dropped, and turning sharing off forgets what was counted", async () => {
  client.setSharing(true, "onboarding");
  takeCycleWork();
  await timedCycle(Date.now() - 30, Promise.resolve());
  let finish;
  const spanning = timedCycle(Date.now() - 50, new Promise((resolve) => (finish = resolve)));
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  finish();
  await spanning;
  assert.deepEqual(takeCycleWork(), none);

  await timedCycle(Date.now() - 20, Promise.resolve());
  client.setSharing(false, "settings");
  assert.deepEqual(takeCycleWork(), none);
});

test("with sharing on, cycles add up to a count, a total and the longest", async () => {
  client.setSharing(true, "onboarding");
  takeCycleWork();
  await timedCycle(Date.now() - 30, Promise.resolve());
  await timedCycle(Date.now() - 80, Promise.resolve());
  const taken = takeCycleWork();
  assert.equal(taken.cycles, 2);
  assert.ok(taken.ms >= 110 && taken.longestMs >= 80 && taken.longestMs <= taken.ms, JSON.stringify(taken));
  assert.deepEqual(takeCycleWork(), none);
});

test("with sharing on, each outage of the sync chain counts once, and so does its return", () => {
  client.setSharing(true, "onboarding");
  takeSnapshotWrites();
  const token = client.consentToken();
  const doc = {};
  noteChainHealthy(doc, "/sync");
  for (let i = 0; i < 3; i++) noteChainMissing(doc, "/sync", token);
  noteChainHealthy(doc, "/sync");
  noteChainHealthy(doc, "/sync");
  noteChainMissing(doc, "/sync", token);
  noteChainHealthy({}, "/sync");
  const taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [2, 1], "one count per outage, and a new setup finding its chain isn't a return");
  assert.deepEqual(doc.chainOutage, { folder: "/sync", seen: token, counted: true }, "the outage stays recorded until the chain is healthy again");
  client.setSharing(false, "settings");
  noteChainHealthy(doc, "/sync");
  const off = takeSnapshotWrites();
  assert.deepEqual([off.chainMissing, off.chainReturned], [0, 0], "turning sharing off forgets the count and nothing is counted while it's off");
  assert.equal(doc.chainOutage, undefined);
});

test("an outage first seen with sharing off, or under a stale token, is never counted, nor is its return", () => {
  client.setSharing(false, "settings");
  const doc = {};
  noteChainMissing(doc, "/sync", client.consentToken());
  client.setSharing(true, "settings");
  takeSnapshotWrites();
  for (let i = 0; i < 3; i++) noteChainMissing(doc, "/sync", client.consentToken());
  noteChainHealthy(doc, "/sync");
  const stale = client.consentToken();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  const staleDoc = {};
  noteChainMissing(staleDoc, "/sync", stale);
  noteChainMissing(staleDoc, "/sync", client.consentToken());
  noteChainHealthy(staleDoc, "/sync");
  const taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [0, 0]);
});

test("an outage first seen in one consent period is counted in none after it, and a new outage in the new period is", () => {
  client.setSharing(true, "onboarding");
  takeSnapshotWrites();
  const doc = {};
  noteChainMissing(doc, "/sync", client.consentToken(), false);
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteChainMissing(doc, "/sync", client.consentToken());
  noteChainMissing(doc, "/sync", client.consentToken());
  noteChainHealthy(doc, "/sync");
  let taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [0, 0], "the outage belongs to the period it was first seen in");
  noteChainMissing(doc, "/sync", client.consentToken());
  noteChainMissing(doc, "/moved", client.consentToken());
  taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [2, 0], "a new outage, or one in another folder, is its own");
});
