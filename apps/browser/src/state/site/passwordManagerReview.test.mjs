import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const actions = await import("../plugins/actions.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const { pageOf } = await import("../tabs/pageState.ts");
const { leftPage } = await import("../tabs/pageEvents.ts");
const pm = await import("./passwordManager.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const native = stub.passwordProviders;
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const pushes = () => native.calls.filter((c) => c[0] === "setFieldProviders");
const offerToSave = (profile) => stub.profileToggles.user.get(profile)?.passwords;
const folder = (name) => ({ name, status: "ok", text: MANIFEST.replace('"password-manager"', JSON.stringify(name)) });
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

function turnOn(name) {
  assert.ok(lifecycle.requestPluginConsent(name));
  assert.ok(lifecycle.enablePlugin(name, P().consent.hash));
}

let tabId = "";
let work = "";

test("setup: two password-manager plugins with the same fields, Personal on the first", async () => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  work = S().createProfile({ name: "Work" });
  const windowId = S().createWindow({ url: "https://a.example/login", profileId: "default" });
  tabId = S().windows[windowId].tabIds[0];
  startPlugins();
  stub.pluginHost.folders = [folder("first-pm"), folder("second-pm"), folder("third-pm")];
  await lifecycle.rescanPlugins(consentToken());
  pm.startPasswordManager();
  turnOn("first-pm");
  turnOn("second-pm");
  turnOn("third-pm");
  pm.choosePasswordManager("default", "plugin:first-pm");
  await settle();
  assert.equal(pm.currentPasswordManager("default"), "plugin:first-pm");
  assert.equal(offerToSave(""), false);
});

test("1: the prompt names the app the event's token is bound to, with no lookup of its own, and shows nothing without one", async () => {
  native.calls.length = 0;
  pm.verificationCodeFound(tabId, { token: "t1", main: true, app: "Authenticator" });
  await settle();
  assert.equal(pageOf(tabId).verificationCode?.app, "Authenticator");
  assert.deepEqual(native.calls.filter((c) => c[0] === "otpauthHandler"), [], "no dummy otpauth lookup");
  leftPage(tabId, "https://a.example/login", "https://a.example/login", "chromium", false);
  pm.verificationCodeFound(tabId, { token: "t2", main: true });
  await settle();
  assert.equal(pageOf(tabId).verificationCode, null, "no app, no offer");
});

test("2: an offer belongs to the page and generation it arrived in; a reload never brings an old token back", async () => {
  pm.choosePasswordManager(work, "plugin:first-pm");
  await settle();
  const held = gate();
  native.handlerGate = held.promise;
  pm.verificationCodeFound(tabId, { token: "old", main: true, app: "Passwords" });
  await settle();
  leftPage(tabId, "https://a.example/login", "https://a.example/login", "chromium", false);
  pm.choosePasswordManager(work, "none");
  await settle();
  held.open();
  native.handlerGate = null;
  await settle();
  assert.equal(pageOf(tabId).verificationCode, null, "the reload closed it and nothing wrote the old token back");
  pm.verificationCodeFound(tabId, { token: "fresh", main: true, app: "Passwords" });
  assert.equal(pageOf(tabId).verificationCode?.generation, pm.providerGeneration(), "stamped with the generation it arrived in");
  leftPage(tabId, "https://a.example/login", "https://a.example/login", "chromium", false);
});

test("3a: switching between two plugins with the same fields pushes a new generation", async () => {
  native.calls.length = 0;
  pm.choosePasswordManager("default", "plugin:second-pm");
  await settle();
  assert.equal(pushes().length, 1, "a different provider is a different set");
});

test("3b: a rejected push isn't remembered, so the next change pushes the same set again", async () => {
  native.rejectNext = 1;
  native.calls.length = 0;
  pm.choosePasswordManager(work, "plugin:second-pm");
  await settle();
  assert.equal(pushes().length, 1);
  S().updateProfile("default", { name: "Personal 2" });
  await settle();
  assert.equal(pushes().length, 2, "retried");
  assert.deepEqual(native.profiles.map((p) => p.profile).sort(), ["", work].sort());
});

test("3c: turning a plugin off waits for native to drop its profiles before the host reports it off", async () => {
  pm.choosePasswordManager(work, "plugin:third-pm");
  await settle();
  const held = gate();
  native.hold = held.promise;
  const done = actions.disablePlugin("third-pm");
  await settle();
  assert.equal(P().records["third-pm"].enabled, true, "still reported on while native hasn't answered");
  held.open();
  native.hold = null;
  await done;
  await settle();
  assert.equal(P().records["third-pm"].enabled, false);
  assert.ok(!native.profiles.some((p) => p.profile === work));
});

test("3d: a native answer that never comes holds the turn-off for about a second, then it goes ahead", async () => {
  turnOn("third-pm");
  await settle();
  native.hold = new Promise(() => {});
  const started = Date.now();
  await actions.disablePlugin("third-pm");
  const waited = Date.now() - started;
  native.hold = null;
  assert.equal(P().records["third-pm"].enabled, false);
  assert.ok(waited >= 900 && waited < 2500, String(waited));
  await settle();
});

test("4: plugin → Ardia → plugin before the record write lands keeps Ardia's ownership, so Ardia gets offer to save back later", async () => {
  pm.choosePasswordManager("default", "plugin:first-pm");
  await settle();
  assert.equal(offerToSave(""), false);
  stub.heldSaves.on = true;
  pm.choosePasswordManager("default", "ardia");
  await settle();
  pm.choosePasswordManager("default", "plugin:first-pm");
  await settle();
  stub.heldSaves.on = false;
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await settle();
  await settle();
  assert.equal(offerToSave(""), false, "the plugin still holds it off");
  pm.choosePasswordManager("default", "ardia");
  await settle();
  await settle();
  assert.equal(offerToSave(""), true, "back to Ardia gives it back");
});

test("5: password-manager.json is a versioned document, and the unversioned form still reads", async () => {
  pm.choosePasswordManager(work, "plugin:first-pm");
  await settle();
  const saved = JSON.parse(stub.docs.get("password-manager.json"));
  assert.equal(saved.version, 1);
  assert.ok(saved.offerToSaveHeldOff.includes(work));
  stub.docs.set("password-manager.json", JSON.stringify({ offerToSaveHeldOff: [work] }));
  pm.choosePasswordManager(work, "ardia");
  await settle();
  await settle();
  assert.equal(offerToSave(work), true, "a record from before versions still gives offer to save back");
});
