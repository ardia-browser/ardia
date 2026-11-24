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
const { officialPinnedFromPin } = await import("../../test-native/shell.ts");
const BUILT_IN = { status: "ok", folderId: officialPinnedFromPin().find((p) => p.name === "cli").folderId, official: true };

const { installOfficialPlugin } = await import("./official.ts");
setConsentPeriod(true, "test-epoch");
S().hydrate({});
S().updateSettings({ cliControl: true });
host.legacyInstalled = ["cli"];
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin", adopted: true, adoption: "adopted" };
host.folders = [{ name: "cli", text: CLI, ...BUILT_IN }];
startPlugins();
await settle();

test("an ardia installed the old way is found but never approved by itself: nothing is written or linked, Install stays offered, and it counts as waiting", () => {
  assert.equal(P().consent, null);
  assert.equal(P().records.cli, undefined);
  assert.equal(activeManifest(P(), "cli"), null);
  assert.deepEqual(host.links, []);
  assert.equal(officialPlugins(P(), true, () => false)[0].state, "available");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_adoptions_waiting, 1);
  assert.equal(counts.plugin_adoptions, 0);
});

test("adoption is checked once per launch: a later scan doesn't count it again", async () => {
  await lifecycle.rescanPlugins();
  await settle();
  assert.equal(takePluginCounts().plugin_adoptions_waiting, 0);
  assert.equal(host.links.length, 0);
});

test("once you confirm Install, its link takes over the old home natively and that is counted", async () => {
  const done = installOfficialPlugin("cli", { showSheet: false });
  assert.equal(P().consent?.name, "cli");
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  assert.deepEqual(await done, { ok: true });
  assert.equal(host.links.length, 1);
  assert.equal(Object.hasOwn(host.links[0], "adopt"), false, "the native side adopts from its signed registry");
  assert.equal(P().programs.cli.state, "linked");
  assert.equal(takePluginCounts().program_adoptions, 1);
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
  await lifecycle.rescanPlugins();
  assert.ok(lifecycle.requestPluginConsent("blocked"));
  assert.ok(lifecycle.enablePlugin("blocked", P().consent.hash));
  await settle();
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
