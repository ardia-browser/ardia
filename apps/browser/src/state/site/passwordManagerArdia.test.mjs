import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const pm = await import("./passwordManager.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const native = stub.passwordProviders;
const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const pushedFills = () => Object.fromEntries(native.profiles.map((p) => [p.profile, p.fill]));

const sources = new Set();
let work = "";
let fresh = "";
let personalTab = "";
let workTab = "";

test("an Ardia profile gets the fill menu only while it has a source, and a system plugin profile keeps the panel", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  work = S().createProfile({ name: "Work" });
  const firstTabOf = (windowId) => S().windows[windowId].tabIds[0];
  personalTab = firstTabOf(S().createWindow({ url: "https://a.example/", profileId: "default" }));
  workTab = firstTabOf(S().createWindow({ url: "https://b.example/", profileId: work }));
  startPlugins();
  stub.pluginHost.folders = [{ name: "other-passwords", status: "ok", text: MANIFEST.replace('"password-manager"', '"other-passwords"') }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(lifecycle.requestPluginConsent("other-passwords"));
  assert.ok(lifecycle.enablePlugin("other-passwords", usePlugins.getState().consent.hash));
  pm.startPasswordManager();
  pm.choosePasswordManager(work, "plugin:other-passwords");
  await settle();
  assert.deepEqual(pushedFills(), { [work]: "system" }, "before the vault engine connects, Ardia profiles push nothing");

  pm.connectArdiaSource((_id, profile) => sources.has(profile));
  await settle();
  assert.deepEqual(pushedFills(), { [work]: "system" }, "an Ardia profile with no source keeps Chrome's dropdown");
  sources.add("");
  pm.refreshFieldProviders();
  await settle();
  assert.deepEqual(pushedFills(), { "": "menu", [work]: "system" });
  const entry = native.profiles.find((p) => p.profile === "");
  assert.deepEqual([entry.fields, entry.codeSetup], [["login", "oneTimeCode"], false], "Ardia sets codes up from the right-click menu only");
  assert.equal(pm.fieldProviderFillOfTab(personalTab), "menu");
  assert.equal(pm.fieldProviderFillOfTab(workTab), "system");
});

test("a WebKit tab never gets the fill menu: an Ardia profile shows no key there, a system plugin profile keeps its panel", async () => {
  const { vaultsOnForTab } = await import("../vaults/enabled.ts");
  const { noteVaultField, useVaultMenus } = await import("../vaults/menu.ts");
  const inWebKit = (tabId, engine) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], engine } } }));
  inWebKit(personalTab, "webkit");
  inWebKit(workTab, "webkit");
  try {
    assert.equal(pm.fieldProviderFillOfTab(personalTab), null, "menu mode is Chromium-only");
    assert.equal(pm.fieldProviderFillOfTab(workTab), "system");
    assert.equal(vaultsOnForTab(personalTab), false, "the vault engine never runs in a WebKit tab");
    const field = { frameId: "f", origin: "https://a.example", main: true, kind: "username", focused: true, rect: { x: 1, y: 2, width: 200, height: 30 }, formHasPassword: true, clicked: false, auto: false, email: true, maxLength: 0, webauthn: false };
    noteVaultField(personalTab, field);
    assert.equal(useVaultMenus.getState().fields[personalTab], undefined, "a stale or forged field report for an Ardia WebKit tab is dropped");
    noteVaultField(workTab, { ...field, origin: "https://b.example" });
    assert.equal(useVaultMenus.getState().fields[workTab]?.focused, true, "the plugin's badge still shows in WebKit");
    assert.equal(pm.pressFieldProviderKey(personalTab), null);
  } finally {
    inWebKit(personalTab, undefined);
    inWebKit(workTab, undefined);
    useVaultMenus.setState((s) => ({ fields: { ...s.fields, [personalTab]: undefined, [workTab]: undefined } }));
  }
  assert.equal(pm.fieldProviderFillOfTab(personalTab), "menu");
});

test("pressing the key opens the macOS panel on a system plugin profile and does nothing where no provider is pushed", async () => {
  native.calls.length = 0;
  assert.equal(pm.pressFieldProviderKey(workTab), null);
  await settle();
  assert.deepEqual(native.calls.filter((c) => c[0] === "showSystemPanel"), [["showSystemPanel", workTab]]);
  pm.choosePasswordManager("default", "none");
  await settle();
  native.calls.length = 0;
  assert.equal(pm.pressFieldProviderKey(personalTab), null);
  await settle();
  assert.deepEqual(native.calls.filter((c) => c[0] === "showSystemPanel"), []);
});

test("connecting a password manager records Ardia only for a profile that never chose, with its data-sharing group", () => {
  assert.equal(pm.recordArdiaChoice("default"), false, "an explicit None is never overwritten");
  assert.equal(S().profiles.default.passwordManager, "none");
  assert.equal(pm.recordArdiaChoice(work), false, "an explicit plugin is never overwritten");
  fresh = S().createProfile({ name: "Fresh" });
  const sharing = S().createProfile({ name: "Fresh Too", shareWith: fresh });
  assert.equal(S().profiles[fresh].passwordManager, undefined);
  assert.equal(pm.recordArdiaChoice(sharing), true);
  assert.deepEqual([S().profiles[fresh].passwordManager, S().profiles[sharing].passwordManager], ["ardia", "ardia"]);
  assert.equal(pm.recordArdiaChoice(fresh), false, "already explicit");
});

test("leaving Ardia asks for the owner first and keeps Ardia when declined", async () => {
  stub.passwordsUnlock.answer = false;
  assert.equal(await pm.choosePasswordManagerChecked(fresh, "none"), false);
  assert.equal(pm.currentPasswordManager(fresh), "ardia");
  stub.passwordsUnlock.answer = true;
  assert.equal(await pm.choosePasswordManagerChecked(fresh, "none"), true);
  assert.equal(pm.currentPasswordManager(fresh), "none");
  stub.passwordsUnlock.answer = false;
  assert.equal(await pm.choosePasswordManagerChecked(fresh, "ardia"), true, "coming back to Ardia needs no check");
  stub.passwordsUnlock.answer = true;
});
