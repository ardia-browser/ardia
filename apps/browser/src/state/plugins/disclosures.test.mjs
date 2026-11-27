import assert from "node:assert/strict";
import { test } from "node:test";
const { pluginTelemetryDisclosures } = await import("./disclosures.ts");
const { readManifest } = await import("../../lib/pluginManifest.ts");
const { PLUGIN_SENT_COPY } = await import("../telemetry/copy.ts");
const { OFFICIAL_TELEMETRY } = await import("./officialPin.ts");

const listing = (text, extra = {}) => {
  const manifest = readManifest(JSON.stringify(text)).manifest;
  return { name: manifest.name, manifest, problems: [], hash: "h", folderId: extra.official ? "bundled" : "1:1", ...extra };
};
const store = (...listings) => ({
  order: listings.map((l) => l.name),
  listings: Object.fromEntries(listings.map((l) => [l.name, l])),
  records: Object.fromEntries(listings.map((l) => [l.name, { enabled: true, approved: "h", values: {}, applied: {}, installed: true }])),
});

test("an official plugin whose manifest has no telemetry block keeps the pin's disclosure; its own block wins, and a plugin you added is labelled as its own", () => {
  const cli = listing({ manifest: 1, name: "cli", title: "Command Line", alwaysOn: true, official: true, programs: [{ name: "ardia", path: "bin/ardia" }] }, { official: true });
  const [fallback] = pluginTelemetryDisclosures(store(cli));
  assert.equal(fallback.title, "The ardia command");
  assert.equal(fallback.official, true);
  assert.deepEqual(fallback.items, OFFICIAL_TELEMETRY.cli.items);
  assert.ok(fallback.items.length > 0);
  const own = listing({ manifest: 2, name: "cli", title: "Command Line", alwaysOn: true, official: true, telemetry: { title: "Its own words", items: ["x"] } }, { official: true });
  assert.equal(pluginTelemetryDisclosures(store(own))[0].title, "Its own words");
  const added = listing({ manifest: 2, name: "mine", title: "Mine", telemetry: { title: "Mine sends", items: ["y"] } });
  const [third] = pluginTelemetryDisclosures(store(added));
  assert.equal(third.official, false);
  assert.match(PLUGIN_SENT_COPY.attribution("Mine", false), /Provided by the Mine plugin.*doesn't control it/);
  assert.equal(pluginTelemetryDisclosures(store(listing({ manifest: 2, name: "quiet", title: "Quiet" }))).length, 0);
});

test("an old standalone install keeps the command line's disclosure even with the plugin not installed", () => {
  const empty = { order: [], listings: {}, records: {} };
  assert.deepEqual(pluginTelemetryDisclosures(empty), []);
  const [legacy] = pluginTelemetryDisclosures(empty, ["cli"]);
  assert.equal(legacy.title, "The ardia command");
  assert.equal(legacy.official, true);
  assert.equal(legacy.pluginTitle, "Command Line");
  assert.deepEqual(pluginTelemetryDisclosures(empty, ["someone-else"]), [], "only a pinned plugin's disclosure is shown for an old install");
  assert.ok(PLUGIN_SENT_COPY.addedTitle && /doesn't control it/.test(PLUGIN_SENT_COPY.addedNote), "plugins you added sit under their own heading");
});
