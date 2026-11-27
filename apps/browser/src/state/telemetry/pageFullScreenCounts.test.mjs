import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const placement = await import("./windowPlacementCounts.ts");
const { fullScreenTransitionOf } = await import("../../../../../packages/ardiacore/src/pageEvents.ts");
after(() => client.setSharing(false, "settings"));

const delivered = (payload) => placement.notePageFullScreenTransition(fullScreenTransitionOf(payload));

async function sentStarts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => [e.properties.page_full_screen_starts, e.properties.page_full_screen_slow_starts]);
}

test("a page going full screen is counted once per way in, slow when the window waited 300 ms or more, and the counts start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const before = (await sentStarts()).length;
  const epoch = client.consentEpoch();
  delivered({ entering: true, waitedMs: 120, epoch });
  delivered({ entering: true, waitedMs: placement.SLOW_PAGE_FULL_SCREEN_START_MS, epoch });
  delivered({ entering: false, waitedMs: 900, epoch });
  usage.sessionEnding();
  assert.deepEqual((await sentStarts()).slice(before), [[2, 1]]);
  delivered({ entering: true, waitedMs: 40, epoch: client.consentEpoch() });
  usage.sessionEnding();
  assert.deepEqual((await sentStarts()).slice(before), [[2, 1], [1, 0]]);
});

test("a transition that began before sharing was turned on, or in an earlier sharing period, is not counted when it arrives later", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  const startedWhileOff = client.consentEpoch();
  client.setSharing(true, "settings");
  const startedEarlierPeriod = client.consentEpoch();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  const before = (await sentStarts()).length;
  delivered({ entering: true, waitedMs: 900, epoch: startedWhileOff });
  delivered({ entering: true, waitedMs: 900, epoch: startedEarlierPeriod });
  delivered({ entering: true, waitedMs: 10, epoch: client.consentEpoch() });
  usage.sessionEnding();
  assert.deepEqual((await sentStarts()).slice(before).at(-1), [1, 0]);
});

test("nothing is counted while sharing is off, even with the current period's stamp", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  const epoch = client.consentEpoch();
  client.setSharing(false, "settings");
  delivered({ entering: true, waitedMs: 900, epoch });
  client.setSharing(true, "settings");
  const before = (await sentStarts()).length;
  delivered({ entering: true, waitedMs: 10, epoch: client.consentEpoch() });
  usage.sessionEnding();
  assert.deepEqual((await sentStarts()).slice(before).at(-1), [1, 0]);
});
