import assert from "node:assert/strict";
import { after, test } from "node:test";
import { docs } from "../../test-native/index.ts";
import * as client from "./client.ts";
import { notePageOverlay, sessionEnding } from "./usage.ts";

const counts = () => JSON.parse(docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((event) => event.event === "usage_counts").map((event) => event.properties.new_tab_leaves_without_linger);
after(() => client.setSharing(false, "settings"));

test("New Tab switches without a hold stay inside consent and drain with usage counts", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  notePageOverlay("newTabLeftWithoutLinger");
  sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual(counts(), []);
  client.setSharing(true, "onboarding");
  notePageOverlay("newTabLeftWithoutLinger");
  notePageOverlay("newTabLeftWithoutLinger");
  sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual(counts(), [2]);
  sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual(counts(), [2]);
});
