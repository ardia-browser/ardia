import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { officialPlugins, installOfficialPlugin } = await import("./official.ts");
const { ADOPT_WITH_CONTROL_OFF } = await import("./programs.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const CLI = JSON.stringify({ manifest: 2, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });
const BUILT_IN = { status: "ok", folderId: "bundled", bundled: true };

setConsentPeriod(true, "test-epoch");
S().hydrate({});
S().updateSettings({ cliControl: false });
host.legacyInstalled = ["cli"];
host.links.length = 0;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin", adopted: true };
host.folders = [{ name: "cli", text: CLI, ...BUILT_IN }];
startPlugins();
await settle();

test("an old install whose control was off isn't adopted: the plugin is offered, control stays off, its command is left alone", () => {
  assert.equal(ADOPT_WITH_CONTROL_OFF, false, "the owner hasn't chosen to turn control on for them");
  assert.equal(P().records.cli, undefined);
  assert.equal(activeManifest(P(), "cli"), null);
  assert.equal(officialPlugins(P(), true, () => false)[0].state, "available");
  assert.deepEqual(host.links, [], "nothing takes over the old link");
  assert.equal(S().settings.cliControl, false);
  assert.equal(takePluginCounts().plugin_adoptions_waiting, 1);
});

test("Install on the sheet installs it but keeps the Off you chose, and the sheet says how to turn control on", async () => {
  const { consentLines, CONTROL_OFF_LINE } = await import("./consent.ts");
  assert.ok(consentLines(P().listings.cli.manifest, { controlOff: true }).some((line) => line.text === CONTROL_OFF_LINE));
  assert.ok(!consentLines(P().listings.cli.manifest, { controlOff: false }).some((line) => line.text === CONTROL_OFF_LINE));
  const done = installOfficialPlugin("cli", { showSheet: false });
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  assert.deepEqual(await done, { ok: true });
  assert.equal(host.links.at(-1).name, "cli");
  assert.equal(S().settings.cliControl, false, "an explicit Off wins over installing a plugin that asks for control");
  host.linkResult = null;
  host.legacyInstalled = [];
});
