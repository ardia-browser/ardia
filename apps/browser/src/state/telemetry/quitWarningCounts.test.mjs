import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });
const stub = await import("../../test-native/index.ts");
const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteQuitWarningAfterCloseTabs, takeQuitWarningCounts } = await import("./quitWarningCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((event) => event.event === "usage_counts").map((event) => [event.properties.quit_warnings_after_close_tabs, event.properties.quit_warnings_after_close_tabs_cancelled]);
}

test("quit warning counts drain without sending when sharing is off and emit only fresh counts when enabled", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  noteQuitWarningAfterCloseTabs("cancelled");
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), []);
  assert.deepEqual(takeQuitWarningCounts(), { quit_warnings_after_close_tabs: 0, quit_warnings_after_close_tabs_cancelled: 0 });
  client.setSharing(true, "settings");
  noteQuitWarningAfterCloseTabs("confirmed");
  noteQuitWarningAfterCloseTabs("cancelled");
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [[2, 1]]);
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [[2, 1]]);
});
