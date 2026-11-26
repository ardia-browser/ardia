import assert from "node:assert/strict";
import { test } from "node:test";
import { v3Text } from "./fixtures/manifests.mjs";
const { pluginTelemetryDisclosures } = await import("./disclosures.ts");
const { readManifest } = await import("../../lib/pluginManifest.ts");
const { PLUGIN_SENT_COPY } = await import("../telemetry/copy.ts");

const listing = (doc, extra = {}, scope = "test") => {
  const manifest = readManifest(v3Text(doc, scope)).manifest;
  return { name: manifest.name, manifest, problems: [], hash: "h", folderId: "1:1", source: "local", ...extra };
};
const store = (...listings) => ({
  order: listings.map((l) => l.name),
  listings: Object.fromEntries(listings.map((l) => [l.name, l])),
  records: Object.fromEntries(listings.map((l) => [l.name, { enabled: true, approved: "h", values: {}, applied: {} }])),
});

test("a plugin's own telemetry block is its disclosure; only Ardia's verified @ardia copy counts as official, and a quiet plugin has none", () => {
  const cli = listing({ name: "cli", title: "Command Line", telemetry: { title: "The ardia command", items: ["x", "y"] } }, { source: "store", official: true }, "ardia");
  const [official] = pluginTelemetryDisclosures(store(cli));
  assert.equal(official.title, "The ardia command");
  assert.equal(official.official, true);
  assert.equal(official.plugin, "ardia__cli");
  const copied = listing({ name: "cli", title: "Command Line", telemetry: { title: "Copied", items: ["x"] } }, { source: "dev" }, "ardia");
  assert.equal(pluginTelemetryDisclosures(store(copied))[0].official, false, "a dev link of an @ardia plugin isn't Ardia's download");
  const added = listing({ name: "mine", title: "Mine", telemetry: { title: "Mine sends", items: ["y"] } });
  const [third] = pluginTelemetryDisclosures(store(added));
  assert.equal(third.official, false);
  assert.match(PLUGIN_SENT_COPY.attribution("Mine", false), /Provided by the Mine plugin.*doesn't control it/);
  assert.equal(pluginTelemetryDisclosures(store(listing({ name: "quiet", title: "Quiet" }))).length, 0);
});

test("a plugin that is off or not approved discloses nothing", () => {
  const mine = listing({ name: "mine", title: "Mine", telemetry: { title: "Mine sends", items: ["y"] } });
  const s = store(mine);
  s.records[mine.name] = { ...s.records[mine.name], enabled: false };
  assert.deepEqual(pluginTelemetryDisclosures(s), []);
  s.records[mine.name] = { ...s.records[mine.name], enabled: true, approved: "other" };
  assert.deepEqual(pluginTelemetryDisclosures(s), []);
  assert.ok(PLUGIN_SENT_COPY.addedTitle && /doesn't control it/.test(PLUGIN_SENT_COPY.addedNote), "plugins you added sit under their own heading");
});
