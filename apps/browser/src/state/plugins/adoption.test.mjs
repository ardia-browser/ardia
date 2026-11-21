import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { officialPlugins } = await import("./official.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const CLI = JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia" }] });
const AUTO = JSON.stringify({ manifest: 1, name: "auto", title: "Auto", alwaysOn: true, autoInstall: true, permissions: ["control"], programs: [{ name: "auto-tool", path: "bin/auto" }] });
const BUILT_IN = { status: "ok", folderId: "bundled", bundled: true };

const { installOfficialPlugin } = await import("./official.ts");
setConsentPeriod(true, "test-epoch");
S().hydrate({});
S().updateSettings({ cliControl: true });
host.legacyInstalled = true;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin", adopted: true };
host.folders = [{ name: "cli", text: CLI, ...BUILT_IN }];
const native = stub.shellNativeModules.ArdiaPlugins;
const legacyProgramsInstalled = native.legacyProgramsInstalled;
let release;
const gate = new Promise((resolve) => (release = resolve));
native.legacyProgramsInstalled = () => gate.then(legacyProgramsInstalled);
startPlugins();
await settle();
const asked = installOfficialPlugin("cli", { showSheet: false });
const sheetBefore = P().consent?.name;
release();
await settle();
const answered = await asked;
native.legacyProgramsInstalled = legacyProgramsInstalled;

test("an Install sheet open while the old install is found closes, and its promise says ok", () => {
  assert.equal(sheetBefore, "cli");
  assert.deepEqual(answered, { ok: true });
  assert.equal(P().consent, null);
});

test("an ardia installed the old way is adopted silently on update: installed, linked once, no sheet, control untouched", () => {
  assert.equal(P().consent, null);
  assert.equal(P().records.cli.installed, true);
  assert.equal(P().records.cli.enabled, true);
  assert.equal(P().records.cli.approved, P().listings.cli.hash);
  assert.ok(activeManifest(P(), "cli"));
  assert.equal(host.links.length, 1);
  assert.equal(host.links[0].adopt, true);
  assert.equal(P().programs.cli.state, "linked");
  assert.equal(S().settings.cliControl, true, "control was on, so it stays on");
  assert.equal(officialPlugins(P(), true, () => false)[0].state, "installed");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_adoptions, 1);
  assert.equal(counts.program_adoptions, 1);
  assert.equal(lifecycle.disablePlugin("cli", null), false);
});

test("adoption is checked once per launch: a later scan doesn't ask again", async () => {
  host.links.length = 0;
  await lifecycle.rescanPlugins();
  await settle();
  assert.equal(host.links.length, 0);
});

test("a built-in marked autoInstall links at its first scan with no click and grants control once, unless you turned control off", async () => {
  host.linkResult = { ok: true, linked: ["auto-tool"], refused: {}, binDir: "/home/.local/bin" };
  S().updateSettings({ cliControl: false });
  host.folders = [{ name: "auto", text: AUTO, ...BUILT_IN }, { name: "cli", text: CLI, ...BUILT_IN }];
  await lifecycle.rescanPlugins();
  await settle();
  assert.equal(P().consent, null);
  assert.equal(P().programs.auto.state, "linked");
  assert.equal(P().records.auto.controlGranted, true);
  assert.equal(S().settings.cliControl, false, "a choice made before it first linked is kept");
  assert.equal(lifecycle.requestPluginConsent("auto"), false);
  assert.equal(lifecycle.disablePlugin("auto", null), false);
});

test("an autoInstall grant that didn't stick (the setting was lost, never chosen) is applied again on Try Again", async () => {
  useBrowser.setState((s) => ({ settings: { ...s.settings, cliControl: false }, settingsMeta: { chosen: s.settingsMeta.chosen.filter((k) => k !== "cliControl"), inferred: s.settingsMeta.inferred } }));
  usePlugins.setState((s) => ({ programs: { ...s.programs, auto: { state: "failed", hash: s.listings.auto.hash, reason: "busy" } } }));
  const { relinkPrograms } = await import("./programs.ts");
  relinkPrograms("auto");
  await settle();
  assert.equal(S().settings.cliControl, true);
  host.linkResult = null;
  host.legacyInstalled = false;
});
