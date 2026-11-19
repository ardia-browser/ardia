import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { refusedWrites } = await import("../../test-native/shell.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { installOfficialPlugin, officialPlugins } = await import("../plugins/official.ts");
const surface = await import("../plugins/consentSurface.ts");
const owner = () => surface.consentOwner(P().consent);
const { activeSteps, maybeStartOnboarding, startOnboarding, useOnboarding } = await import("./onboarding.ts");
const { readSaved, saveOnboarding } = await import("./onboardingDocument.ts");
const { offeredInOnboarding } = await import("./pluginsOffer.ts");
const step = await import("./pluginsStep.ts");
const { takeOfficialPluginCounts } = await import("../telemetry/officialPluginCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const O = () => useOnboarding.getState();
const T = () => step.usePluginsStep.getState();
const host = stub.pluginHost;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const CLI = JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, icon: "terminal.fill", permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia" }] });
const BUILT_IN = { status: "ok", folderId: "bundled", bundled: true };
const LONG_STEP = ["refresh", "--with-a-very-long-option-name", "and-another-argument-that-goes-on", "--plus-one-more-flag", "value-number-one", "value-number-two", "value-number-three", "--and-finally-this"];
const LONG_CONSENT = JSON.stringify({ manifest: 1, name: "long", title: "Long", version: "1.0.0", alwaysOn: true, official: true, permissions: ["control", "network", "tabs", "fullUrls", "commands"], programs: Array.from({ length: 4 }, (_, i) => ({ name: `long-tool-${i}`, path: `bin/l${i}`, afterUpdate: Array.from({ length: 4 }, () => LONG_STEP) })) });
const offered = (soon = false) => offeredInOnboarding(officialPlugins(P(), true, () => soon));

setConsentPeriod(true, "test-epoch");
S().hydrate({});
const windowId = S().createWindow();

async function scanned(folders) {
  host.linkResult = null;
  usePlugins.setState({ records: {}, programs: {}, consent: null });
  host.folders = folders;
  await lifecycle.rescanPlugins(null);
  await settle();
}

async function atOffer() {
  await scanned([{ name: "cli", text: CLI, ...BUILT_IN }]);
  step.resetPluginsStep();
  takeOfficialPluginCounts();
  startOnboarding(windowId, "plugins");
}

test("resuming at the plugin step before the first scan keeps the step and saves no skip; it stays once the scan finds the command line", async () => {
  assert.equal(P().scanned, false);
  host.folders = [{ name: "cli", text: CLI, ...BUILT_IN }];
  saveOnboarding({ startedAt: 1, step: "plugins", sub: 0, source: "fresh" });
  assert.equal(maybeStartOnboarding(), true);
  assert.equal(O().step, "plugins");
  assert.equal(readSaved().step, "plugins", "nothing decided while the catalogue was unknown");
  assert.ok(activeSteps().includes("plugins"));
  await lifecycle.rescanPlugins(null);
  await settle();
  assert.equal(P().scanned, true);
  step.passEmptyPluginsStep();
  assert.equal(O().step, "plugins");
  assert.deepEqual(offered().map((p) => `${p.name}:${p.state}`), ["cli:available"]);
});

test("once the scan is known to be empty, the step is passed to the outro", async () => {
  await scanned([]);
  startOnboarding(windowId, "plugins");
  step.passEmptyPluginsStep();
  assert.equal(O().step, "outro");
});

test("a confirm the plugin store refuses to save is a failure with a reason, with Continue and Try Again, never a cancel", async () => {
  await atOffer();
  const done = step.installPickedPlugins(offered());
  await settle();
  assert.equal(P().consent?.name, "cli");
  refusedWrites.on = true;
  assert.equal(step.confirmPluginConsent(P().consent.id), false);
  refusedWrites.on = false;
  await done;
  assert.equal(P().consent, null, "the consent page closes");
  assert.equal(T().phase, "failed");
  assert.ok([step.REFUSED_REASON, "plugins.json couldn't be saved."].includes(T().failures.cli), T().failures.cli);
  assert.equal(step.primaryTitle(offered(), T()), "Continue");
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_failed_cli: 1 });
  const again = step.installPluginAgain("cli");
  await settle();
  assert.ok(step.confirmPluginConsent(P().consent.id));
  await again;
  assert.equal(T().phase, "installed");
});

test("a consent onboarding asked for belongs to onboarding: its sheet shows over onboarding, Settings doesn't show it, and does show its own", async () => {
  await atOffer();
  const done = step.installPickedPlugins(offered());
  await settle();
  assert.equal(P().consent?.name, "cli");
  assert.equal(owner(), "onboarding");
  step.skipPluginsStep(offered());
  await done;
  assert.equal(P().consent, null);
  assert.ok(lifecycle.requestPluginConsent("cli"));
  assert.equal(owner(), "settings");
  lifecycle.dismissPluginConsent("cli");
});

test("Install in Settings while onboarding asks for the same plugin hands the request to Settings; onboarding can't confirm or cancel it, even leaving right after", async () => {
  await atOffer();
  const done = step.installPickedPlugins(offered());
  await settle();
  const onboardingAsk = P().consent;
  assert.equal(owner(), "onboarding");
  const settings = installOfficialPlugin("cli", { showSheet: false });
  const settingsAsk = P().consent;
  assert.notEqual(settingsAsk.id, onboardingAsk.id);
  assert.equal(settingsAsk.hash, onboardingAsk.hash);
  assert.equal(owner(), "settings");
  assert.equal(step.confirmPluginConsent(settingsAsk.id), false, "onboarding can't confirm Settings' request");
  assert.equal(step.cancelPluginConsent(settingsAsk.id), false, "or cancel it");
  assert.equal(step.confirmPluginConsent(onboardingAsk.id), false, "its own old id is no longer the request");
  await done;
  assert.deepEqual(T().failures, { cli: "Another install started." });
  step.leavePluginsStep();
  assert.equal(P().consent?.id, settingsAsk.id, "leaving onboarding leaves Settings' request alone");
  assert.ok(surface.confirmConsentAs("settings", settingsAsk.id));
  assert.deepEqual(await settings, { ok: true });
});

test("a Settings confirm can't accept onboarding's request, even for the same plugin and hash", async () => {
  await atOffer();
  const done = step.installPickedPlugins(offered());
  await settle();
  const asked = P().consent;
  assert.equal(owner(), "onboarding");
  assert.equal(surface.confirmConsentAs("settings", asked.id), false);
  assert.equal(surface.dismissConsentAs("settings", asked.id), false);
  assert.equal(P().records.cli, undefined);
  assert.equal(P().consent?.id, asked.id);
  assert.ok(step.cancelPluginConsent(asked.id));
  await done;
  assert.equal(T().phase, "offer");
});

test("onboarding enables a plugin only through its own consent request, by that request's id and its hash", async () => {
  await scanned([{ name: "cli", text: CLI, ...BUILT_IN }]);
  const hash = P().listings.cli.hash;
  assert.equal(P().consent, null);
  assert.equal(step.confirmPluginConsent(1), false, "no request, no install");
  assert.equal(P().records.cli, undefined);
  step.resetPluginsStep();
  startOnboarding(windowId, "plugins");
  const done = step.installPickedPlugins(offered());
  await settle();
  const asked = P().consent;
  assert.equal(asked.hash, hash);
  assert.equal(step.confirmPluginConsent(asked.id + 1), false, "an id that isn't the request is refused");
  assert.equal(P().records.cli, undefined);
  assert.ok(step.confirmPluginConsent(asked.id));
  await done;
  assert.equal(P().records.cli.approved, asked.hash);
  assert.equal(T().phase, "installed");
});

test("when the only official plugin disappears while its consent is open, the request is settled before the step moves on", async () => {
  await atOffer();
  const done = step.installPickedPlugins(offered());
  await settle();
  assert.equal(owner(), "onboarding");
  host.folders = [];
  await lifecycle.rescanPlugins(null);
  await settle();
  step.passEmptyPluginsStep();
  assert.equal(O().step, "outro");
  assert.equal(P().consent, null, "no request is left without an owner");
  const outcome = await Promise.race([done.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]);
  assert.equal(outcome, "settled");
});

test("a request onboarding left behind is dismissed by whoever notices", async () => {
  await atOffer();
  const done = step.installPickedPlugins(offered());
  await settle();
  const asked = P().consent;
  useOnboarding.setState({ step: "outro" });
  assert.equal(owner(), null, "its owner is gone, so neither surface owns it");
  assert.ok(surface.dismissOrphanedConsent());
  assert.equal(P().consent, null);
  await done;
  assert.notEqual(P().consent?.id, asked.id);
});

test("a long consent is still one request with every entry, for the sheet to scroll", async () => {
  await scanned([{ name: "long", text: LONG_CONSENT, ...BUILT_IN }]);
  const { consentLines } = await import("../plugins/consent.ts");
  assert.deepEqual(P().listings.long.problems, []);
  const lines = consentLines(P().listings.long.manifest);
  assert.ok(lines.length >= 12, `${lines.length} entries`);
  assert.ok(lines.reduce((n, l) => n + l.text.length, 0) > 2400, "well over thirty wrapped lines at the sheet's width");
});

test("each offered plugin counts as shown once per visit, even when the list changes under it", async () => {
  await atOffer();
  step.notePluginsShown(["cli", "ai"]);
  step.notePluginsShown(["ai"]);
  step.notePluginsShown(["cli", "ai"]);
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_shown_cli: 1, official_plugin_onboarding_shown_ai: 1 });
  step.leavePluginsStep();
  step.notePluginsShown(["ai"]);
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_shown_ai: 1 }, "a new visit counts again");
});
