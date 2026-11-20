import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0, passwordManager: "none" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a switch back to Ardia that couldn't reach its profile is finished after a relaunch, and a person's own off stays off", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const work = S().createProfile({ name: "Work" });
  S().updateProfile(work, { passwordManager: "none" });
  startPlugins();
  stub.pluginHost.folders = [];
  await lifecycle.rescanPlugins(consentToken());
  const first = await import("./passwordManager.ts?launch=1");
  first.startPasswordManager();
  await settle();
  assert.equal(stub.profileToggles.user.get(work)?.passwords, false, "None turned Work's offer to save off");
  assert.equal(stub.profileToggles.user.get("")?.passwords, false);

  stub.profileToggles.unloadable.add(work);
  first.choosePasswordManager(work, "ardia");
  first.choosePasswordManager("default", "ardia");
  await settle();
  const { setPasswordAutofillFor } = await import("../settings/paneData.ts");
  await setPasswordAutofillFor("", false);
  assert.equal(stub.profileToggles.user.get(work)?.passwords, false, "Work couldn't load, so it's still off");
  assert.match(stub.docs.get("password-manager.json") ?? "", new RegExp(work), "and its record wasn't cleared, since the pref couldn't follow");

  stub.profileToggles.unloadable.delete(work);
  const relaunched = await import("./passwordManager.ts?launch=2");
  relaunched.startPasswordManager();
  await settle();
  assert.equal(stub.profileToggles.user.get(work)?.passwords, true, "after the relaunch Ardia mode puts Work's offer to save back");
  assert.equal(stub.profileToggles.user.get("")?.passwords, false, "Personal's off was the person's own and stays");
});
