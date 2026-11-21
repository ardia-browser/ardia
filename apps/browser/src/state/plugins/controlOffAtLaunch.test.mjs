import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const lifecycle = await import("./lifecycle.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const CLI = JSON.stringify({ manifest: 2, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });

setConsentPeriod(true, "test-epoch");
S().hydrate({});
S().updateSettings({ cliControl: false });
stub.shellNativeModules.ArdiaDocuments.writeDocument("plugins.json", JSON.stringify({ plugins: { cli: { enabled: true, approved: "a".repeat(64), values: {}, applied: {}, installed: true, controlGranted: true } }, version: 1 }));
host.links.length = 0;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin" };
host.folders = [{ name: "cli", text: CLI, status: "ok", folderId: "bundled", bundled: true }];
startPlugins();
await settle();

test("a launch with an installed built-in that asks for control leaves an Off you chose alone", async () => {
  assert.equal(S().settings.cliControl, false);
  lifecycle.reconcilePlugins();
  await settle();
  assert.equal(S().settings.cliControl, false);
  host.linkResult = null;
});
