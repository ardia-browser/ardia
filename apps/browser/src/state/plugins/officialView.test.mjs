import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const telemetryClient = await import("../telemetry/client.ts");
telemetryClient.loadChoice();
const sharingFor = (t) => {
  telemetryClient.setSharing(true, "settings");
  t.after(() => telemetryClient.setSharing(false, "settings"));
};
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { installOfficialPlugin, officialPlugins } = await import("./official.ts");
const { installedLabel, isOffered, officialView, wasCancelled } = await import("./officialView.ts");
const { noteOfficialPlugin, officialPluginField, takeOfficialPluginCounts, OFFICIAL_COUNTED_NAMES, OFFICIAL_EVENTS, OFFICIAL_SURFACES } = await import("../telemetry/officialPluginCounts.ts");
const { takeHourlyExtras } = await import("../telemetry/hourlyExtras.ts");
const { WHATS_SENT } = await import("../telemetry/copy.ts");

const plugin = (state, name = "cli", example = name === "cli" ? "ardia tabs" : null) => ({ name, title: "Command Line", blurb: "The ardia command.", icon: "terminal.fill", version: "0.3.0", example, state });
const LINKED = { state: "linked", hash: "h", linked: ["ardia"], refused: {}, binDir: "/Users/me/.local/bin" };

test("an unsupported plugin shows nothing, and a coming-soon one shows no button", () => {
  assert.equal(officialView(plugin("unsupported"), undefined, null).shown, false);
  const soon = officialView(plugin("comingSoon", "ai"), undefined, null);
  assert.deepEqual([soon.shown, soon.note, soon.action, soon.opens, soon.busy], [true, "comingSoon", null, false, false]);
});

test("an available plugin offers Install, waits while its sheet is open, and shows a failure with Retry", () => {
  const offered = officialView(plugin("available"), undefined, null);
  assert.deepEqual([offered.shown, offered.note, offered.action, offered.status], [true, null, "install", null]);
  const asking = officialView(plugin("available"), undefined, { state: "asking" });
  assert.deepEqual([asking.action, asking.busy, asking.status], [null, true, null]);
  const installing = officialView(plugin("available"), undefined, { state: "installing" });
  assert.deepEqual([installing.action, installing.busy, installing.status], [null, true, "Installing…"]);
  const failed = officialView(plugin("available"), undefined, { state: "failed", reason: "It can't load." });
  assert.deepEqual([failed.action, failed.failed, failed.status], ["again", true, "It can't load."]);
});

test("an installed plugin shows no sentence, only the first command its manifest gives to copy", () => {
  const view = officialView(plugin("installed"), LINKED, null);
  assert.deepEqual([view.note, view.action, view.failed, view.busy, view.status], ["installed", null, false, false, null]);
  assert.equal(view.firstCommand, "ardia tabs");
  assert.equal(officialView(plugin("installed", "tool"), LINKED, null).firstCommand, null);
});

test("an installed row says so beside its title, with the version when the seam has one", () => {
  assert.equal(installedLabel(plugin("installed")), "Installed · 0.3.0");
  assert.equal(installedLabel({ ...plugin("installed"), version: null }), "Installed");
});

test("a failed update stays on the row with Update to try again, while the old command keeps working", () => {
  const ready = officialView({ ...plugin("installed"), update: "0.6.0" }, LINKED, null);
  assert.deepEqual([ready.action, ready.failed], ["update", false]);
  const failed = officialView({ ...plugin("installed"), update: "0.6.0" }, LINKED, { state: "failed", reason: "The download didn't match." });
  assert.deepEqual([failed.action, failed.failed, failed.status], ["update", true, "The download didn't match."]);
});

test("an installed plugin whose command isn't on PATH says why and offers Retry", () => {
  const linking = officialView(plugin("installed"), { state: "linking", hash: "h", request: 1 }, null);
  assert.deepEqual([linking.busy, linking.action, linking.firstCommand], [true, null, null]);
  const failed = officialView(plugin("installed"), { state: "failed", hash: "h", reason: "busy" }, null);
  assert.deepEqual([failed.failed, failed.action, failed.status, failed.firstCommand], [true, "again", "Not on your PATH: busy", null]);
  const refused = officialView(plugin("installed"), { ...LINKED, linked: [], refused: { ardia: "ardia is someone else's command" } }, null);
  assert.deepEqual([refused.failed, refused.action, refused.status], [true, "again", "Not on your PATH: ardia is someone else's command"]);
  const bare = officialView(plugin("installed"), undefined, null);
  assert.deepEqual([bare.note, bare.status, bare.action], ["installed", null, null]);
});

test("only a plugin that can still be chosen counts as offered", () => {
  assert.deepEqual(["available", "comingSoon", "installed", "unsupported"].map((s) => isOffered(plugin(s))), [true, true, false, false]);
});

const CLI = JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, icon: "terminal.fill", permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia" }] });
useBrowser.getState().hydrate({});
stub.pluginHost.folders = [];
stub.pluginHost.officialArtifacts = { cli: CLI };
startPlugins();
for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));

test("closing the consent is no error: the seam marks it cancelled, and nothing else counts as cancelled", async () => {
  const asked = installOfficialPlugin("cli", { showSheet: false });
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(usePlugins.getState().consent.name, "cli");
  lifecycle.dismissPluginConsent("cli");
  const result = await asked;
  assert.equal(result.cancelled, true);
  assert.equal(wasCancelled(result), true);
  assert.equal(wasCancelled({ ok: false, reason: "cli can't load." }), false);
  assert.equal(wasCancelled({ ok: false, reason: "Cancelled." }), false);
  assert.equal(wasCancelled({ ok: true }), false);
  assert.equal(wasCancelled(await installOfficialPlugin("nope", { showSheet: false })), false);
  assert.equal(officialPlugins(usePlugins.getState(), true, () => false)[0].state, "available");
});

test("official plugin counts are a fixed set of fields, sent with the hourly counts and listed in What's Sent", (t) => {
  sharingFor(t);
  takeOfficialPluginCounts();
  noteOfficialPlugin("onboarding", "shown", "cli");
  noteOfficialPlugin("onboarding", "installed", "cli");
  noteOfficialPlugin("onboarding", "installed", "cli");
  noteOfficialPlugin("settings", "failed", "cli");
  noteOfficialPlugin("settings", "shown", "ai");
  noteOfficialPlugin("settings", "skipped", "cli");
  noteOfficialPlugin("onboarding", "skipped", "someone's plugin");
  const sent = takeHourlyExtras();
  assert.equal(sent.official_plugin_onboarding_shown_cli, 1);
  assert.equal(sent.official_plugin_onboarding_installed_cli, 2);
  assert.equal(sent.official_plugin_settings_failed_cli, 1);
  assert.equal(sent.official_plugin_settings_shown_ai, 1);
  assert.equal(sent.official_plugin_onboarding_skipped_other, 1);
  assert.equal(sent.official_plugin_settings_skipped_cli, undefined);
  const fields = new Set(OFFICIAL_SURFACES.flatMap((s) => OFFICIAL_EVENTS.flatMap((e) => [...OFFICIAL_COUNTED_NAMES, "other"].map((n) => officialPluginField(s, e, n)))));
  for (const key of Object.keys(sent).filter((k) => k.startsWith("official_plugin_"))) assert.ok(fields.has(key), key);
  assert.deepEqual(takeOfficialPluginCounts(), {});
  assert.ok(WHATS_SENT.some((group) => group.items.some((item) => item.includes("official plugin") && item.includes("onboarding") && item.includes("Settings"))));
});

test("every official plugin offers the same Install and, once installed, the same Installed row with no switch", () => {
  for (const name of ["cli", "passwords"]) {
    const off = officialView(plugin("available", name), undefined, null);
    assert.deepEqual([off.action, off.note], ["install", null], name);
    assert.equal("toggle" in off, false, name);
    const on = officialView(plugin("installed", name), undefined, null);
    assert.deepEqual([on.note, on.action], ["installed", null], name);
  }
  assert.equal(officialView(plugin("installed"), LINKED, null).note, "installed");
});

test("an installed official plugin keeps its program-link failure and Try Again", () => {
  const installed = plugin("installed", "passwords");
  const failed = officialView(installed, { state: "failed", reason: "no bin dir" }, null);
  assert.deepEqual([failed.note, failed.failed, failed.action, failed.status], ["installed", true, "again", "Not on your PATH: no bin dir"]);
  const refused = officialView(installed, { ...LINKED, refused: { ardia: "taken" } }, null);
  assert.deepEqual([refused.note, refused.failed, refused.action], ["installed", true, "again"]);
  const linking = officialView(installed, { state: "linking" }, null);
  assert.deepEqual([linking.note, linking.busy], ["installed", true]);
});

test("the Settings row and the consent sheet say Install for every official plugin, and the row has no switch", () => {
  const row = readFileSync(new URL("../../components/settings/panes/OfficialPlugins.tsx", import.meta.url), "utf8");
  const sheet = readFileSync(new URL("../../components/plugins/PluginConsentSheet.tsx", import.meta.url), "utf8");
  assert.match(row, /<Button title="Install…"/);
  assert.doesNotMatch(row, /Turn On|<Toggle/);
  assert.match(sheet, /const install = !!m\?\.official;/);
});


test("every pinned or coming-soon plugin is counted by name, a retired one as other, and cli and ai keep their field names", () => {
  assert.deepEqual([...OFFICIAL_COUNTED_NAMES].sort(), ["ai", "cli"]);
  assert.equal(officialPluginField("settings", "installed", "apple-passwords"), "official_plugin_settings_installed_other");
  assert.equal(officialPluginField("settings", "shown", "cli"), "official_plugin_settings_shown_cli");
  assert.equal(officialPluginField("onboarding", "installed", "ai"), "official_plugin_onboarding_installed_ai");
  assert.equal(officialPluginField("settings", "shown", "not-pinned"), "official_plugin_settings_shown_other");
});
