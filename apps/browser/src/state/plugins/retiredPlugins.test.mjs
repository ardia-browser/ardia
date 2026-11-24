import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const retired = await import("./retiredOfficial.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");

const FIXTURE = readFileSync(new URL("../../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8");
const P = () => usePlugins.getState();

test("a plugin named like an object property is approved and removed like any other", async () => {
  useBrowser.getState().hydrate({});
  startPlugins();
  const text = FIXTURE.replace('"example"', '"constructor"');
  stub.pluginHost.folders = [{ name: "constructor", status: "ok", text, folderId: "5:5" }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("constructor"));
  assert.ok(lifecycle.enablePlugin("constructor", P().consent.hash));
  assert.equal(P().records.constructor.enabled, true);
  assert.equal(retired.isBundledRetiredRecord("constructor", P().records.constructor), false);
  const removed = await lifecycle.removePlugin("constructor");
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(Object.hasOwn(P().records, "constructor"), false);
});
