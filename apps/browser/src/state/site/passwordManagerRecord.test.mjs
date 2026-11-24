import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const { choosePasswordManager, startPasswordManager } = await import("./passwordManager.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const passwords = () => stub.profileToggles.user.get("")?.passwords;

test("offer to save goes off only after its record has landed, and comes back on with the record kept until a later launch confirms it", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  startPlugins();
  stub.pluginHost.folders = [];
  await lifecycle.rescanPlugins(consentToken());
  startPasswordManager();
  await settle();

  stub.heldSaves.on = true;
  choosePasswordManager("default", "none");
  await settle();
  assert.notEqual(passwords(), false, "the record hasn't landed, so offer to save is still on");
  stub.heldSaves.on = false;
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await settle();
  assert.equal(passwords(), false, "once it has, the pref goes off");
  assert.match(stub.docs.get("password-manager.json") ?? "", /"offerToSaveHeldOff":\[""\]/);

  stub.heldSaves.on = true;
  choosePasswordManager("default", "ardia");
  await settle();
  assert.equal(passwords(), true, "the pref goes on while the record still holds the profile, so a crash before Chrome writes it sets it again next launch");
  assert.doesNotMatch(stub.docs.get("password-manager.json") ?? "", /offerToSaveRestored/);
  stub.heldSaves.on = false;
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await settle();
  assert.equal(passwords(), true);
  assert.match(stub.docs.get("password-manager.json") ?? "", /"offerToSaveHeldOff":\[""\],"offerToSaveRestored":\[""\]/, "marked, and left for a later launch to confirm");

  stub.refusedSaves.on = true;
  try {
    choosePasswordManager("default", "none");
    await settle();
    assert.equal(passwords(), true, "the Off waits for its own record, so offer to save stays on");
    choosePasswordManager("default", "ardia");
    await settle();
    assert.equal(passwords(), true, "so switching back to Ardia finds it on");
  } finally {
    stub.refusedSaves.on = false;
  }
});
