import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "password-manager-review");
const { takePasswordManagerCounts } = await import("../telemetry/passwordManagerCounts.ts");
const pm = await import("./passwordManager.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const native = stub.passwordProviders;
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pushes = () => native.calls.filter((c) => c[0] === "setFieldProviders");
const offerToSave = (profile) => stub.profileToggles.user.get(profile)?.passwords;
const folder = (name) => ({ name, status: "ok", text: MANIFEST.replace('"password-manager"', JSON.stringify(name)) });
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};
const nativeProfiles = () => native.profiles.map((p) => p.profile).sort();

function turnOn(name) {
  assert.ok(lifecycle.requestPluginConsent(name));
  assert.ok(lifecycle.enablePlugin(name, P().consent.hash));
}

let work = "";

test("setup", async () => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  work = S().createProfile({ name: "Work" });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  startPlugins();
  stub.pluginHost.folders = [folder("one-pm"), folder("two-pm")];
  await lifecycle.rescanPlugins(consentToken());
  pm.startPasswordManager();
  turnOn("one-pm");
  turnOn("two-pm");
  pm.choosePasswordManager("default", "plugin:one-pm");
  pm.choosePasswordManager(work, "plugin:two-pm");
  await settle();
  assert.deepEqual(nativeProfiles(), ["", work].sort());
});

test("a1: every push carries the same session id, made once for this runtime", async () => {
  const sessions = native.sessions;
  assert.ok(sessions.length > 0, "pushed at least once");
  assert.ok(sessions.every((x) => typeof x === "string" && x.length >= 8), JSON.stringify(sessions));
  assert.equal(new Set(sessions).size, 1);
});

test("a2: a withdrawal native never answers commits Off after the deadline, then keeps retrying until native applies it", async () => {
  native.holdNext = new Promise(() => {});
  native.calls.length = 0;
  assert.ok(await lifecycle.turnOffPlugin("two-pm", consentToken()));
  assert.equal(P().records["two-pm"].enabled, false, "off committed after the deadline");
  await wait(2500);
  assert.ok(pushes().length >= 2, `retried: ${pushes().length}`);
  assert.deepEqual(nativeProfiles(), [""], "Work's provider is gone natively");
  turnOn("two-pm");
  await settle();
});

test("a3: a push native ignores as stale (applied: false) is pushed again with a fresh generation", async () => {
  native.notAppliedNext = 1;
  native.calls.length = 0;
  pm.choosePasswordManager(work, "plugin:one-pm");
  await wait(1500);
  const gens = pushes().map((c) => c[1]);
  assert.ok(gens.length >= 2 && gens[1] > gens[0], JSON.stringify(gens));
  assert.equal(native.generation, gens.at(-1));
});

test("a4: rejections back off from one second", async () => {
  native.rejectNext = 2;
  native.calls.length = 0;
  pm.choosePasswordManager(work, "plugin:two-pm");
  await wait(1400);
  assert.equal(pushes().length, 2, "first retry after about a second");
  await wait(2200);
  assert.equal(pushes().length, 3, "second retry about two seconds later");
  assert.deepEqual(nativeProfiles(), ["", work].sort());
});

test("b: plugin → Ardia → plugin whose record write fails leaves saving on until its record lands, and Ardia finds it on", async () => {
  assert.equal(offerToSave(""), false);
  stub.heldSaves.on = true;
  pm.choosePasswordManager("default", "ardia");
  await settle();
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  stub.heldSaves.on = false;
  stub.refusedSaves.on = true;
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await settle();
  await settle();
  stub.refusedSaves.on = false;
  assert.equal(offerToSave(""), true, "the plugin's Off waits for its own record");
  assert.ok(JSON.parse(stub.docs.get("password-manager.json")).offerToSaveHeldOff.includes(""), "the record still holds the profile, so a restart can still give saving back");
  pm.choosePasswordManager("default", "ardia");
  await settle();
  await settle();
  assert.equal(offerToSave(""), true, "saving comes back");
});

test("c: a record from a newer Ardia is never overwritten; offer to save is left alone and the failure counted once", async () => {
  const newer = JSON.stringify({ version: 2, offerToSaveHeldOff: ["somewhere"], more: true });
  stub.stagedDocs.delete("password-manager.json");
  stub.docs.set("password-manager.json", newer);
  takePasswordManagerCounts();
  const before = offerToSave(work);
  pm.choosePasswordManager(work, "ardia");
  await settle();
  pm.choosePasswordManager(work, "plugin:one-pm");
  await settle();
  await settle();
  assert.equal(stub.docs.get("password-manager.json"), newer, "untouched");
  assert.equal(offerToSave(work), before, "offer to save untouched");
  assert.equal(takePasswordManagerCounts().password_manager_record_failed, 1, "logged once");
});
