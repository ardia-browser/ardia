import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins, commitPlugins } = await import("../plugins/store.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "password-manager-review-5");
const offer = await import("./offerToSave.ts");
const pm = await import("./passwordManager.ts");
const { setPasswordAutofillFor } = await import("../settings/paneData.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const offerToSave = (profile) => stub.profileToggles.user.get(profile)?.passwords;
const onDisk = () => JSON.parse(stub.docs.get("password-manager.json") ?? "{}").offerToSaveHeldOff ?? [];
const folder = (name) => ({ name, status: "ok", text: MANIFEST.replace('"password-manager"', JSON.stringify(name)) });
const native = stub.passwordProviders;
const pushedProfiles = () => native.calls.filter((c) => c[0] === "setFieldProviders").map((c) => c[2]);
const setPref = (on) => stub.profileToggles.user.set("", { ...stub.profileToggles.user.get(""), passwords: on });

test("setup", async () => {
  offer.OFFER_TO_SAVE_RETRY.firstMs = 30;
  offer.OFFER_TO_SAVE_RETRY.maxMs = 30;
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  startPlugins();
  stub.pluginHost.folders = [folder("one-pm")];
  await lifecycle.rescanPlugins(consentToken());
  pm.startPasswordManager();
  assert.ok(lifecycle.requestPluginConsent("one-pm"));
  assert.ok(lifecycle.enablePlugin("one-pm", P().consent.hash));
  pm.choosePasswordManager("default", "ardia");
  await settle();
  await wait(50);
  setPref(true);
});

test("a retry after a failed save never takes the staged copy for the saved record, so saving goes off only once the record is on disk", async () => {
  stub.refusedSaves.on = true;
  try {
    pm.choosePasswordManager("default", "plugin:one-pm");
    await settle();
    await wait(200);
    assert.ok(!onDisk().includes(""), "nothing reached disk");
    assert.equal(offerToSave(""), true, "saving stays on while the record isn't on disk");
  } finally {
    stub.refusedSaves.on = false;
  }
  await wait(200);
  assert.ok(onDisk().includes(""));
  assert.equal(offerToSave(""), false);
});

test("a second Off after a failed clear is refused too, while disk still says Ardia turned saving off", async () => {
  assert.ok(onDisk().includes(""));
  setPref(true);
  stub.refusedSaves.on = true;
  try {
    await setPasswordAutofillFor("", false);
    assert.equal(offerToSave(""), true, "first Off refused");
    await setPasswordAutofillFor("", false);
    assert.equal(offerToSave(""), true, "second Off refused as well");
  } finally {
    stub.refusedSaves.on = false;
  }
  await setPasswordAutofillFor("", false);
  assert.ok(!onDisk().includes(""));
  assert.equal(offerToSave(""), false);
});

test("an unrelated plugin commit while a withdrawal waits never pushes the plugin being turned off back", async () => {
  pm.choosePasswordManager("default", "plugin:one-pm");
  await settle();
  await wait(1100);
  assert.deepEqual(native.profiles.map((p) => p.profile), [""]);
  native.holdNext = new Promise(() => {});
  native.calls.length = 0;
  const off = lifecycle.turnOffPlugin("one-pm", consentToken());
  await settle();
  commitPlugins({ records: { ...P().records } });
  await settle();
  await wait(300);
  assert.ok(pushedProfiles().every((profiles) => !profiles.includes("")), JSON.stringify(pushedProfiles()));
  assert.ok(await off);
  await settle();
  await wait(1200);
  assert.deepEqual(native.profiles, [], "native has no provider once Off commits");
});

test("hovering a two-factor setup link shows only its scheme in the status bubble", async () => {
  const { hoverStatus } = await import("./verificationCodes.ts");
  assert.equal(hoverStatus("otpauth://totp/Site:me?secret=JBSWY3DPEHPK3PXP"), "otpauth:");
  assert.equal(hoverStatus("OTPAUTH-MIGRATION://offline?data=AB"), "otpauth-migration:");
  assert.equal(hoverStatus("https://site.example/otpauth://x"), "https://site.example/otpauth://x");
  assert.equal(hoverStatus(""), "");
  const source = readFileSync(new URL("../../components/window/TabWebView.tsx", import.meta.url), "utf8");
  assert.match(source, /patchPage\(tabId, status \? \{ status: hoverStatus\(status\), statusAtTop \} : \{ status \}\)/);
});
