import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => e.properties.recorded_windows_kept_drawing);
}

test("a picked window or screen is counted as a window kept drawing, a picked tab is not, and the count starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  usage.noteSharePicked("tab");
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [0]);

  usage.noteSharePicked("window");
  usage.noteSharePicked("screen");
  usage.noteSharePicked("tab");
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [0, 2]);

  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [0, 2]);
  usage.noteSharePicked("tab");
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [0, 2, 0]);
});
