import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("long hover holds and clipped enters reach usage_counts only for the consent period they began in", async () => {
  client.setSharing(true, "onboarding");
  stub.hoverCounts.pending = { [client.consentToken()]: { holds: 2, clipped: 3 }, "a-period-sharing-was-off": { holds: 7, clipped: 9 } };
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].hover_holds_over_300ms, 2);
  assert.equal(sent[0].hover_clipped_enters, 3);
  usage.sessionEnding();
  assert.equal((await usageCounts()).length, 1);
});
