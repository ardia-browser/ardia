import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const { noteChainStatus, takeCycleWork, takeSnapshotWrites, timedCycle } = await import("./cycleWork.ts");
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

test("with sharing on, each stretch the sync chain is missing counts once, and so does its return", () => {
  client.setSharing(true, "onboarding");
  takeSnapshotWrites();
  const token = client.consentToken();
  for (const status of ["ok", "missing", "missing", "ok", "ok"]) noteChainStatus(token, "mac", status);
  noteChainStatus(token, "mac", "missing");
  noteChainStatus(token, "set-up-again", "ok");
  const taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [2, 1], "one count per stretch the chain is gone, and a new setup finding its chain isn't a return");
  noteChainStatus(token, "mac", "missing");
  client.setSharing(false, "settings");
  noteChainStatus(client.consentToken(), "mac", "ok");
  const off = takeSnapshotWrites();
  assert.deepEqual([off.chainMissing, off.chainReturned], [0, 0], "turning sharing off forgets the count and nothing is counted while it's off");
});

test("a chain status noted under a stale consent token changes nothing, so it can't pair with a later one", () => {
  client.setSharing(true, "onboarding");
  takeSnapshotWrites();
  const stale = client.consentToken();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  const token = client.consentToken();
  noteChainStatus(stale, "mac", "missing");
  noteChainStatus(token, "mac", "ok");
  let taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [0, 0], "a stale missing doesn't make the next ok a return");
  noteChainStatus(token, "mac", "missing");
  noteChainStatus(stale, "mac", "ok");
  noteChainStatus(token, "mac", "missing");
  taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [1, 0], "a stale ok doesn't end the stretch the chain is gone");
});

test("a new consent period starts with no missing chain, so a return across it isn't counted and the next missing stretch is", () => {
  client.setSharing(true, "onboarding");
  takeSnapshotWrites();
  noteChainStatus(client.consentToken(), "mac", "missing");
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  const token = client.consentToken();
  noteChainStatus(token, "mac", "ok");
  let taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [0, 0], "a chain that went missing in an earlier period isn't counted back");
  noteChainStatus(client.consentToken(), "mac", "missing");
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteChainStatus(client.consentToken(), "mac", "missing");
  taken = takeSnapshotWrites();
  assert.deepEqual([taken.chainMissing, taken.chainReturned], [1, 0], "the stretch is counted once in the period it's seen in");
});
