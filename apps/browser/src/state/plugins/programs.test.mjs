import assert from "node:assert/strict";
import { test } from "node:test";
import { v3Text } from "./fixtures/manifests.mjs";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { updateLock } = await import("./lockfile.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { consentLines } = await import("./consent.ts");
const { relinkOwnPrograms, programsStatus } = await import("./programs.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

const AFTER = [["skills", "install", "--auto"], ["skills", "refresh"]];
const CLI_DOC = { name: "cli", title: "Command Line", version: "0.8.0", icon: "terminal.fill", permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER, example: "ardia tabs", claim: true }] } };
const CLI = v3Text(CLI_DOC, "ardia");
const OTHER = v3Text({ name: "other", title: "Other", programs: [{ name: "other-tool", path: "bin/other" }] });
const SHA = "c".repeat(64);
const CLI_FOLDER = { name: "ardia__cli", status: "ok", source: "store", folderId: `store-${SHA}`, text: CLI };
const OTHER_FOLDER = { name: "other", status: "ok", text: OTHER, folderId: "1:2" };
const officialLock = (official = true) =>
  updateLock(() => ({ "@ardia/cli": { id: "@ardia/cli", key: "ardia__cli", version: "0.8.0", channel: "latest", source: { kind: "registry", url: "https://ardia.dev/r" }, sha256: SHA, payloadDigest: null, dependencies: [], officialSig: "A".repeat(86), platform: "universal", root: true, official, installedAt: 1 } }), null);

function reset() {
  host.links.length = 0;
  host.unlinks.length = 0;
  host.sweeps.length = 0;
  host.removed.length = 0;
  host.linkResult = null;
}

async function scan(folders) {
  host.folders = folders;
  await lifecycle.rescanPlugins();
  await settle();
}

async function turnOn(name) {
  assert.ok(lifecycle.requestPluginConsent(name), name);
  assert.ok(lifecycle.enablePlugin(name, P().consent.hash));
  await settle();
}

setConsentPeriod(true, "test-epoch");
S().hydrate({});
await officialLock();
host.folders = [CLI_FOLDER, OTHER_FOLDER];
host.afterUpdateQuitStops = { consent: "test-epoch", exitedOnTerm: 2, killed: 1 };
startPlugins();
await settle();
await lifecycle.rescanPlugins();
await settle();
const launch = { sweeps: host.sweeps.map((s) => [...s]), counts: takePluginCounts() };

test("afterUpdate commands stopped at the last quit are counted once at launch, exits on TERM apart from kills", () => {
  assert.equal(launch.counts.program_after_update_quit_exits, 2);
  assert.equal(launch.counts.program_after_update_quit_kills, 1);
  assert.equal(host.afterUpdateQuitStops, null);
  assert.equal(host.afterUpdateQuitConsent, "test-epoch");
});

test("nothing is on PATH until a plugin is turned on, and the launch sweep keeps only what's on", () => {
  assert.equal(activeManifest(P(), "ardia__cli"), null);
  assert.deepEqual(launch.sweeps.at(-1), []);
  assert.equal(P().listings.ardia__cli.official, true, "Ardia's verified store copy of @ardia/cli is official");
});

test("the official command line links ardia with its after-update steps and grants control at Turn On", async () => {
  reset();
  await turnOn("ardia__cli");
  const link = host.links.at(-1);
  assert.equal(link.name, "ardia__cli");
  assert.equal(link.official, undefined, "native decides official trust from the store's recorded proof, never from a flag");
  assert.deepEqual(link.programs, [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER }]);
  assert.equal(S().settings.cliControl, true);
  assert.deepEqual(programsStatus("ardia__cli"), { state: "linked", linked: ["ardia"], failed: [], binDir: "/home/.local/bin" });
  assert.equal(takePluginCounts().program_links, 1);
});

test("turning it off unlinks, and back on relinks with no new consent", async () => {
  reset();
  assert.ok(await lifecycle.turnOffPlugin("ardia__cli", null));
  await settle();
  assert.deepEqual(host.unlinks.at(-1), { name: "ardia__cli", programs: ["ardia"], remove: false });
  assert.ok(lifecycle.turnOnApprovedPlugin("ardia__cli"));
  await settle();
  assert.equal(host.links.at(-1).name, "ardia__cli");
});

test("a copy that isn't Ardia's verified download can't take ardia or run after-update steps", async () => {
  await officialLock(false);
  await scan([CLI_FOLDER, OTHER_FOLDER]);
  assert.equal(P().listings.ardia__cli.official, undefined);
  const local = v3Text({ name: "cli2", title: "Mine", contributes: { programs: [{ name: "ardia", path: "bin/ardia" }] } }, "alice");
  const after = v3Text({ name: "after", title: "After", contributes: { programs: [{ name: "after-tool", path: "bin/a", afterUpdate: [["x"]] }] } });
  const dev = { name: "ardia__cli", status: "ok", source: "dev", text: CLI, folderId: "dev-1", devPath: "/work/cli" };
  await scan([dev, { name: "cli2", status: "ok", text: local, folderId: "3:3" }, { name: "after", status: "ok", text: after, folderId: "4:4" }]);
  assert.ok(P().listings.cli2.problems.some((p) => p.includes("ardia belongs to Ardia's official @ardia/cli plugin")));
  assert.ok(P().listings.after.problems.some((p) => p.includes("afterUpdate is only for Ardia's official plugins")));
  assert.ok(P().listings.ardia__cli.problems.some((p) => p.includes("ardia belongs to")), "a dev link of @ardia/cli is not the verified download");
  await officialLock();
  await scan([CLI_FOLDER, OTHER_FOLDER]);
});

test("any other plugin's programs follow consent: on links without after-update steps, off unlinks", async () => {
  reset();
  await turnOn("other");
  assert.deepEqual(host.links.at(-1), { name: "other", folderId: "1:2", approved: P().records.other.approved, version: "1.0.0", programs: [{ name: "other-tool", path: "bin/other" }] });
  lifecycle.disablePlugin("other");
  await settle();
  assert.deepEqual(host.unlinks.at(-1), { name: "other", programs: ["other-tool"], remove: false });
});

test("a refused name shows with Try Again, and relinking asks again", async () => {
  reset();
  host.linkResult = { ok: true, linked: [], refused: { "other-tool": "other-tool is someone else's" }, binDir: "/home/.local/bin", adopted: false };
  await turnOn("other");
  assert.deepEqual(programsStatus("other").failed, [{ name: "other-tool", reason: "other-tool is someone else's" }]);
  host.linkResult = null;
  assert.deepEqual(relinkOwnPrograms("other"), { ok: true });
  await settle();
  assert.equal(programsStatus("other").state, "linked");
  lifecycle.disablePlugin("other");
  await settle();
});

test("a plugin you added has its programs removed with it", async () => {
  reset();
  await turnOn("other");
  const removed = await lifecycle.removePlugin("other");
  assert.equal(removed.ok, true);
  assert.deepEqual(host.unlinks.at(-1), { name: "other", programs: ["other-tool"], remove: true });
  assert.deepEqual(host.removed.at(-1), "other");
  await scan([CLI_FOLDER, OTHER_FOLDER]);
});

test("what the command line gets, as Settings shows it, says it can fully control Ardia", () => {
  const lines = consentLines(P().listings.ardia__cli.manifest).map((l) => l.text).join("\n");
  assert.match(lines, /fully control Ardia/);
  assert.match(lines, /ardia/);
});
