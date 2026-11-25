import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const { contributedChrome, PLUGIN_CHROME } = await import("../plugins/chrome.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const providerPushes = () => stub.passwordProviders.calls.filter((c) => c[0] === "setFieldProviders").length;

const subscribeTo = useBrowser.subscribeTo;
let browserListeners = 0;
useBrowser.subscribeTo = (...args) => {
  browserListeners++;
  return subscribeTo(...args);
};

S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
S().createWindow({ url: "https://a.example/", profileId: "default" });
stub.pluginHost.folders = [];
startPlugins();
await lifecycle.rescanPlugins(consentToken());
const listenersBefore = browserListeners;
const pm = await import("./passwordManager.ts");
pm.startPasswordManager();
await settle();

test("with no password manager plugin and no profile away from Ardia, nothing listens to the browser store and nothing is pushed", async () => {
  assert.equal(browserListeners, listenersBefore);
  assert.equal(providerPushes(), 0);
  assert.equal(stub.docs.get("password-manager.json"), undefined);
  S().createWindow({ url: "https://b.example/", profileId: "default" });
  await settle();
  assert.equal(providerPushes(), 0);
  assert.equal(contributedChrome(P()) & PLUGIN_CHROME.verificationCodes, 0, "panes don't watch for verification codes");
});

test("choosing None starts it and holds offer to save off", async () => {
  pm.choosePasswordManager("default", "none");
  await settle();
  assert.equal(browserListeners, listenersBefore + 1);
  assert.equal(stub.profileToggles.user.get("")?.passwords, false);
  pm.choosePasswordManager("default", "ardia");
  await settle();
  assert.equal(stub.profileToggles.user.get("")?.passwords, true);
});

test("a manager plugin that sets up codes lights the panes' verification-code watch", async () => {
  stub.pluginHost.folders = [{ name: "password-manager", status: "ok", text: MANIFEST, folderId: "1:1" }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("password-manager"));
  assert.ok(lifecycle.enablePlugin("password-manager", P().consent.hash));
  await settle();
  assert.notEqual(contributedChrome(P()) & PLUGIN_CHROME.verificationCodes, 0);
});
