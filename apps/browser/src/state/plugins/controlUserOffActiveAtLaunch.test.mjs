import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
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
S().hydrate({ settings: { cliControl: false }, settingsMeta: { chosen: ["cliControl"], inferred: [] } });
stub.shellNativeModules.ArdiaDocuments.writeDocument("plugins.json", JSON.stringify({ plugins: { cli: { enabled: true, approved: "a".repeat(64), values: {}, applied: {}, installed: true, controlGranted: true } }, version: 1 }));
host.links.length = 0;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin" };
host.folders = [{ name: "cli", text: CLI, status: "ok", folderId: `official-${"a".repeat(64)}`, official: true, legacyHash: "a".repeat(64) }];

test("a launch with an approved Command Line that asks for control leaves the Off you chose in Settings alone", async () => {
  assert.equal(userTurnedControlOff(), true);
  takeCliCounts();
  startPlugins();
  await settle();
  assert.ok(activeManifest(usePlugins.getState(), "cli"), "the plugin is approved and asks for control, so the launch reached the check");
  assert.equal(S().settings.cliControl, false);
  assert.equal(takeCliCounts().cli_control_restore_tries_launch, 0);
  host.linkResult = null;
});
