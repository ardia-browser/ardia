import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const toNative = [];
const wantedListeners = [];
const { shellNativeModules } = await import("../../test-native/shell.ts");
globalThis.acTestNativeModules = {
  ArdiaPlugins: {
    ...shellNativeModules.ArdiaPlugins,
    setCredentialProvider: async (name, enabled) => (toNative.push(["set", name, enabled]), { ok: true }),
    forgetCredentialProvider: async (name) => (toNative.push(["forget", name]), { ok: true }),
    addListener: (event, listener) => (event === "onCredentialRunWanted" && wantedListeners.push(listener), { remove() {} }),
  },
};

const { readManifest } = await import("../../lib/pluginManifest.ts");
const { usePlugins } = await import("./store.ts");
const { useBrowser } = await import("../browser/store.ts");
const { markPluginReady } = await import("./activation.ts");
const { superviseProcess, processExited, stopProcess } = await import("./process.ts");
const { watchCredentialProviders } = await import("./credentialProviders.ts");
const { officialCredentialProviders } = await import("./officialCredentials.ts");

const text = readFileSync(new URL("../../../../../tests/fixtures/plugins/credential-providers/bitwarden.json", import.meta.url), "utf8");
const manifest = readManifest(text).manifest;
const HASH = "b".repeat(64);
const listing = { name: "bitwarden", manifest, problems: [], hash: HASH, folderId: `official-${"a".repeat(64)}`, official: true };
const record = (enabled) => ({ enabled, approved: HASH, values: {}, applied: {} });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a credential provider is turned on natively once its run is ready, and off when it is turned off", async () => {
  watchCredentialProviders();
  usePlugins.setState({ listings: { bitwarden: listing }, order: ["bitwarden"], records: { bitwarden: record(true) }, processes: { bitwarden: { state: "running", run: 7, since: 0 } } });
  assert.ok(markPluginReady("bitwarden", 7));
  await tick();
  assert.deepEqual(toNative, [["set", "bitwarden", true]]);
  usePlugins.setState({ processes: { bitwarden: { state: "running", run: 8, since: 0 } } });
  assert.ok(markPluginReady("bitwarden", 8));
  await tick();
  assert.deepEqual(toNative.at(-1), ["set", "bitwarden", true], "a new run, after a lock ended the old one, is pinned again");
  usePlugins.setState({ records: { bitwarden: record(false) } });
  await tick();
  assert.deepEqual(toNative.at(-1), ["set", "bitwarden", false]);
  assert.equal(toNative.filter(([kind]) => kind === "set").length, 3);
  assert.ok(wantedListeners.length > 0, "native can ask for a new run");
});

test("removing a credential provider leaves the wipe to native Remove, and a save target that named it goes back to Ardia", async () => {
  useBrowser.getState().updateSettings({ vaultSaveTarget: "bitwarden" });
  usePlugins.setState({ listings: { bitwarden: listing }, order: ["bitwarden"], records: { bitwarden: record(false) } });
  usePlugins.setState({ listings: {}, order: [], records: {} });
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!toNative.some(([kind]) => kind === "forget"));
  assert.equal(useBrowser.getState().settings.vaultSaveTarget, "");
});

test("the official catalogue lists credential providers from the pin, installed or not", () => {
  const pinned = [{ name: "bitwarden", version: "1.0.0", folderId: listing.folderId, credentialPrograms: ["bw"], title: "Bitwarden" }, { name: "cli", version: "0.6.0", folderId: "official-x" }];
  const base = { listings: {}, records: {}, order: [], pinned, candidates: {} };
  assert.deepEqual(officialCredentialProviders(base, true), [{ name: "bitwarden", title: "Bitwarden", blurb: "", icon: "key.fill", symbol: "key.fill", accent: null, state: "available", enabled: false }]);
  const installed = officialCredentialProviders({ ...base, listings: { bitwarden: listing }, order: ["bitwarden"], records: { bitwarden: record(true) } }, true);
  assert.deepEqual(installed.map((p) => [p.title, p.symbol, p.accent, p.state, p.enabled]), [["Bitwarden", "shield.lefthalf.filled", "#175DDC", "installed", true]]);
  const off = officialCredentialProviders({ ...base, listings: { bitwarden: listing }, order: ["bitwarden"], records: { bitwarden: record(false) } }, true);
  assert.deepEqual(off.map((p) => [p.state, p.enabled]), [["installed", false]], "installed but off stays listed so the row can offer Turn On");
  assert.equal(officialCredentialProviders(base, false)[0].state, "unsupported");
});

test("a run native asks for while the locked run is still winding down starts once that run has exited", async () => {
  watchCredentialProviders();
  usePlugins.setState({ listings: { bitwarden: listing }, order: ["bitwarden"], records: { bitwarden: record(true) }, processes: {} });
  superviseProcess("bitwarden", HASH, manifest, listing.folderId, null);
  for (let i = 0; i < 6; i++) await tick();
  const first = usePlugins.getState().processes.bitwarden;
  assert.equal(first.state, "running");
  assert.ok(markPluginReady("bitwarden", first.run));
  for (const listener of wantedListeners) listener({ name: "bitwarden" });
  assert.equal(usePlugins.getState().processes.bitwarden.run, first.run, "the old run still looks ready, so nothing starts yet");
  processExited({ name: "bitwarden", run: first.run, status: null, signal: 9, overMemory: false, requested: true });
  for (let i = 0; i < 6; i++) await tick();
  const next = usePlugins.getState().processes.bitwarden;
  assert.equal(next.state, "running");
  assert.notEqual(next.run, first.run);
  assert.ok(markPluginReady("bitwarden", next.run));
  stopProcess("bitwarden", null, 0);
});
