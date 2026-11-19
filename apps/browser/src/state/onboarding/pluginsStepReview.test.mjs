import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { refusedWrites } = await import("../../test-native/shell.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { officialPlugins } = await import("../plugins/official.ts");
const { settingsOwnsConsent } = await import("../plugins/consentSurface.ts");
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
  assert.equal(step.confirmPluginConsent("cli", P().consent.hash), false);
  refusedWrites.on = false;
  await done;
  assert.equal(P().consent, null, "the consent page closes");
  assert.equal(T().phase, "failed");
  assert.deepEqual(T().failures, { cli: step.REFUSED_REASON });
  assert.equal(step.primaryTitle(offered(), T()), "Continue");
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_failed_cli: 1 });
  const again = step.installPluginAgain("cli");
  await settle();
  assert.ok(step.confirmPluginConsent("cli", P().consent.hash));
  await again;
  assert.equal(T().phase, "installed");
});

test("a consent onboarding asked for belongs to onboarding: the Settings pane doesn't show it, and does show its own", async () => {
  await atOffer();
  const done = step.installPickedPlugins(offered());
  await settle();
  assert.equal(P().consent?.name, "cli");
  assert.equal(settingsOwnsConsent(P().consent), false);
  step.skipPluginsStep(offered());
  await done;
  assert.equal(P().consent, null);
  assert.ok(lifecycle.requestPluginConsent("cli"));
  assert.equal(settingsOwnsConsent(P().consent), true);
  lifecycle.dismissPluginConsent("cli");
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
