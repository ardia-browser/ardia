import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentStarts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => [e.properties.page_full_screen_starts, e.properties.page_full_screen_slow_starts]);
}

test("a page going full screen is counted once per way in, slow when the window waited 300 ms or more, and the counts start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const before = (await sentStarts()).length;
  usage.notePageFullScreenTransition({ entering: true, waitedMs: 120 });
  usage.notePageFullScreenTransition({ entering: true, waitedMs: usage.SLOW_PAGE_FULL_SCREEN_START_MS });
  usage.notePageFullScreenTransition({ entering: false, waitedMs: 900 });
  usage.sessionEnding();
  assert.deepEqual((await sentStarts()).slice(before), [[2, 1]]);
  usage.notePageFullScreenTransition({ entering: true, waitedMs: 40 });
  usage.sessionEnding();
  assert.deepEqual((await sentStarts()).slice(before), [[2, 1], [1, 0]]);
});

test("nothing is counted while sharing is off", async () => {
  client.setSharing(false, "settings");
  usage.notePageFullScreenTransition({ entering: true, waitedMs: 900 });
  client.setSharing(true, "settings");
  const before = (await sentStarts()).length;
  usage.notePageFullScreenTransition({ entering: true, waitedMs: 10 });
  usage.sessionEnding();
  assert.deepEqual((await sentStarts()).slice(before).at(-1), [1, 0]);
});
