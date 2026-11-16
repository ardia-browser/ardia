import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentSidebarMotion() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => [e.properties.sidebar_motion_merges, e.properties.sidebar_slide_overruns]);
}

test("merged sidebar animations and slides that ran past their deadline are counted apart in usage_counts, and start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  usage.noteSidebarMotion("overrun");
  usage.noteSidebarMotion("merge");
  usage.noteSidebarMotion("overrun");
  usage.sessionEnding();
  assert.deepEqual(await sentSidebarMotion(), [[1, 2]]);

  usage.noteSidebarMotion("overrun");
  usage.sessionEnding();
  assert.deepEqual(await sentSidebarMotion(), [[1, 2], [0, 1]]);
});
