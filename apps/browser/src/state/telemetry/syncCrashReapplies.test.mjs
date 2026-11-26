import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteCycle, noteReapplied } = await import("../sync/cycleWork.ts");
after(() => client.setSharing(false, "settings"));

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("keys applied again after a crash are counted for the consent period their cycle started in, and never across a change of choice", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  noteReapplied(3, client.consentToken());
  usage.sessionEnding();
  assert.equal((await usageCounts()).at(-1).sync_crash_reapplies, 3);
  const startedBefore = client.consentToken();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteReapplied(5, startedBefore);
  noteReapplied(2, null);
  noteReapplied(1, client.consentToken());
  usage.sessionEnding();
  assert.equal((await usageCounts()).at(-1).sync_crash_reapplies, 1);
});

test("a cycle that started under an earlier choice adds neither its snapshot nor its re-applies", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const startedBefore = client.consentToken();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteCycle(startedBefore, { snapshotBytes: 900, reapplied: 4 });
  noteCycle(client.consentToken(), { snapshotBytes: 100, reapplied: 1 });
  usage.sessionEnding();
  const sent = (await usageCounts()).at(-1);
  assert.equal(sent.sync_crash_reapplies, 1);
  assert.equal(sent.sync_snapshots_written, 1);
});
