import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "password-manager-review-3");
const offer = await import("./offerToSave.ts");
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
const record = () => JSON.parse(stub.docs.get("password-manager.json") ?? "{}").offerToSaveHeldOff ?? [];
const folder = (name) => ({ name, status: "ok", text: MANIFEST.replace('"password-manager"', JSON.stringify(name)) });

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
  stub.pluginHost.folders = [folder("one-pm")];
  await lifecycle.rescanPlugins(consentToken());
  pm.startPasswordManager();
  turnOn("one-pm");
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  await wait(50);
  assert.equal(offerToSave(""), false);
});

for (const [why, arm] of [
  ["a rejection", () => (native.rejectNext = 1)],
  ["applied: false", () => (native.notAppliedNext = 1)],
  ["a reply without applied", () => (native.bareReplyNext = 1)],
]) {
  test(`a: after ${why}, Off waits for native's confirmation (or the deadline) and the push is retried`, async () => {
    turnOn("one-pm");
    await settle();
    await wait(50);
    arm();
    native.calls.length = 0;
    const started = Date.now();
    assert.ok(await lifecycle.turnOffPlugin("one-pm", consentToken()));
    const waited = Date.now() - started;
    assert.ok(waited >= 800, `committed after ${waited} ms`);
    await wait(1500);
    assert.ok(pushes().length >= 2, `retried: ${pushes().length}`);
    assert.deepEqual(native.profiles, []);
  });
}

test("b: plugin → Ardia → plugin while the record can't be written keeps the profile in the record, leaves saving on, and a timer turns it off once the record lands", async () => {
  offer.OFFER_TO_SAVE_RETRY.firstMs = 50;
  turnOn("one-pm");
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  await wait(1200);
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
  assert.ok(record().includes(""), "never dropped from the record, so a restart still knows Ardia turned it off");
  assert.equal(offerToSave(""), true, "the Off waits until its own record lands");
  stub.refusedSaves.on = false;
  await wait(400);
  assert.ok(record().includes(""));
  assert.equal(offerToSave(""), false, "the timer finished the Off");
});
