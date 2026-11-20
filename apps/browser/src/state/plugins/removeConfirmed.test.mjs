import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { removePluginAfterConfirm } = await import("./removeConfirmed.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-remove-confirmed-test");

const FIXTURE = readFileSync(new URL("../../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8");
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const dialogs = shellNativeModules.ArdiaDialogs;
const realConfirm = dialogs.confirm;
after(() => {
  dialogs.confirm = realConfirm;
  lifecycle.disablePlugin("example");
});

async function installedAndOn() {
  useBrowser.getState().hydrate({});
  startPlugins();
  host.removed.length = 0;
  host.folders = [{ name: "example", status: "ok", text: FIXTURE }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("example"));
  assert.ok(lifecycle.enablePlugin("example", P().consent.hash));
  lifecycle.dismissPluginConsent();
  takePluginCounts();
}

const answering = (confirmed) => {
  const asked = [];
  dialogs.confirm = async (options) => (asked.push(options), { confirmed, suppressed: false });
  return asked;
};

test("Cancel in the Remove dialog keeps the plugin, its files and its record", async () => {
  await installedAndOn();
  const asked = answering(false);
  const removed = await removePluginAfterConfirm("example", "Example", "settings");
  assert.equal(removed, false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].confirmTitle, "Remove");
  assert.deepEqual(host.removed, [], "its files are still there");
  assert.ok(P().records.example, "its record is still there");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_removals_cancelled, 1);
  assert.equal(counts.plugin_removals, 0);
});

test("Remove in the dialog removes the plugin", async () => {
  await installedAndOn();
  answering(true);
  const removed = await removePluginAfterConfirm("example", "Example", "settings");
  assert.equal(removed, true);
  assert.deepEqual(host.removed, ["example"]);
  const counts = takePluginCounts();
  assert.equal(counts.plugin_removals, 1);
  assert.equal(counts.plugin_removals_cancelled, 0);
});
