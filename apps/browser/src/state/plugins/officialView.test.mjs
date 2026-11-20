import assert from "node:assert/strict";
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
const { noteOfficialPlugin, officialPluginField, takeOfficialPluginCounts, OFFICIAL_EVENTS, OFFICIAL_SURFACES } = await import("../telemetry/officialPluginCounts.ts");
const { takeHourlyExtras } = await import("../telemetry/hourlyExtras.ts");
const { WHATS_SENT } = await import("../telemetry/copy.ts");

const plugin = (state, name = "cli") => ({ name, title: "Command Line", blurb: "The ardia command.", icon: "terminal.fill", version: "0.3.0", state });
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

test("an installed plugin shows no sentence, only a first command to copy when it has one", () => {
  const view = officialView(plugin("installed"), LINKED, null);
  assert.deepEqual([view.note, view.action, view.failed, view.busy, view.status], ["installed", null, false, false, null]);
  assert.equal(view.firstCommand, "ardia tabs");
  assert.equal(officialView(plugin("installed", "tool"), LINKED, null).firstCommand, null);
});

test("an installed row says so beside its title, with the version when the seam has one", () => {
  assert.equal(installedLabel(plugin("installed")), "Installed · 0.3.0");
  assert.equal(installedLabel({ ...plugin("installed"), version: null }), "Installed");
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
stub.pluginHost.folders = [{ name: "cli", text: CLI, status: "ok", folderId: "bundled", bundled: true }];
startPlugins();
for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));

test("closing the consent is no error: the seam marks it cancelled, and nothing else counts as cancelled", async () => {
  const asked = installOfficialPlugin("cli", { showSheet: false });
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
  const fields = new Set(OFFICIAL_SURFACES.flatMap((s) => OFFICIAL_EVENTS.flatMap((e) => ["cli", "ai", "other"].map((n) => officialPluginField(s, e, n)))));
  for (const key of Object.keys(sent).filter((k) => k.startsWith("official_plugin_"))) assert.ok(fields.has(key), key);
  assert.deepEqual(takeOfficialPluginCounts(), {});
  assert.ok(WHATS_SENT.some((group) => group.items.some((item) => item.includes("official plugin") && item.includes("onboarding") && item.includes("Settings"))));
});

test("a built-in plugin with an off switch offers Turn On, and once on shows On with its switch; an always-on one still installs", () => {
  const switchable = (state) => ({ ...plugin(state, "passwords"), switchable: true });
  const off = officialView(switchable("available"), undefined, null);
  assert.deepEqual([off.action, off.note, off.toggle], ["turnOn", null, false]);
  const on = officialView(switchable("installed"), undefined, null);
  assert.deepEqual([on.note, on.toggle, on.action, on.firstCommand], ["on", true, null, null]);
  const cli = officialView({ ...plugin("available"), switchable: false }, undefined, null);
  assert.deepEqual([cli.action, cli.toggle], ["install", false]);
  assert.equal(officialView({ ...plugin("installed"), switchable: false }, LINKED, null).note, "installed");
});

test("a switchable plugin that is on keeps its program-link failure and Try Again next to its switch", () => {
  const switchable = { ...plugin("installed", "passwords"), switchable: true };
  const failed = officialView(switchable, { state: "failed", reason: "no bin dir" }, null);
  assert.deepEqual([failed.note, failed.toggle, failed.failed, failed.action, failed.status], ["on", true, true, "again", "Not on your PATH: no bin dir"]);
  const refused = officialView(switchable, { ...LINKED, refused: { ardia: "taken" } }, null);
  assert.deepEqual([refused.note, refused.toggle, refused.failed, refused.action], ["on", true, true, "again"]);
  const linking = officialView(switchable, { state: "linking" }, null);
  assert.deepEqual([linking.note, linking.toggle, linking.busy], ["on", true, true]);
});

test("the seam marks a built-in plugin switchable unless it's always on", async () => {
  const manifest = (name, extra) => JSON.stringify({ manifest: 1, name, title: name, version: "1.0.0", official: true, icon: "key.fill", ...extra });
  const listed = (name, extra) => ({ name, status: "ok", text: manifest(name, extra), folderId: "bundled", bundled: true });
  useBrowser.getState().hydrate({});
  startPlugins();
  stub.pluginHost.folders = [listed("switchy", { passwordManager: { fill: "system", fields: ["login"] } }), listed("stays", { alwaysOn: true })];
  await lifecycle.rescanPlugins(null);
  const byName = Object.fromEntries(officialPlugins(usePlugins.getState(), true).map((p) => [p.name, p]));
  assert.equal(byName.switchy?.switchable, true);
  assert.equal(byName.stays?.switchable, false);
  stub.pluginHost.folders = [];
  await lifecycle.rescanPlugins(null);
});
