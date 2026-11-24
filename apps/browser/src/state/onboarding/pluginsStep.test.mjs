import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const { usePlugins } = await import("../plugins/store.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { officialPlugins, installOfficialPlugin } = await import("../plugins/official.ts");
const { activeSteps, questionsFor, goToStep, startOnboarding, useOnboarding, QUESTION_ORDER, STEPS } = await import("./onboarding.ts");
const { offeredInOnboarding, pluginsStepHasSomething } = await import("./pluginsOffer.ts");
const step = await import("./pluginsStep.ts");
const { takeOfficialPluginCounts } = await import("../telemetry/officialPluginCounts.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const O = () => useOnboarding.getState();
const T = () => step.usePluginsStep.getState();
const host = stub.pluginHost;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const CLI = JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, icon: "terminal.fill", permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia" }] });
const TOOL = JSON.stringify({ manifest: 1, name: "tool", title: "Tool", alwaysOn: true, official: true, programs: [{ name: "tool-x", path: "bin/x" }] });
const BUILT_IN = { status: "ok", folderId: "bundled", official: true };
const offered = (soon = false) => offeredInOnboarding(officialPlugins(P(), true, () => soon));
const plugin = (state, name = "cli") => ({ name, title: name, blurb: "", icon: "terminal.fill", version: null, state });

const pinOf = (entries) => entries.map((e, i) => ({ name: e.name, version: JSON.parse(e.text).version ?? "1.0.0", folderId: `official-${String(i + 1).repeat(64)}` }));

async function fresh(entries) {
  host.linkResult = null;
  host.links.length = 0;
  host.promotes.length = 0;
  host.officialFetchLog.length = 0;
  host.officialFetchResults = {};
  host.officialFetchGate = null;
  host.pinned = pinOf(entries);
  host.officialArtifacts = Object.fromEntries(entries.map((e) => [e.name, e.text]));
  host.folders = [];
  usePlugins.setState({ records: {}, programs: {}, consent: null, pinned: null, candidates: {}, fetches: {} });
  await lifecycle.rescanPlugins(null);
  await settle();
  step.resetPluginsStep();
  takeOfficialPluginCounts();
  startOnboarding(S().createWindow(), "plugins");
}

const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "test-epoch");
S().hydrate({});
startPlugins();
await settle();

test("the step sits between Make it home and the outro, and is left out when no official plugin can be offered", async () => {
  assert.deepEqual(STEPS.slice(-3), ["home", "plugins", "outro"]);
  assert.deepEqual(QUESTION_ORDER.slice(-2), ["plugins", "outro"]);
  await fresh([]);
  assert.deepEqual(questionsFor("plugins"), []);
  assert.ok(!activeSteps().includes("plugins"));
  assert.equal(pluginsStepHasSomething([plugin("unsupported"), plugin("comingSoon", "ai")]), false);
  assert.equal(pluginsStepHasSomething([plugin("installed")]), true);
  assert.deepEqual(offeredInOnboarding([plugin("unsupported"), plugin("comingSoon", "ai")]).map((p) => p.name), ["ai"]);
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  assert.deepEqual(questionsFor("plugins").map((q) => q.id), ["plugins"]);
  assert.deepEqual(activeSteps().slice(-3), ["home", "plugins", "outro"]);
});

test("the command line starts ticked, another official plugin doesn't, and only an available one can be ticked", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }, { name: "tool", text: TOOL, ...BUILT_IN }]);
  const [cli, tool] = offered();
  assert.deepEqual([step.isPicked(cli, T().picks), step.isPicked(tool, T().picks)], [true, false]);
  assert.equal(step.primaryTitle(offered(), T()), "Install");
  step.togglePluginPick(cli);
  assert.equal(step.isPicked(cli, T().picks), false);
  assert.equal(step.primaryTitle(offered(), T()), "Continue");
  step.togglePluginPick(tool);
  assert.deepEqual(step.pickedPlugins(offered(), T().picks).map((p) => p.name), ["tool"]);
  step.togglePluginPick(plugin("comingSoon", "ai"));
  step.togglePluginPick(plugin("installed", "done"));
  assert.deepEqual(Object.keys(T().picks).sort(), ["cli", "tool"]);
  assert.equal(step.isPicked(plugin("installed"), {}), false);
});

test("Skip installs nothing, asks for nothing and moves on", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  step.skipPluginsStep(offered());
  await settle();
  assert.equal(O().step, "outro");
  assert.equal(P().consent, null);
  assert.equal(P().records.cli, undefined);
  assert.deepEqual(host.links, []);
  assert.equal(O().picked.plugins, undefined);
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_skipped_cli: 1 });
});

test("Continue with nothing ticked installs nothing and moves on", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  step.togglePluginPick(offered()[0]);
  await step.installPickedPlugins(offered());
  assert.equal(O().step, "outro");
  assert.equal(P().consent, null);
  assert.deepEqual(host.links, []);
  assert.deepEqual(O().picked.plugins, []);
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_skipped_cli: 1 });
});

test("Install asks first: nothing is installed until the consent shown in onboarding is accepted", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  const done = step.installPickedPlugins(offered());
  await settle();
  assert.deepEqual([T().phase, T().current, P().consent?.name], ["working", "cli", "cli"]);
  assert.equal(P().records.cli, undefined);
  assert.deepEqual(host.links, []);
  assert.equal(O().step, "plugins");
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  await done;
  assert.deepEqual([T().phase, T().installed, O().step], ["installed", ["cli"], "plugins"]);
  assert.equal(P().records.cli.installed, true);
  assert.equal(host.links.length, 1);
  assert.equal(offered()[0].state, "installed");
  step.finishPluginsStep(offered());
  assert.equal(O().step, "outro");
  assert.deepEqual(O().picked.plugins, ["Command Line installed"]);
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_installed_cli: 1 });
});

test("cancelling the consent returns to the offer with nothing installed", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  const done = step.installPickedPlugins(offered());
  await settle();
  lifecycle.dismissPluginConsent("cli");
  await done;
  assert.deepEqual([T().phase, T().current, T().installed, O().step], ["offer", null, [], "plugins"]);
  assert.equal(P().records.cli, undefined);
  assert.deepEqual(takeOfficialPluginCounts(), {});
});

test("a failed install shows its reason, can be tried again, and never blocks finishing", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  host.linkResult = { ok: false, reason: "busy" };
  const done = step.installPickedPlugins(offered());
  await settle();
  lifecycle.enablePlugin("cli", P().consent.hash);
  await done;
  assert.equal(T().phase, "failed");
  assert.equal(T().failures.cli, "Installed, but not on your PATH: busy");
  assert.equal(step.primaryTitle(offered(), T()), "Continue");
  host.linkResult = null;
  await step.installPluginAgain("cli");
  assert.deepEqual([T().phase, T().failures, T().installed], ["installed", {}, ["cli"]]);
  assert.deepEqual(takeOfficialPluginCounts(), { official_plugin_onboarding_failed_cli: 1, official_plugin_onboarding_installed_cli: 1 });
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  host.linkResult = { ok: false, reason: "busy" };
  const again = step.installPickedPlugins(offered());
  await settle();
  lifecycle.enablePlugin("cli", P().consent.hash);
  await again;
  step.finishPluginsStep(offered());
  assert.equal(O().step, "outro");
  assert.deepEqual(O().picked.plugins, []);
});

test("Skip while the consent is showing closes it and installs nothing; leaving the step does the same", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  const done = step.installPickedPlugins(offered());
  await settle();
  step.skipPluginsStep(offered());
  await done;
  assert.equal(O().step, "outro");
  assert.equal(P().consent, null);
  assert.equal(P().records.cli, undefined);
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  const left = step.installPickedPlugins(offered());
  await settle();
  goToStep("home");
  step.leavePluginsStep();
  await left;
  assert.equal(P().consent, null);
  assert.equal(T().phase, "offer");
  assert.equal(O().step, "home");
});

test("an install that is already there has nothing to offer: Continue moves on and counts no skip", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  const asked = installOfficialPlugin("cli", { showSheet: false });
  await settle();
  lifecycle.enablePlugin("cli", P().consent.hash);
  await asked;
  await settle();
  step.resetPluginsStep();
  takeOfficialPluginCounts();
  const list = offered();
  assert.equal(list[0].state, "installed");
  assert.deepEqual(step.pickedPlugins(list, T().picks), []);
  assert.equal(step.primaryTitle(list, T()), "Continue");
  await step.installPickedPlugins(list);
  assert.equal(O().step, "outro");
  assert.equal(P().consent, null);
  assert.deepEqual(takeOfficialPluginCounts(), {});
  useOnboarding.setState({ windowId: null });
});

test("Install downloads first: nothing is asked or installed while it downloads, and the verified download is what the consent shows", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  let release;
  host.officialFetchGate = new Promise((resolve) => (release = resolve));
  const done = step.installPickedPlugins(offered());
  await settle();
  assert.deepEqual(host.officialFetchLog, ["cli"]);
  assert.equal(P().consent, null);
  assert.equal(P().fetches.cli?.state, "fetching");
  release();
  await settle();
  assert.equal(P().consent?.name, "cli");
  assert.equal(P().consent.hash, P().candidates.cli.hash);
  assert.equal(P().listings.cli, undefined, "the download stays out of the active scan until confirmed");
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  await done;
  assert.deepEqual(host.promotes.map((p) => [p.name, p.folderId, p.approved]), [["cli", host.pinned[0].folderId, P().records.cli.approved]]);
  assert.equal(P().listings.cli.folderId, host.pinned[0].folderId);
  assert.equal(host.links.length, 1);
});

test("an offline download leaves nothing installed and offers Try Again, which works once it's back", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  host.officialFetchResults.cli = { ok: false, code: "offline", reason: "The Internet connection appears to be offline." };
  await step.installPickedPlugins(offered());
  assert.equal(T().phase, "failed");
  assert.match(T().failures.cli, /Check your internet connection/);
  assert.equal(P().consent, null);
  assert.equal(P().records.cli, undefined);
  assert.equal(P().listings.cli, undefined);
  assert.deepEqual(host.links, []);
  assert.deepEqual(host.promotes, []);
  delete host.officialFetchResults.cli;
  const again = step.installPluginAgain("cli");
  await settle();
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  await again;
  assert.deepEqual([T().phase, T().installed], ["installed", ["cli"]]);
});

test("leaving the step while it downloads cancels the download and asks nothing afterwards", async () => {
  await fresh([{ name: "cli", text: CLI, ...BUILT_IN }]);
  let release;
  host.officialFetchGate = new Promise((resolve) => (release = resolve));
  const done = step.installPickedPlugins(offered());
  await settle();
  goToStep("home");
  step.leavePluginsStep();
  release();
  await done;
  await settle();
  assert.equal(P().consent, null);
  assert.equal(P().records.cli, undefined);
  assert.deepEqual(host.promotes, []);
  assert.equal(O().step, "home");
  useOnboarding.setState({ windowId: null });
});
