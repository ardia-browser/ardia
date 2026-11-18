import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
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
  const failed = officialView(plugin("available"), undefined, { state: "failed", reason: "cli can't load." });
  assert.deepEqual([failed.action, failed.failed, failed.status], ["again", true, "Couldn't install it: cli can't load."]);
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
  assert.deepEqual([failed.failed, failed.action, failed.status, failed.firstCommand], [true, "again", "Its command couldn't go on your PATH: busy", null]);
  const refused = officialView(plugin("installed"), { ...LINKED, linked: [], refused: { ardia: "ardia is someone else's command" } }, null);
  assert.deepEqual([refused.failed, refused.action, refused.status], [true, "again", "Its command isn't on your PATH yet: ardia is someone else's command"]);
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

test("official plugin counts are a fixed set of fields, sent with the hourly counts and listed in What's Sent", () => {
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
