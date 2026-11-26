import assert from "node:assert/strict";
import { v3Text } from "./fixtures/manifests.mjs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const lifecycle = await import("./lifecycle.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const AUTO = v3Text({ name: "auto", title: "Auto", permissions: { control: true }, contributes: { programs: [{ name: "auto-tool", path: "bin/auto" }] } }, "ardia");
const { updateLock } = await import("./lockfile.ts");
await updateLock(() => ({ "@ardia/auto": { id: "@ardia/auto", key: "ardia__auto", version: "1.0.0", channel: "latest", source: { kind: "registry", url: "https://ardia.dev/r" }, sha256: "a".repeat(64), payloadDigest: null, dependencies: [], officialSig: "A".repeat(86), platform: "universal", root: true, official: true, installedAt: 1 } }), null);

setConsentPeriod(true, "test-epoch");
S().hydrate({});
host.links.length = 0;
host.linkResult = { ok: true, linked: ["auto-tool"], refused: {}, binDir: "/home/.local/bin" };
host.folders = [{ name: "ardia__auto", text: AUTO, status: "ok", folderId: `store-${"a".repeat(64)}`, source: "store" }];
startPlugins();
await settle();

test("an official plugin with control installs nothing by itself: activation waits for the user's approval, and Install grants control once", async () => {
  const { usePlugins, activeManifest } = await import("./store.ts");
  assert.equal(activeManifest(usePlugins.getState(), "ardia__auto"), null);
  assert.deepEqual(host.links, []);
  assert.equal(S().settings.cliControl, false);
  assert.ok(lifecycle.requestPluginConsent("ardia__auto"));
  assert.ok(lifecycle.enablePlugin("ardia__auto", usePlugins.getState().consent.hash));
  await settle();
  assert.ok(activeManifest(usePlugins.getState(), "ardia__auto"));
  assert.equal(S().settings.cliControl, true);
});

test("you turn control off, Ardia restarts, and it stays off: no launch turns it back on", async () => {
  const { stopProgramControl } = await import("../app/programControl.ts");
  stopProgramControl();
  assert.equal(S().settings.cliControl, false);
  const meta = S().settingsMeta;
  S().hydrate({ settings: { ...S().settings }, settingsMeta: meta });
  await lifecycle.rescanPlugins();
  lifecycle.reconcilePlugins();
  await settle();
  assert.equal(S().settings.cliControl, false, "an explicit Off is kept across a restart");
  const { relinkOwnPrograms } = await import("./programs.ts");
  relinkOwnPrograms("ardia__auto");
  await settle();
  assert.equal(S().settings.cliControl, false, "a relink isn't a new grant either");
  host.linkResult = null;
});

test("after Stop, the Settings switch turns control back on, and a relaunch keeps it on", async () => {
  const { stopProgramControl } = await import("../app/programControl.ts");
  const { setControlFromSettings } = await import("../app/programControlSetting.ts");
  stopProgramControl();
  assert.equal(S().settings.cliControl, false);
  setControlFromSettings(true);
  assert.equal(S().settings.cliControl, true);
  lifecycle.reconcilePlugins();
  await settle();
  assert.equal(S().settings.cliControl, true);
  const { readFileSync } = await import("node:fs");
  const pane = readFileSync(new URL("../../components/settings/panes/Advanced.tsx", import.meta.url), "utf8");
  assert.match(pane, /function ProgramsRows\(\) \{[\s\S]*?<ProgramControlRow \/>/, "the macOS Programs section has the switch, not only the program list");
  assert.match(pane, /anchor="advanced.programControl"[\s\S]*?onChange=\{setControlFromSettings\}/);
});
