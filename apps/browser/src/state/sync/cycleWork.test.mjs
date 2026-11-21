import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const { takeCycleWork, timedCycle } = await import("./cycleWork.ts");
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
