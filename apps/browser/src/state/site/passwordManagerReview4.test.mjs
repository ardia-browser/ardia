import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "password-manager-review-4");
const offer = await import("./offerToSave.ts");
const pm = await import("./passwordManager.ts");
const { setPasswordAutofillFor } = await import("../settings/paneData.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const native = stub.passwordProviders;
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const offerToSave = (profile) => stub.profileToggles.user.get(profile)?.passwords;
const record = () => JSON.parse(stub.docs.get("password-manager.json") ?? "{}").offerToSaveHeldOff ?? [];
const folder = (name) => ({ name, status: "ok", text: MANIFEST.replace('"password-manager"', JSON.stringify(name)) });
const nativeProfiles = () => native.profiles.map((p) => p.profile).sort();

function turnOn(name) {
  assert.ok(lifecycle.requestPluginConsent(name));
  assert.ok(lifecycle.enablePlugin(name, P().consent.hash));
}

test("the settings snapshot has no password manager counts until plugins are scanned, so the day isn't marked early", async () => {
  assert.equal(pm.passwordManagerSnapshot(), null);
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  startPlugins();
  stub.pluginHost.folders = [folder("one-pm"), folder("two-pm")];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(pm.passwordManagerSnapshot());
  pm.startPasswordManager();
  turnOn("one-pm");
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  await wait(50);
  assert.equal(offerToSave(""), false);
  assert.deepEqual(nativeProfiles(), [""]);
});

test("when plugins.json can't be saved after the withdrawal, the plugin stays on and native gets its providers back", async () => {
  stub.refusedWrites.on = true;
  try {
    assert.equal(await lifecycle.turnOffPlugin("one-pm", consentToken()), false);
  } finally {
    stub.refusedWrites.on = false;
  }
  assert.equal(P().records["one-pm"].enabled, true);
  await settle();
  await wait(50);
  assert.deepEqual(nativeProfiles(), [""], "the profile's provider is pushed again");
});

test("two removals at once: the second is refused while the first is still turning the plugin off", async () => {
  turnOn("two-pm");
  await settle();
  const first = lifecycle.removePlugin("two-pm");
  const second = await lifecycle.removePlugin("two-pm");
  assert.deepEqual(second, { ok: false, reason: "It is already being removed." });
  assert.equal((await first).ok, true);
});

test("a profile change while a withdrawal waits for native pushes the withdrawn set, never the plugin being turned off", async () => {
  const work = S().createProfile({ name: "Work" });
  pm.choosePasswordManager(work, "plugin:one-pm");
  await settle();
  await wait(50);
  native.holdNext = new Promise(() => {});
  native.calls.length = 0;
  const off = lifecycle.turnOffPlugin("one-pm", consentToken());
  await settle();
  S().updateProfile(work, { name: "Work 2" });
  await settle();
  const pushed = native.calls.filter((c) => c[0] === "setFieldProviders").map((c) => c[2]);
  assert.ok(pushed.length >= 1);
  assert.ok(pushed.every((profiles) => profiles.length === 0), JSON.stringify(pushed));
  assert.ok(await off);
  turnOn("one-pm");
  await settle();
  await wait(1200);
});

test("a held-off record that can't be written keeps the request and retries it, then saving goes off", async () => {
  offer.OFFER_TO_SAVE_RETRY.firstMs = 50;
  pm.choosePasswordManager("default", "ardia");
  await settle();
  await wait(50);
  assert.equal(offerToSave(""), true);
  await setPasswordAutofillFor("", true);
  assert.ok(!record().includes(""), "turning it on yourself clears the record");
  stub.refusedSaves.on = true;
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  assert.equal(offerToSave(""), true, "no record, so the pref stays on");
  assert.ok(offer.pendingOfferToSave() > 0, "the request is still pending");
  stub.refusedSaves.on = false;
  await wait(300);
  assert.ok(record().includes(""));
  assert.equal(offerToSave(""), false, "the retry turned it off");
});

test("a give-back native refuses (profile not loaded) leaves the record, and a retry gives saving back", async () => {
  stub.profileToggles.unloadable.add("");
  pm.choosePasswordManager("default", "ardia");
  await settle();
  await wait(20);
  assert.equal(offerToSave(""), false);
  assert.ok(record().includes(""), "the record still says Ardia turned it off");
  stub.profileToggles.unloadable.delete("");
  await wait(400);
  assert.equal(offerToSave(""), true, "given back on retry");
  assert.deepEqual(JSON.parse(stub.docs.get("password-manager.json")).offerToSaveRestored, [""], "marked for a later launch to confirm");
});

test("turning offer to save off in Settings is refused while the record can't drop the profile, so a restart can't turn it back on", async () => {
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  await wait(50);
  assert.ok(record().includes(""));
  stub.profileToggles.user.set("", { ...stub.profileToggles.user.get(""), passwords: true });
  stub.refusedSaves.on = true;
  try {
    await setPasswordAutofillFor("", false);
  } finally {
    stub.refusedSaves.on = false;
  }
  assert.ok(record().includes(""));
  assert.equal(offerToSave(""), true, "the Off isn't applied beside a stale record");
  await setPasswordAutofillFor("", false);
  assert.equal(offerToSave(""), false);
  assert.ok(!record().includes(""), "cleared once the write works");
});

test("turning offer to save off while Ardia is giving it back leaves no record that could turn it on again", async () => {
  stub.profileToggles.user.set("", { ...stub.profileToggles.user.get(""), passwords: true });
  pm.choosePasswordManager("default", "ardia");
  await settle();
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  await wait(50);
  assert.ok(record().includes(""));
  assert.equal(offerToSave(""), false);
  stub.heldSaves.on = true;
  pm.choosePasswordManager("default", "ardia");
  await settle();
  const off = setPasswordAutofillFor("", false);
  stub.heldSaves.on = false;
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await off;
  await settle();
  await wait(50);
  assert.equal(offerToSave(""), false, "the person's Off stands");
  assert.ok(!record().includes(""), "no record says Ardia turned it off");
});
