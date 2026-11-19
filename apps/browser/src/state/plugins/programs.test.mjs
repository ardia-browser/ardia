import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { consentLines } = await import("./consent.ts");
const { readManifest } = await import("../../lib/pluginManifest.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

const AFTER = [["skills", "install", "--auto"], ["skills", "refresh"]];
const CLI = JSON.stringify({
  manifest: 1,
  name: "cli",
  title: "Command Line",
  version: "0.3.0",
  alwaysOn: true,
  official: true,
  icon: "terminal.fill",
  permissions: ["control"],
  programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER }],
});
const OTHER = JSON.stringify({ manifest: 1, name: "other", title: "Other", programs: [{ name: "other-tool", path: "bin/other" }] });
const BUILT_IN = { status: "ok", folderId: "bundled", bundled: true };

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
  assert.ok(lifecycle.requestPluginConsent(name));
  assert.ok(lifecycle.enablePlugin(name, P().consent.hash));
  await settle();
}

const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { officialPlugins, installOfficialPlugin } = await import("./official.ts");
const { pluginSocketMethod } = await import("./socketMethods.ts");
setConsentPeriod(true, "test-epoch");
S().hydrate({});
host.folders = [{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }];
startPlugins();
(await import("./consentSurface.ts")).presentSettingsConsent();
await settle();
const launch = { sweeps: host.sweeps.map((s) => [...s]), links: host.links.map((l) => ({ ...l })) };
const hidden = () => false;

test("a profile that never installed the command line has it offered and nothing on PATH", () => {
  assert.equal(P().consent, null);
  assert.equal(activeManifest(P(), "cli"), null);
  assert.equal(P().records.cli, undefined);
  assert.deepEqual(launch.links, []);
  assert.deepEqual(launch.sweeps, [[]], "at launch every command of a plugin that isn't installed comes off PATH");
  assert.equal(S().settings.cliControl, false);
  assert.deepEqual(officialPlugins(P(), true, hidden), [
    { name: "cli", title: "Command Line", blurb: "Drive Ardia from your terminal or an agent.", icon: "terminal.fill", version: "0.3.0", state: "available" },
  ]);
  assert.deepEqual(pluginSocketMethod("plugins.official", {}), { result: officialPlugins(P()) });
});

test("the seam: unsupported where plugins aren't, coming soon only behind its flag, and only built-ins can claim official", async () => {
  assert.deepEqual(
    officialPlugins(P(), false, hidden).map((p) => p.state),
    ["unsupported"],
  );
  const shown = officialPlugins(P(), true, (flag) => flag === "officialPluginsAi");
  assert.deepEqual(shown.at(-1), { name: "ai", title: "AI", blurb: shown.at(-1).blurb, icon: "sparkles", version: null, state: "comingSoon" });
  assert.equal(officialPlugins(P(), false, () => true).at(-1).state, "unsupported");
  assert.deepEqual(await installOfficialPlugin("other", { showSheet: false }), { ok: false, reason: "Not an official plugin." });
  assert.deepEqual(await installOfficialPlugin("ai", { showSheet: false }), { ok: false, reason: "Not an official plugin." });
  const fake = JSON.stringify({ manifest: 1, name: "fake", title: "Fake", official: true, autoInstall: true, alwaysOn: true });
  await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "fake", status: "ok", text: fake, folderId: "4:4" }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }]);
  assert.deepEqual(P().listings.fake.problems, [
    "plugin.json: alwaysOn is only for plugins built into Ardia",
    "plugin.json: official is only for plugins built into Ardia",
    "plugin.json: autoInstall is only for plugins built into Ardia",
  ]);
  assert.deepEqual(officialPlugins(P(), true, hidden).map((p) => p.name), ["cli"]);
  await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }]);
});

test("cancelling the sheet installs nothing and says so; while a sheet is up, a second ask or another plugin's is refused and the first keeps its sheet", async () => {
  reset();
  const first = installOfficialPlugin("cli", { showSheet: false });
  const asked = P().consent;
  assert.equal(asked.name, "cli");
  assert.deepEqual(await installOfficialPlugin("cli", { showSheet: false }), { ok: false, reason: lifecycle.ALREADY_ASKING });
  assert.equal(lifecycle.requestPluginConsent("other"), false);
  assert.deepEqual(P().consent, asked, "the open sheet stays exactly as it was");
  lifecycle.dismissPluginConsent("cli");
  assert.deepEqual(await first, { ok: false, reason: "Cancelled.", cancelled: true }, "the first requester's waiter was kept");
  const third = installOfficialPlugin("cli", { showSheet: false });
  lifecycle.dismissPluginConsent();
  assert.deepEqual(await third, { ok: false, reason: "Cancelled.", cancelled: true });
  await settle();
  assert.deepEqual(host.links, []);
  assert.equal(officialPlugins(P(), true, hidden)[0].state, "available");
});

test("an install whose plugins.json can't be written tells the caller instead of waiting forever", async () => {
  reset();
  const done = installOfficialPlugin("cli", { showSheet: false });
  stub.refusedWrites.on = true;
  try {
    assert.equal(lifecycle.enablePlugin("cli", P().listings.cli.hash), false);
  } finally {
    stub.refusedWrites.on = false;
  }
  assert.deepEqual(await done, { ok: false, reason: "plugins.json couldn't be saved. Try again." });
  assert.equal(P().consent, null, "a settled install leaves no sheet behind");
  assert.equal(P().unsaved, "cli");
  const again = installOfficialPlugin("cli", { showSheet: false });
  assert.equal(P().consent.name, "cli", "asking again is accepted");
  assert.equal(P().unsaved, null);
  lifecycle.dismissPluginConsent();
  assert.deepEqual(await again, { ok: false, reason: "Cancelled.", cancelled: true });
  await settle();
  assert.deepEqual(host.links, []);
});

test("a link that fails is reported to the caller; asking again links it and says ok", async () => {
  const TOOL = JSON.stringify({ manifest: 1, name: "tool", title: "Tool", alwaysOn: true, official: true, programs: [{ name: "tool-x", path: "bin/x" }] });
  await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }, { name: "tool", text: TOOL, ...BUILT_IN }]);
  reset();
  host.linkResult = { ok: false, reason: "busy" };
  const done = installOfficialPlugin("tool", { showSheet: false });
  assert.ok(lifecycle.enablePlugin("tool", P().consent.hash));
  assert.deepEqual(await done, { ok: false, reason: "Installed, but not on your PATH: busy" }, "a real failure isn't cancelled");
  host.linkResult = null;
  assert.deepEqual(await installOfficialPlugin("tool", { showSheet: false }), { ok: true });
  assert.deepEqual(P().programs.tool.linked, ["tool-x"]);
  await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }]);
  reset();
});

test("a plugin that goes away while it links doesn't report success", async () => {
  const TOOL = JSON.stringify({ manifest: 1, name: "gadget", title: "Gadget", alwaysOn: true, official: true, programs: [{ name: "gadget-x", path: "bin/x" }] });
  await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }, { name: "gadget", text: TOOL, ...BUILT_IN }]);
  reset();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const linkPrograms = stub.shellNativeModules.ArdiaPlugins.linkPrograms;
  stub.shellNativeModules.ArdiaPlugins.linkPrograms = async (spec) => (await gate, linkPrograms(spec));
  try {
    const done = installOfficialPlugin("gadget", { showSheet: false });
    assert.ok(lifecycle.enablePlugin("gadget", P().consent.hash));
    await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }]);
    release();
    const result = await done;
    assert.equal(result.ok, false);
    assert.match(result.reason, /changed while installing/);
  } finally {
    stub.shellNativeModules.ArdiaPlugins.linkPrograms = linkPrograms;
  }
  reset();
});

test("closing the Settings sheet's owner settles its install and frees the slot for the next ask", async () => {
  const done = installOfficialPlugin("cli", { showSheet: false });
  assert.equal(lifecycle.requestPluginConsent("other"), false, "another plugin waits its turn");
  assert.equal(lifecycle.dismissPluginConsent("other"), false, "and can't close a sheet that isn't its own");
  assert.equal(lifecycle.dismissPluginConsent("cli"), true);
  assert.deepEqual(await done, { ok: false, reason: "Cancelled.", cancelled: true });
  assert.ok(lifecycle.requestPluginConsent("other"), "the next ask is accepted");
  assert.equal(lifecycle.dismissPluginConsent("other"), true);
  assert.equal(lifecycle.dismissPluginConsent("cli"), true, "with no sheet open, Cancel just closes");
});

test("only a closed sheet counts as cancelled: Cancel and a closed Settings window say so, a failure or a refusal doesn't", async () => {
  const closed = installOfficialPlugin("cli", { showSheet: false });
  lifecycle.dismissPluginConsent("cli");
  assert.deepEqual(await closed, { ok: false, reason: "Cancelled.", cancelled: true }, "Cancel on the sheet");
  const settingsClosed = installOfficialPlugin("cli", { showSheet: false });
  const owned = P().consent.name;
  lifecycle.dismissPluginConsent(owned);
  assert.deepEqual(await settingsClosed, { ok: false, reason: "Cancelled.", cancelled: true }, "the Plugins pane dismisses the request it owns when Settings closes");
  assert.ok(lifecycle.requestPluginConsent("other"));
  const refused = await installOfficialPlugin("cli", { showSheet: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.cancelled, undefined, "a refusal isn't a cancel");
  lifecycle.dismissPluginConsent("other");
  assert.equal((await installOfficialPlugin("not-a-plugin", { showSheet: false })).cancelled, undefined, "a plugin that isn't official fails, not cancels");
});

test("one click: Install on the sheet installs it, links ardia adopting the old home, grants control, and the promise settles", async () => {
  reset();
  takePluginCounts();
  host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin", adopted: true };
  const done = installOfficialPlugin("cli", { showSheet: false });
  assert.deepEqual({ name: P().consent.name, hash: P().consent.hash }, { name: "cli", hash: P().listings.cli.hash });
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  assert.deepEqual(await done, { ok: true });
  await settle();
  assert.equal(P().records.cli.installed, true);
  assert.ok(activeManifest(P(), "cli"));
  assert.equal(host.links.length, 1);
  const [spec] = host.links;
  assert.deepEqual({ name: spec.name, folderId: spec.folderId, version: spec.version, adopt: spec.adopt }, { name: "cli", folderId: "bundled", version: "0.3.0", adopt: true });
  assert.deepEqual(spec.programs, [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER }]);
  assert.deepEqual(P().programs.cli, { state: "linked", hash: spec.approved, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin" });
  assert.equal(S().settings.cliControl, true, "control comes on at Install, as the sheet says");
  assert.equal(officialPlugins(P(), true, hidden)[0].state, "installed");
  const counts = takePluginCounts();
  assert.equal(counts.program_links, 1);
  assert.equal(counts.program_adoptions, 1);
  assert.equal(counts.plugin_enables, 1);
  host.linkResult = null;
});

test("once installed nothing turns it off: no sheet, no disable, no remove; installing again just says ok", async () => {
  reset();
  S().updateSettings({ cliControl: false });
  assert.equal(lifecycle.requestPluginConsent("cli"), false);
  assert.equal(lifecycle.enablePlugin("cli", P().listings.cli.hash), false);
  assert.equal(lifecycle.disablePlugin("cli", null), false);
  assert.deepEqual(await lifecycle.removePlugin("cli"), { ok: false, reason: "It's built into Ardia and always on." });
  assert.deepEqual(pluginSocketMethod("plugins.disable", { name: "cli" }), { error: { code: "refused", message: "cli is built into Ardia: once installed it stays." } });
  assert.deepEqual(pluginSocketMethod("plugins.enable", { name: "cli" }), { result: { ok: true } });
  assert.deepEqual(await installOfficialPlugin("cli", { showSheet: false }), { ok: true });
  lifecycle.reconcilePlugins();
  await settle();
  assert.equal(host.links.length, 0, "an unchanged built-in isn't linked again");
  assert.ok(activeManifest(P(), "cli"));
  assert.equal(S().settings.cliControl, false, "turning control off later sticks");
  assert.deepEqual(host.unlinks, []);
  assert.deepEqual(host.removed, []);
});

test("a plugin you install can't be always on, can't run after-update actions and can't take ardia", async () => {
  const always = JSON.stringify({ manifest: 1, name: "always", title: "Always", alwaysOn: true });
  const after = JSON.stringify({ manifest: 1, name: "after", title: "After", programs: [{ name: "after-tool", path: "bin/a", afterUpdate: [["x"]] }] });
  const impostor = JSON.stringify({ manifest: 1, name: "impostor", title: "Impostor", programs: [{ name: "ardia", path: "bin/ardia" }] });
  await scan([
    { name: "after", status: "ok", text: after, folderId: "5:6" },
    { name: "always", status: "ok", text: always, folderId: "3:4" },
    { name: "cli", text: CLI, ...BUILT_IN },
    { name: "impostor", status: "ok", text: impostor, folderId: "7:8" },
  ]);
  assert.deepEqual(P().listings.always.problems, ["plugin.json: alwaysOn is only for plugins built into Ardia"]);
  assert.deepEqual(P().listings.after.problems, ["plugin.json: programs[0].afterUpdate is only for plugins built into Ardia"]);
  assert.deepEqual(P().listings.impostor.problems, ["plugin.json: programs[0].name: ardia belongs to Ardia's built-in cli plugin"]);
  assert.equal(lifecycle.requestPluginConsent("always"), false);
});

test("a folder you add named cli can't take ardia either, even with no built-in one", async () => {
  await scan([{ name: "cli", status: "ok", text: JSON.stringify({ ...JSON.parse(CLI), alwaysOn: undefined, official: undefined, icon: undefined, programs: [{ name: "ardia", path: "bin/ardia" }] }), folderId: "9:9" }]);
  assert.deepEqual(P().listings.cli.problems, ["plugin.json: programs[0].name: ardia belongs to Ardia's built-in cli plugin"]);
  await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }]);
});

test("a name someone else holds shows with Try Again, and Try Again links it once it's free", async () => {
  reset();
  const { canRelink, relinkPrograms } = await import("./programs.ts");
  usePlugins.setState((s) => ({ programs: { ...s.programs, cli: { state: "linked", hash: s.listings.cli.hash, linked: [], refused: { ardia: "/home/.local/bin/ardia is someone else's; remove it to use this one" }, binDir: "/home/.local/bin" } } }));
  assert.ok(canRelink(P().programs.cli));
  relinkPrograms("cli");
  await settle();
  assert.deepEqual(P().programs.cli.linked, ["ardia"]);
  assert.equal(canRelink(P().programs.cli), false);
});

test("any other plugin's programs still follow consent: on links, off unlinks, and control is granted at Turn On only", async () => {
  await scan([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "other", status: "ok", text: OTHER, folderId: "1:2" }]);
  reset();
  takePluginCounts();
  await turnOn("other");
  assert.equal(host.links.length, 1);
  assert.equal(host.links[0].adopt, false);
  assert.deepEqual(host.links[0].programs, [{ name: "other-tool", path: "bin/other" }], "after-update actions never travel for a plugin you installed");
  assert.equal(P().programs.other.state, "linked");
  assert.ok(lifecycle.disablePlugin("other"));
  await settle();
  assert.deepEqual(host.unlinks, [{ name: "other", programs: ["other-tool"], remove: false }]);
  assert.equal(P().programs.other, undefined);
  assert.equal(takePluginCounts().program_unlinks, 1);
});

test("a stale answer from the native side changes nothing; a refused link is shown with Try Again", async () => {
  reset();
  host.linkResult = { ok: false, stale: true };
  await turnOn("other");
  assert.equal(P().programs.other.state, "linking", "a newer request owns the state");
  lifecycle.disablePlugin("other");
  await settle();
  reset();
  takePluginCounts();
  host.linkResult = { ok: false, reason: "a test instance puts programs on PATH only with ARDIA_INSTANCE cliBinDir set" };
  await turnOn("other");
  assert.deepEqual(P().programs.other, { state: "failed", hash: P().listings.other.hash, reason: host.linkResult.reason });
  assert.equal(takePluginCounts().program_link_failures, 1);
  const { relinkPrograms } = await import("./programs.ts");
  host.linkResult = null;
  relinkPrograms("other");
  await settle();
  assert.equal(P().programs.other.state, "linked");
  lifecycle.disablePlugin("other");
  await settle();
});

test("a link that finishes after the plugin went off doesn't come back", async () => {
  reset();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const linkPrograms = stub.shellNativeModules.ArdiaPlugins.linkPrograms;
  stub.shellNativeModules.ArdiaPlugins.linkPrograms = async (spec) => (await gate, linkPrograms(spec));
  try {
    await turnOn("other");
    assert.equal(P().programs.other.state, "linking");
    lifecycle.disablePlugin("other");
    release();
    await settle();
    assert.equal(P().programs.other, undefined);
    assert.deepEqual(host.unlinks, [{ name: "other", programs: ["other-tool"], remove: false }]);
  } finally {
    stub.shellNativeModules.ArdiaPlugins.linkPrograms = linkPrograms;
  }
});

test("a plugin you added has its programs removed with it", async () => {
  reset();
  const removed = await lifecycle.removePlugin("other");
  assert.equal(removed.ok, true);
  assert.deepEqual(host.unlinks.at(-1), { name: "other", programs: ["other-tool"], remove: true });
});

test("what the command line gets, as Settings shows it", () => {
  const texts = consentLines(readManifest(CLI).manifest).map((l) => l.text);
  assert.deepEqual(texts, [
    "Adds ardia to your PATH. It runs as you, outside Ardia's sandbox",
    "After updates, runs ardia skills install --auto, ardia skills refresh",
    "Adds ~/.local/bin to your PATH in your shell's login file",
    "Lets any program you run drive your tabs and pages, with your logins, while it's installed. There's no off switch",
  ], "four honest lines: the program, what runs after updates, the PATH line and control");
  assert.ok(!texts.some((t) => t.includes("in the background")), "a program-only plugin runs nothing in the background");
});

test("the app's official catalogue is the pin file's, which the release fetches and verifies", async () => {
  const { readFileSync } = await import("node:fs");
  const { OFFICIAL_CATALOGUE, COMING_SOON } = await import("./official.ts");
  const pin = JSON.parse(readFileSync(new URL("../../../official-plugins.json", import.meta.url), "utf8"));
  assert.deepEqual(OFFICIAL_CATALOGUE, pin.plugins.map(({ name, title, blurb, icon }) => ({ name, title, blurb, icon })));
  assert.deepEqual(COMING_SOON, pin.comingSoon);
});
