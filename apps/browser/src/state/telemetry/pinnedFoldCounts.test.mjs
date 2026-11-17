import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { togglePinnedFold, setPinnedCollapsed } = await import("../sidebar/pinnedFold.ts");
const { takePinnedFoldCounts } = await import("./pinnedFoldCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentFoldCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => [e.properties.pinned_section_collapses, e.properties.pinned_section_expands]);
}

test("an hour with only pinned-section toggles sends their counts in usage_counts, and nothing from before sharing was on", async () => {
  client.loadChoice();
  useBrowser.getState().hydrate({});
  client.setSharing(false, "settings");
  togglePinnedFold("default");
  client.setSharing(true, "settings");
  togglePinnedFold("default");
  togglePinnedFold("default");
  togglePinnedFold("default");
  usage.sessionEnding();
  assert.deepEqual(await sentFoldCounts(), [[1, 2]]);
  usage.sessionEnding();
  assert.deepEqual(await sentFoldCounts(), [[1, 2]]);
});

test("only a toggle counts: an unknown profile and the section opening by itself do not", () => {
  useBrowser.getState().hydrate({});
  client.setSharing(true, "settings");
  takePinnedFoldCounts();
  togglePinnedFold("missing-profile");
  togglePinnedFold("default");
  setPinnedCollapsed("default", false);
  assert.deepEqual(takePinnedFoldCounts(), { pinned_section_collapses: 1, pinned_section_expands: 0 });
});

test("turning sharing off drops the counts not sent yet", () => {
  useBrowser.getState().hydrate({});
  client.setSharing(true, "settings");
  togglePinnedFold("default");
  client.setSharing(false, "settings");
  assert.deepEqual(takePinnedFoldCounts(), { pinned_section_collapses: 0, pinned_section_expands: 0 });
});
