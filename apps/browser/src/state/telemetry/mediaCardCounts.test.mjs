import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { sidebarPlayerOpenCounter, takeMediaCardCounts } = await import("./mediaCardCounts.ts");
after(() => client.setSharing(false, "settings"));

const sidebarCounts = () => {
  const { sidebar_player_expands, sidebar_player_reopens } = takeMediaCardCounts();
  return { expands: sidebar_player_expands, reopens: sidebar_player_reopens };
};

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("the first open of a card that just appeared is not a reopen, even before its resting motion ends", () => {
  takeMediaCardCounts();
  const card = sidebarPlayerOpenCounter();
  card.motionStarted(false);
  card.motionStarted(true);
  assert.deepEqual(sidebarCounts(), { expands: 1, reopens: 0 });
});

test("an open while the card is still closing is a reopen, and one after it closed is not", () => {
  takeMediaCardCounts();
  const card = sidebarPlayerOpenCounter();
  card.motionStarted(false);
  card.closeFinished();
  card.motionStarted(true);
  card.motionStarted(false);
  card.motionStarted(true);
  card.motionStarted(false);
  card.closeFinished();
  card.motionStarted(true);
  assert.deepEqual(sidebarCounts(), { expands: 3, reopens: 1 });
  assert.deepEqual(sidebarCounts(), { expands: 0, reopens: 0 });
});

test("an hour with only a reopen counted still sends usage_counts with both counts", async () => {
  takeMediaCardCounts();
  client.setSharing(true, "onboarding");
  const card = sidebarPlayerOpenCounter();
  card.motionStarted(true);
  card.motionStarted(false);
  card.motionStarted(true);
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sidebar_player_expands, 2);
  assert.equal(sent[0].sidebar_player_reopens, 1);
});
