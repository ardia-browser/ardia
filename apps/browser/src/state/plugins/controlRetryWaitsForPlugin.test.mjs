import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const lifecycle = await import("./lifecycle.ts");
const { activeManifest, usePlugins } = await import("./store.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");

const S = () => useBrowser.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const CLI = JSON.stringify({ manifest: 2, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });
const OTHER = JSON.stringify({ manifest: 2, name: "notes", title: "Notes", version: "1.0.0", permissions: {} });

setConsentPeriod(true, "test-epoch");
S().hydrate({ settings: { cliControl: false }, settingsMeta: { chosen: ["cliControl"], inferred: ["cliControl"] } });
stub.shellNativeModules.ArdiaDocuments.writeDocument(
  "plugins.json",
  JSON.stringify({ plugins: { cli: { enabled: true, approved: "a".repeat(64), values: {}, applied: {}, installed: true, controlGranted: true } }, version: 1 }),
);
host.links.length = 0;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin" };
host.folders = [{ name: "notes", text: OTHER, status: "ok", folderId: "notes" }];

test("the launch retry waits until Command Line is active instead of spending its one try before the plugin loads", async () => {
  takeCliCounts();
  startPlugins();
  await settle();
  assert.ok(!activeManifest(usePlugins.getState(), "cli"), "Command Line isn't listed yet on the first pass");
  assert.equal(S().settings.cliControl, false);
  host.folders = [...host.folders, { name: "cli", text: CLI, status: "ok", folderId: `official-${"a".repeat(64)}`, official: true, legacyHash: "a".repeat(64) }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(activeManifest(usePlugins.getState(), "cli"), "Command Line is active now");
  assert.equal(S().settings.cliControl, true, "control comes back once Command Line is active");
  assert.equal(takeCliCounts().cli_control_restore_tries_launch, 1);
  host.linkResult = null;
});
