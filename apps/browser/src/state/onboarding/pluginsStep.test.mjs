import assert from "node:assert/strict";
import { test } from "node:test";
import { detail, fakeRegistry, keyPair, officialSig, sha, version } from "../plugins/fixtures/registry.mjs";
import { v3Text } from "../plugins/fixtures/manifests.mjs";
const stub = await import("../../test-native/index.ts");
const shell = await import("../../test-native/shell.ts");
const { reloadLaunchConfigForTests } = await import("../../platform/launchConfig.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const { usePlugins } = await import("../plugins/store.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const client = await import("../plugins/registryClient.ts");
const { refreshCatalog, useCatalog } = await import("../plugins/marketplace.ts");
const { featuredPlugins } = await import("../plugins/featured.ts");
const { activeSteps, startOnboarding, STEPS, QUESTION_ORDER } = await import("./onboarding.ts");
const { offeredInOnboarding } = await import("./pluginsOffer.ts");
const step = await import("./pluginsStep.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const BASE = "https://registry.test/r";
const registryKeys = keyPair();
const nativeKeys = keyPair();
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const T = () => step.usePluginsStep.getState();
const host = stub.pluginHost;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const offered = () => offeredInOnboarding(featuredPlugins(P(), useCatalog.getState()));

setConsentPeriod(true, "test-epoch");
S().hydrate({});
startPlugins();
await settle();

const CLI_TEXT = v3Text({ name: "cli", title: "Command Line", version: "1.0.0", icon: "terminal.fill", permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", example: "ardia tabs" }] } }, "ardia");

async function registryWithCli() {
  shell.launch.pluginRegistryURL = BASE;
  shell.launch.pluginRegistryKeys = `test=${registryKeys.publicPem}`;
  shell.launch.pluginNativeKeys = `native=${nativeKeys.publicPem}`;
  reloadLaunchConfigForTests();
  const registry = fakeRegistry(BASE, registryKeys);
  client.setRegistryFetcherForTests(registry.fetcher);
  client.resetRegistryCacheForTests();
  stub.docs.delete("Plugins/registry-cache.json");
  const officialSigned = await officialSig({ id: "@ardia/cli", version: "1.0.0", platform: "universal", sha256: sha(1) }, nativeKeys);
  await registry.publish([detail("@ardia/cli", [version("1.0.0", { artifacts: { universal: { url: "https://github.com/ardia-browser/plugins/releases/download/cli-v1/cli.tar.gz", sha256: sha(1), sizeBytes: 10, officialSig: officialSigned } } })], { tier: "native" })]);
  host.artifacts["@ardia/cli"] = CLI_TEXT;
  return registry;
}

test("the step sits between Make it home and the outro, and is left out while this Ardia has no registry key", async () => {
  assert.deepEqual(STEPS.slice(-3), ["home", "plugins", "outro"]);
  assert.deepEqual(QUESTION_ORDER.slice(-2), ["plugins", "outro"]);
  assert.deepEqual(offered(), []);
  assert.ok(!activeSteps().includes("plugins"));
});

test("offline, the step offers Try Again, and the registry coming back lists Command Line preselected", async () => {
  const registry = await registryWithCli();
  registry.setOffline(true);
  await refreshCatalog(true);
  assert.deepEqual(offered().map((p) => p.state), ["offline"]);
  takePluginCounts();
  registry.setOffline(false);
  await step.checkRegistryAgain();
  assert.equal(takePluginCounts().onboarding_registry_offline, 1);
  const [cli] = offered();
  assert.equal(cli.state, "available");
  assert.equal(cli.name, "ardia__cli");
  assert.ok(step.isPicked(cli, T().picks), "Command Line is picked unless you unpick it");
});

test("Install fetches @ardia/cli from the registry, asks on the onboarding sheet, and installs it", async () => {
  await registryWithCli();
  await refreshCatalog(true);
  startOnboarding(S().createWindow(), "plugins");
  step.resetPluginsStep();
  takePluginCounts();
  const plugins = offered();
  const running = step.installPickedPlugins(plugins);
  for (let i = 0; i < 100 && !P().consent; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(P().consent?.name, "ardia__cli");
  assert.ok(step.confirmPluginConsent(P().consent.id));
  await running;
  await settle();
  assert.equal(T().phase, "installed");
  assert.deepEqual(T().installed, ["ardia__cli"]);
  assert.deepEqual(host.artifactLog.at(-1).id, "@ardia/cli");
  const counts = takePluginCounts();
  assert.equal(counts.onboarding_plugin_installed, 1);
  assert.equal(counts.registry_installs, 1);
  lifecycle.disablePlugin("ardia__cli", null);
});

test("a failed download shows the reason with Try Again, and skipping counts the plugin as skipped", async () => {
  await registryWithCli();
  await refreshCatalog(true);
  usePlugins.setState({ records: {}, consent: null });
  stub.docs.delete("Plugins/plugins-lock.json");
  (await import("../plugins/lockfile.ts")).resetLockForTests();
  host.folders = [];
  await lifecycle.rescanPlugins(null);
  startOnboarding(S().createWindow(), "plugins");
  step.resetPluginsStep();
  host.artifactResults.ardia__cli = { ok: false, code: "offline", reason: "offline" };
  await step.installPickedPlugins(offered());
  assert.equal(T().phase, "failed");
  assert.match(T().failures.ardia__cli, /Check your internet connection/);
  delete host.artifactResults.ardia__cli;
  takePluginCounts();
  step.skipPluginsStep(offered());
  assert.equal(takePluginCounts().onboarding_plugin_skipped, 0, "a plugin that failed isn't also counted as skipped");
});
