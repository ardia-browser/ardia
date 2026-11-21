import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { markRemoved, settleRemovals } = await import("../sync/profileRemoval.ts");
after(() => client.setSharing(false, "settings"));

const docWith = (...syncIds) => ({
  profiles: {},
  scopes: { app: { records: Object.fromEntries(syncIds.map((id) => [`prof:${id}`, { h: "1", v: { n: id, c: "blue", i: null } }])) } },
});

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("an hour whose only activity is removing profiles from sync still sends their count, then starts again at zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const doc = docWith("work", "school");
  assert.equal(markRemoved(doc, "work"), true);
  assert.equal(markRemoved(doc, "school"), true);
  usage.sessionEnding();
  assert.deepEqual((await usageCounts()).map((p) => p.synced_profiles_removed), [2]);
  usage.sessionEnding();
  assert.equal((await usageCounts()).length, 1);
});

test("a removal that finds the profile published again by another device counts once as returned, and the profile is left alone", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const doc = docWith("work");
  const app = Object.assign(doc.scopes.app, { joined: true, base: {}, unapplied: [] });
  assert.equal(markRemoved(doc, "work"), true);
  usage.sessionEnding();
  await usageCounts();
  app.records["prof:work"] = { h: "2", v: { n: "work", c: "blue", i: null } };
  settleRemovals(doc, app);
  settleRemovals(doc, app);
  assert.equal(doc.removing, undefined);
  usage.sessionEnding();
  const sent = (await usageCounts()).at(-1);
  assert.equal(sent.synced_removals_returned, 1);
  assert.equal(sent.synced_profiles_removed, 0);
});
