import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteBookmarkletRun, takeBookmarkletCounts } = await import("./bookmarkletCounts.ts");
after(() => client.setSharing(false, "settings"));

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("bookmarklet runs and refusals count apart, and taking them starts again at zero", () => {
  noteBookmarkletRun(true);
  noteBookmarkletRun(true);
  noteBookmarkletRun(false);
  assert.deepEqual(takeBookmarkletCounts(), { bookmarklet_runs: 2, bookmarklets_refused: 1 });
  assert.deepEqual(takeBookmarkletCounts(), { bookmarklet_runs: 0, bookmarklets_refused: 0 });
});

test("an hour with only bookmarklets run still sends usage_counts, and the counts reset after", async () => {
  client.setSharing(true, "onboarding");
  noteBookmarkletRun(true);
  noteBookmarkletRun(false);
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bookmarklet_runs, 1);
  assert.equal(sent[0].bookmarklets_refused, 1);
  usage.sessionEnding();
  assert.equal((await usageCounts()).length, 1, "an hour with nothing counted sends nothing");
});
