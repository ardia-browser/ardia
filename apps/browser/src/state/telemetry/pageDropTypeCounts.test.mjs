import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { takePageDropTypeCounts } = await import("./pageDropTypeCounts.ts");
const { flushLocal } = await import("./localStore.ts");
after(() => client.setSharing(false, "settings"));

const changed = (unregistered, reregistered, epoch = client.consentEpoch()) => stub.emitEvent("engine.pageDropTypesChanged", { epoch, unregistered, reregistered });

const sentUsageCounts = async () => {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts");
};

test("page views that stopped or resumed accepting drags are counted for the hour, then the counts start again", () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takePageDropTypeCounts();
  changed(3, 0);
  changed(0, 2);
  changed(1, 1);
  assert.deepEqual(takePageDropTypeCounts(), { page_views_drop_unregistered: 4, page_views_drop_reregistered: 3 });
  assert.deepEqual(takePageDropTypeCounts(), { page_views_drop_unregistered: 0, page_views_drop_reregistered: 0 });
});

test("a change that moved no view counts nothing, and a count that isn't a whole number is dropped or clamped", () => {
  client.setSharing(true, "onboarding");
  takePageDropTypeCounts();
  changed(0, 0);
  changed("many", -4);
  changed(2.9, Number.NaN);
  changed(1e9, 0);
  assert.deepEqual(takePageDropTypeCounts(), { page_views_drop_unregistered: 1002, page_views_drop_reregistered: 0 });
});

test("an hour with only page views that stopped accepting drags still sends usage_counts, with how many and nothing about the page", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takePageDropTypeCounts();
  const before = (await sentUsageCounts()).length;

  stub.emitEvent("engine.pageDropTypesChanged", { epoch: client.consentEpoch(), unregistered: 2, reregistered: 0, url: "https://outlook.office.com/mail" });
  usage.sessionEnding();
  const sent = await sentUsageCounts();
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).properties.page_views_drop_unregistered, 2);
  assert.equal(sent.at(-1).properties.page_views_drop_reregistered, 0);
  assert.doesNotMatch(JSON.stringify(sent), /outlook/);

  usage.sessionEnding();
  assert.equal((await sentUsageCounts()).length, before + 1, "an hour with no change sends nothing more");
});

test("a drop-type change from while sharing was off, from an earlier consent period or with no epoch isn't counted, and stays in the local copy", async () => {
  client.setSharing(true, "onboarding");
  const earlier = client.consentEpoch();
  client.setSharing(false, "settings");
  changed(1, 0, "");
  client.setSharing(true, "settings");
  takePageDropTypeCounts();
  changed(1, 0, earlier);
  stub.emitEvent("engine.pageDropTypesChanged", { unregistered: 1, reregistered: 0 });
  assert.deepEqual(takePageDropTypeCounts(), { page_views_drop_unregistered: 0, page_views_drop_reregistered: 0 });
  await flushLocal();
  assert.equal(stub.telemetryLocal.records().filter((r) => r.event === "usage_counts" && r.sent === false && r.properties.page_views_drop_unregistered === 1).length, 3);
});
