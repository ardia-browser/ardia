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

test("New Tab pages kept for a page, and the holds that ran out, are sent as whole numbers in usage_counts", async () => {
  client.setSharing(true, "onboarding");
  usage.notePageOverlay("newTabKeptForPage");
  usage.notePageOverlay("newTabKeptForPage");
  usage.notePageOverlay("newTabKeptTimedOut");
  usage.sessionEnding();
  const [sent] = await usageCounts();
  assert.equal(sent.new_tab_kept_for_pages, 2);
  assert.equal(sent.new_tab_kept_for_page_timeouts, 1);
});
