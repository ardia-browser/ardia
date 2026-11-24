import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteSidebarResize } = await import("./sidebarResizeCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentSidebarResizes() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => e.properties.sidebar_resizes);
}

test("an hour with only sidebar resizes still sends usage_counts, and the count starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  noteSidebarResize();
  noteSidebarResize();
  usage.sessionEnding();
  assert.deepEqual(await sentSidebarResizes(), [2]);

  usage.sessionEnding();
  assert.deepEqual(await sentSidebarResizes(), [2]);
});
