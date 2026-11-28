import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const lifecycle = await import("./lifecycle.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { userTurnedControlOff } = await import("../app/programControlSetting.ts");

const S = () => useBrowser.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const CLI = JSON.stringify({ manifest: 2, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });

setConsentPeriod(true, "test-epoch");
S().hydrate({ settings: { cliControl: false }, settingsMeta: { chosen: ["cliControl"], inferred: ["cliControl"] } });
stub.shellNativeModules.ArdiaDocuments.writeDocument("plugins.json", JSON.stringify({ plugins: { cli: { enabled: true, approved: "a".repeat(64), values: {}, applied: {}, installed: true, controlGranted: true } }, version: 1 }));
host.links.length = 0;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin" };
host.folders = [{ name: "cli", text: CLI, status: "ok", folderId: `official-${"a".repeat(64)}`, official: true, legacyHash: "a".repeat(64) }];

test("a launch after the engine stopped control itself turns control on again for an installed Command Line", async () => {
  assert.equal(S().settings.cliControl, false);
  assert.equal(userTurnedControlOff(), false, "the saved Off was the app's own, not the person's");
  takeCliCounts();
  startPlugins();
  await settle();
  assert.equal(S().settings.cliControl, true, "the relaunch must ask the engine for control again");
  assert.equal(S().settingsMeta.inferred.includes("cliControl"), true, "the app turned it back on, the person didn't");
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_control_restore_tries_launch, counts.cli_control_restore_tries_approval, counts.cli_control_restored], [1, 0, 0], "a try, and no claim yet that the engine came back");
});

test("later reconciles in the same session don't turn control on again after it stops itself once more", async () => {
  S().updateSettings({ cliControl: false }, { inferred: true });
  lifecycle.reconcilePlugins();
  await settle();
  assert.equal(S().settings.cliControl, false, "one retry per launch, so a failing start can't loop");
  host.linkResult = null;
});
