import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const { choosePasswordManager, startPasswordManager } = await import("./passwordManager.ts");
const { setPasswordAutofillFor } = await import("../settings/paneData.ts");

const S = () => useBrowser.getState();
const DOC = "password-manager.json";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const passwords = () => stub.profileToggles.user.get("")?.passwords;
const heldOff = (text) => (text ? JSON.parse(text).offerToSaveHeldOff : []);

test("your Off replaces a hold-off save native still holds to retry, so that stale save can't land later and turn saving back on", async () => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  startPlugins();
  stub.pluginHost.folders = [];
  await lifecycle.rescanPlugins(consentToken());
  startPasswordManager();
  await settle();

  stub.refusedSaves.on = true;
  choosePasswordManager("default", "none");
  await settle();
  stub.refusedSaves.on = false;
  assert.notEqual(passwords(), false, "no durable record, so saving stays on");
  assert.deepEqual(heldOff(stub.stagedDocs.get(DOC)), [""], "native still holds the failed save to retry");

  choosePasswordManager("default", "ardia");
  await settle();
  await setPasswordAutofillFor("", false);
  await settle();
  assert.equal(passwords(), false);
  assert.equal(stub.stagedDocs.has(DOC), false, "the stale save was replaced by a newer one");
  assert.deepEqual(heldOff(stub.docs.get(DOC)), [], "and the record on disk doesn't hold the profile");
});

test("a confirmation clear native lands only on a retry doesn't let a later Off trust the stale entry", async () => {
  stub.docs.set(DOC, JSON.stringify({ offerToSaveHeldOff: [""], offerToSaveRestored: [""], version: 1 }));
  stub.profileToggles.user.set("", { passwords: true });
  S().updateProfile("default", { passwordManager: "ardia" });
  stub.refusedSaves.on = true;
  const relaunched = await import("./passwordManager.ts?launch=2");
  relaunched.startPasswordManager();
  await settle();
  assert.deepEqual(heldOff(stub.stagedDocs.get(DOC)), [], "the clear is staged, not landed");
  stub.docs.set(DOC, stub.stagedDocs.get(DOC));
  stub.stagedDocs.delete(DOC);
  relaunched.choosePasswordManager("default", "none");
  await settle();
  stub.refusedSaves.on = false;
  assert.equal(passwords(), true, "the record on disk may no longer hold the profile, so the Off waits for its own record");
});
