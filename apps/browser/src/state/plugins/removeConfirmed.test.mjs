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
const realChoose = dialogs.choose;
const natives = shellNativeModules.ArdiaPlugins;
const realRemove = natives.remove;
after(() => {
  dialogs.confirm = realConfirm;
  dialogs.choose = realChoose;
  natives.remove = realRemove;
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

const telling = () => {
  const told = [];
  dialogs.choose = async (options) => (told.push(options), { choice: 0 });
  return told;
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

test("A removal that finished has nothing to explain and counts no failure", async () => {
  await installedAndOn();
  answering(true);
  const told = telling();
  assert.equal(await removePluginAfterConfirm("example", "Example", "settings"), true);
  assert.deepEqual(told, [], "no dialog after a removal that finished");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_removals, 1);
  assert.equal(counts.plugin_removal_failures, 0);
});

test("A removal that didn't finish says why in Settings and keeps the record for removing it again", async () => {
  await installedAndOn();
  answering(true);
  const told = telling();
  const reason = "Its files are removed, but its page data couldn't be deleted (the data store is in use); removing it again finishes that.";
  natives.remove = async () => ({ ok: false, reason });
  try {
    const removed = await removePluginAfterConfirm("example", "Example", "settings");
    assert.equal(removed, false);
  } finally {
    natives.remove = realRemove;
  }
  assert.equal(told.length, 1, "the person is told, not left on a page that quietly changed");
  assert.equal(told[0].message, reason);
  assert.equal(told[0].windowId, "settings");
  assert.ok(P().records.example, "its record stays, so removing it again can finish the job");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_removals, 0);
  assert.equal(counts.plugin_removal_failures, 1, "the failure is counted, as a removal and a cancel are");
});
