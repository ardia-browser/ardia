import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { takePasswordManagerCounts } = await import("../telemetry/passwordManagerCounts.ts");
const { setPasswordAutofillFor } = await import("../settings/paneData.ts");

setConsentPeriod(true, "password-manager-update-test");

const APPLE_HASH = "d8476938b3d33c28cb5494dd4fe670accce05a3f61b1d458c737a8f43505824e";
const OTHER_HASH = "d8476938b3d33c28cb5494dd4fe670accce05a3f61b1d458c737a8f43505824e";
const RECORD = "password-manager.json";
const record = (heldOff, restored) => JSON.stringify({ offerToSaveHeldOff: heldOff, ...(restored ? { offerToSaveRestored: restored } : {}), version: 1 });
const EMPTY = { offerToSaveHeldOff: [], version: 1 };
const saved = () => (stub.docs.get(RECORD) ? JSON.parse(stub.docs.get(RECORD)) : null);
const pluginsSaved = () => JSON.parse(stub.docs.get("plugins.json")).plugins;
const toggle = (profile) => stub.profileToggles.user.get(profile)?.passwords;
const profile = (id, passwordManager, extra = {}) => ({ id, name: id, color: "plum", icon: null, createdAt: 0, ...(passwordManager === undefined ? {} : { passwordManager }), ...extra });
const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};
const counts = () => Object.fromEntries(Object.entries(takePasswordManagerCounts()).filter(([field, n]) => n && /moved_back|offer_to_save/.test(field)));

stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { "apple-passwords": { enabled: true, approved: APPLE_HASH, values: {}, applied: {} }, other: { enabled: false, approved: OTHER_HASH, values: {}, applied: {} } } }));
stub.docs.set(RECORD, record(["", "work", "gone"]));
stub.profileToggles.user.set("", { passwords: false });
stub.profileToggles.user.set("work", { passwords: false });
stub.profileToggles.user.set("mine", { passwords: false });
stub.pluginHost.folders = [];
S().hydrate({
  profiles: { default: profile("default", "plugin:apple-passwords"), work: profile("work", undefined), shared: profile("shared", undefined, { dataId: "work" }), c: profile("c", "ardia") },
  profileOrder: ["default", "work", "shared", "c"],
});
S().createWindow({ url: "https://a.example/", profileId: "default" });

let launches = 0;
async function launch() {
  const n = ++launches;
  const { startPlugins } = await import(`../plugins/start.ts?launch=${n}`);
  const lifecycle = await import("../plugins/lifecycle.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  startPlugins();
  await lifecycle.rescanPlugins(consentToken());
  const pm = await import(`./passwordManager.ts?launch=${n}`);
  pm.startPasswordManager();
  await settle();
  return pm;
}

test("launch 1 after the update: Apple Passwords' choices read Ardia, its record goes, and offer to save comes back once per data, marked but not yet confirmed", async () => {
  takePasswordManagerCounts();
  const pm = await launch();
  assert.equal(usePlugins.getState().records["apple-passwords"], undefined, "the orphaned record is dropped");
  assert.deepEqual(Object.keys(pluginsSaved()), ["other"], "and only it");
  for (const id of ["default", "work", "shared", "c"]) assert.equal(S().profiles[id].passwordManager, "ardia", `${id} is saved as Ardia, so a rollback to 0.2.47 can't pick the plugin`);
  assert.equal(pm.currentPasswordManager("default"), "ardia");
  assert.equal(toggle(""), true);
  assert.equal(toggle("work"), true, "work and the profile sharing its data are restored through one engine profile");
  assert.equal(toggle("mine"), false, "an off Ardia didn't make is left alone");
  assert.equal(stub.profileToggles.user.has("gone"), false, "a deleted profile's engine data isn't touched");
  assert.deepEqual(saved(), { offerToSaveHeldOff: ["", "work"], offerToSaveRestored: ["", "work"], version: 1 }, "the deleted profile is dropped; the rest stay until a later launch reads the value back");
  assert.deepEqual(counts(), { password_manager_profiles_moved_back: 2 });
});

test("launch 2 reads offer to save back on and clears the record; launch 3 writes nothing", async () => {
  await launch();
  assert.deepEqual(saved(), EMPTY);
  assert.deepEqual(counts(), { password_manager_offer_to_save_restored: 2 });
  const before = { record: stub.docs.get(RECORD), plugins: stub.docs.get("plugins.json"), profiles: S().profiles };
  await launch();
  assert.deepEqual({ record: stub.docs.get(RECORD), plugins: stub.docs.get("plugins.json"), profiles: S().profiles }, before);
  assert.deepEqual(counts(), {});
});

test("a crash before the record is marked sets it again, and a value Chrome lost before it reached disk is set again and confirmed only later", async () => {
  stub.docs.set(RECORD, record(["work"]));
  stub.profileToggles.user.set("work", { passwords: true });
  await launch();
  assert.deepEqual(saved(), { offerToSaveHeldOff: ["work"], offerToSaveRestored: ["work"], version: 1 }, "set again and marked, harmlessly");
  stub.profileToggles.user.set("work", { passwords: false });
  await launch();
  assert.equal(toggle("work"), true, "the pref Chrome never wrote is set again");
  assert.deepEqual(saved().offerToSaveRestored, ["work"], "and its own launch doesn't confirm it");
  await launch();
  assert.deepEqual(saved(), EMPTY);
  counts();
});

test("your own switch wins: an Off during a pending restore drops the record first, and an Off after the restore isn't undone by the next launch", async () => {
  stub.docs.set(RECORD, record(["work"]));
  stub.profileToggles.user.set("work", { passwords: false });
  const pending = launch();
  await setPasswordAutofillFor("work", false);
  await pending;
  await settle();
  assert.equal(toggle("work"), false, "you chose after the update, so Ardia doesn't undo it");
  assert.deepEqual(saved(), EMPTY);

  stub.docs.set(RECORD, record(["work"]));
  await launch();
  assert.equal(toggle("work"), true);
  assert.deepEqual(saved().offerToSaveRestored, ["work"]);
  await setPasswordAutofillFor("work", false);
  assert.deepEqual(saved(), EMPTY, "your Off clears the mark");
  await launch();
  assert.equal(toggle("work"), false, "and the next launch leaves it off");
  counts();
});
