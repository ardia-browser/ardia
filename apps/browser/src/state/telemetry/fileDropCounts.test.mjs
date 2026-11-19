import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { takeFileDropCounts } = await import("./fileDropCounts.ts");
const { flushLocal } = await import("./localStore.ts");
after(() => client.setSharing(false, "settings"));

const refused = (area, epoch = client.consentEpoch()) => stub.emitAppEvent({ type: "fileDropRefused", area, epoch });

const sentUsageCounts = async () => {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts");
};

test("each file drag a drop area refuses is counted for the hour by the area's kind, then the counts start again", () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takeFileDropCounts();
  refused("extensionPackages");
  refused("extensionPackages");
  refused("links");
  refused("linksAndText");
  assert.deepEqual(takeFileDropCounts(), {
    file_drops_refused_links: 1,
    file_drops_refused_links_and_text: 1,
    file_drops_refused_extension_packages: 2,
    file_drops_refused_other: 0,
  });
  assert.deepEqual(Object.values(takeFileDropCounts()), [0, 0, 0, 0]);
});

test("an area kind the app doesn't know is counted as other, and sends nothing that was in the event", () => {
  client.setSharing(true, "onboarding");
  takeFileDropCounts();
  refused("/Users/someone/Desktop/invoice.pdf");
  refused(undefined);
  assert.deepEqual(takeFileDropCounts(), {
    file_drops_refused_links: 0,
    file_drops_refused_links_and_text: 0,
    file_drops_refused_extension_packages: 0,
    file_drops_refused_other: 2,
  });
});

test("an hour with only a refused file drag still sends usage_counts, with how many by kind and nothing else about the drag", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takeFileDropCounts();
  const before = (await sentUsageCounts()).length;

  refused("extensionPackages");
  refused("extensionPackages");
  stub.emitAppEvent({ type: "fileDropRefused", area: "extensionPackages", names: ["secret-plan.pdf"], path: "/Users/someone/secret-plan.pdf", epoch: client.consentEpoch() });
  usage.sessionEnding();
  const sent = await sentUsageCounts();
  assert.equal(sent.length, before + 1);
  const properties = sent.at(-1).properties;
  assert.equal(properties.file_drops_refused_extension_packages, 3);
  assert.equal(properties.file_drops_refused_links, 0);
  assert.doesNotMatch(JSON.stringify(sent), /secret-plan|someone|\/Users/);

  usage.sessionEnding();
  assert.equal((await sentUsageCounts()).length, before + 1, "an hour with no refused drag sends nothing more");
});

test("a refused file drag from while sharing was off, from an earlier consent period or with no epoch isn't counted, and stays in the local copy", async () => {
  client.setSharing(true, "onboarding");
  const earlier = client.consentEpoch();
  client.setSharing(false, "settings");
  refused("links", "");
  client.setSharing(true, "settings");
  takeFileDropCounts();
  refused("links", earlier);
  stub.emitAppEvent({ type: "fileDropRefused", area: "links" });
  assert.deepEqual(Object.values(takeFileDropCounts()), [0, 0, 0, 0]);
  await flushLocal();
  assert.equal(stub.telemetryLocal.records().filter((r) => r.event === "usage_counts" && r.sent === false && r.properties.file_drops_refused_links === 1).length, 3);
});
