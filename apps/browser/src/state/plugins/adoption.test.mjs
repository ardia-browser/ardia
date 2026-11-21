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

const CLI = JSON.stringify({ manifest: 2, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });
const AUTO = JSON.stringify({ manifest: 1, name: "auto", title: "Auto", alwaysOn: true, autoInstall: true, permissions: ["control"], programs: [{ name: "auto-tool", path: "bin/auto" }] });
const BUILT_IN = { status: "ok", folderId: "bundled", bundled: true };

const { installOfficialPlugin } = await import("./official.ts");
setConsentPeriod(true, "test-epoch");
S().hydrate({});
S().updateSettings({ cliControl: true });
host.legacyInstalled = ["cli"];
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin", adopted: true, adoption: "adopted" };
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
  assert.equal(Object.hasOwn(host.links[0], "adopt"), false, "the native side adopts from its signed registry");
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
  host.legacyInstalled = [];
});

test("an adoption is counted and settled only once its link works, and a held old-install lock is tried again", async () => {
  const { ADOPTION_RETRY, adoptLegacyInstalls } = await import("./programs.ts");
  const DELAY = ADOPTION_RETRY.delayMs;
  ADOPTION_RETRY.delayMs = 60;
  const OWN = JSON.stringify({ manifest: 2, name: "own", title: "Own", alwaysOn: true, official: true, contributes: { programs: [{ name: "own-tool", path: "bin/own", claim: true }] } });
  host.folders = [{ name: "own", text: OWN, ...BUILT_IN }];
  host.legacyInstalled = ["own"];
  host.links.length = 0;
  host.linkResult = { ok: true, linked: ["own-tool"], refused: {}, binDir: "/home/.local/bin", adopted: false, adoptBusy: true, adoption: "busy" };
  await lifecycle.rescanPlugins();
  takePluginCounts();
  const { resetAdoptionForTests } = await import("./programs.ts");
  resetAdoptionForTests();
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  assert.equal(await adoptLegacyInstalls(consentToken()), true);
  lifecycle.reconcilePlugins(consentToken());
  await settle();
  assert.equal(takePluginCounts().plugin_adoptions, 0, "not counted while the old installer holds its lock");
  const first = host.links.length;
  host.linkResult = { ok: true, linked: ["own-tool"], refused: {}, binDir: "/home/.local/bin", adopted: true, adoption: "adopted" };
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settle();
  assert.ok(host.links.length > first, "linked again after the delay");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_adoptions, 1);
  assert.equal(counts.program_adoptions, 1);
  ADOPTION_RETRY.delayMs = DELAY;
  host.linkResult = null;
  host.legacyInstalled = [];
});

test("an Install that finds the old installer busy keeps trying, then offers Try Again; a failed switch-over isn't counted as adopted", async () => {
  const { ADOPTION_RETRY, canRelink, relinkPrograms } = await import("./programs.ts");
  const { DELAY, TRIES } = { DELAY: ADOPTION_RETRY.delayMs, TRIES: ADOPTION_RETRY.tries };
  ADOPTION_RETRY.delayMs = 5;
  ADOPTION_RETRY.tries = 2;
  const MINE = JSON.stringify({ manifest: 2, name: "mine", title: "Mine", alwaysOn: true, official: true, contributes: { programs: [{ name: "mine-tool", path: "bin/mine", claim: true }] } });
  host.folders = [{ name: "mine", text: MINE, ...BUILT_IN }];
  host.legacyInstalled = [];
  await lifecycle.rescanPlugins();
  host.links.length = 0;
  host.linkResult = { ok: true, linked: ["mine-tool"], refused: {}, binDir: "/home/.local/bin", adopted: false, adoptBusy: true, adoption: "busy" };
  const done = installOfficialPlugin("mine", { showSheet: false });
  assert.ok(lifecycle.enablePlugin("mine", P().consent.hash));
  const outcome = await done;
  assert.equal(host.links.length, 3, "the first link and two retries");
  assert.deepEqual(outcome, { ok: false, reason: "Installed, but the old install is busy updating. Try again in a moment." });
  assert.equal(P().programs.mine.adoption, "busy");
  assert.ok(canRelink(P().programs.mine), "Try Again is offered");
  takePluginCounts();
  host.linkResult = { ok: true, linked: ["mine-tool"], refused: {}, binDir: "/home/.local/bin", adopted: false, adoption: "failed" };
  relinkPrograms("mine");
  await settle();
  assert.equal(P().programs.mine.adoption, "failed", "a swap that didn't take is told apart from one already done");
  assert.equal(takePluginCounts().program_adoptions, 0);
  host.linkResult = { ok: true, linked: ["mine-tool"], refused: {}, binDir: "/home/.local/bin", adopted: false, adoption: "already" };
  relinkPrograms("mine");
  await settle();
  assert.equal(P().programs.mine.adoption, undefined);
  assert.equal(canRelink(P().programs.mine), false);
  ADOPTION_RETRY.delayMs = DELAY;
  ADOPTION_RETRY.tries = TRIES;
  host.linkResult = null;
});

test("a program registry Ardia can't read fails closed and says so", async () => {
  const { claimsOf, loadProgramClaims, useProgramRegistry } = await import("./programRegistry.ts");
  assert.deepEqual(claimsOf(null), { claims: {}, failClosed: true });
  assert.deepEqual(claimsOf({ claims: { ardia: "cli" }, failClosed: false, legacyOwners: [] }), { claims: { ardia: "cli" }, failClosed: false });
  assert.equal(claimsOf({ claims: { ardia: "cli" }, failClosed: false }).failClosed, true, "legacyOwners is part of the native contract, so leaving it out is malformed");
  const native = stub.shellNativeModules.ArdiaPlugins;
  const registry = native.programRegistry;
  native.programRegistry = async () => {
    throw new Error("no registry");
  };
  try {
    assert.deepEqual(await loadProgramClaims(), { claims: {}, failClosed: true });
    assert.equal(useProgramRegistry.getState().failClosed, true, "Settings › Advanced shows the registry problem");
  } finally {
    native.programRegistry = registry;
  }
  assert.equal((await loadProgramClaims()).failClosed, false);
  assert.equal(useProgramRegistry.getState().failClosed, false);
});

test("a missing native method, a malformed answer or failClosed blocks every JS link, as native does", async () => {
  const { claimsOf, loadProgramClaims } = await import("./programRegistry.ts");
  const { relinkOwnPrograms } = await import("./programs.ts");
  for (const bad of [{ claims: { ardia: 3 }, failClosed: false }, { claims: {}, failClosed: "no" }, { claims: { "Bad Name": "cli" }, failClosed: false }, { claims: {}, failClosed: false, legacyOwners: "cli" }, []])
    assert.equal(claimsOf(bad).failClosed, true, JSON.stringify(bad));
  const native = stub.shellNativeModules.ArdiaPlugins;
  const registry = native.programRegistry;
  const MINE = JSON.stringify({ manifest: 2, name: "blocked", title: "Blocked", alwaysOn: true, autoInstall: true, official: true, contributes: { programs: [{ name: "blocked-tool", path: "bin/b" }] } });
  host.folders = [{ name: "blocked", text: MINE, ...BUILT_IN }];
  host.linkResult = null;
  try {
    for (const broken of [undefined, () => ({ claims: [], failClosed: false }), () => ({ claims: {}, failClosed: true })]) {
      native.programRegistry = broken;
      assert.equal((await loadProgramClaims()).failClosed, true);
      host.links.length = 0;
      await lifecycle.rescanPlugins();
      relinkOwnPrograms("blocked");
      await settle();
      assert.deepEqual(host.links, [], "no link reaches native");
      assert.equal(P().programs.blocked?.state, "failed");
      assert.match(P().programs.blocked.reason, /missing or damaged/);
    }
  } finally {
    native.programRegistry = registry;
  }
  await lifecycle.rescanPlugins();
  relinkOwnPrograms("blocked");
  await settle();
  assert.equal(P().programs.blocked.state, "linked", "a readable registry links again");
});

test("a standalone command line installed mid-session gets its What's Sent disclosure when the sheet opens", async () => {
  const { refreshLegacyInstalls, useLegacyInstalls } = await import("./programRegistry.ts");
  const { pluginTelemetryDisclosures } = await import("./disclosures.ts");
  host.legacyInstalled = [];
  await refreshLegacyInstalls();
  const empty = { order: [], listings: {}, records: {} };
  assert.deepEqual(pluginTelemetryDisclosures(empty, useLegacyInstalls.getState().owners), []);
  host.legacyInstalled = ["cli"];
  assert.deepEqual(await refreshLegacyInstalls(), ["cli"], "asked again, not the once-a-launch adoption answer");
  assert.equal(pluginTelemetryDisclosures(empty, useLegacyInstalls.getState().owners)[0]?.title, "The ardia command");
  const { readFileSync } = await import("node:fs");
  const sheet = readFileSync(new URL("../../components/settings/panes/ShareDiagnostics.tsx", import.meta.url), "utf8");
  assert.match(sheet, /export function WhatsSentSheet\(\) \{\n  useEffect\(\(\) => void refreshLegacyInstalls\(\), \[\]\);/);
  host.legacyInstalled = [];
  await refreshLegacyInstalls();
});
