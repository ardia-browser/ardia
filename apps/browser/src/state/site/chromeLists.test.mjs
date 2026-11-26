import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0, passwordManager: "apple" };
const until = async (ok) => {
  const deadline = Date.now() + 2000;
  while (!ok() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
};
const hiddenBecomes = async (want) => {
  await until(() => JSON.stringify(stub.chromeLists.hidden) === JSON.stringify(want));
  return stub.chromeLists.hidden;
};

test("Chrome's own lists are hidden in exactly the engine profiles on Apple Passwords, and follow a change of choice", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const work = S().createProfile({ name: "Work" });
  S().updateProfile(work, { passwordManager: "none" });
  startPlugins();
  stub.pluginHost.folders = [];
  await lifecycle.rescanPlugins(consentToken());
  const { choosePasswordManager, startPasswordManager } = await import("./passwordManager.ts");
  startPasswordManager();
  assert.deepEqual(await hiddenBecomes([""]), [""], "the default profile is on Apple Passwords; Work, on None, keeps Chrome's lists");
  assert.notEqual(stub.profileToggles.user.get("")?.passwords, false, "and Chrome's offer to save is left on for it");
  await until(() => stub.profileToggles.user.get(work)?.passwords === false);
  assert.equal(stub.profileToggles.user.get(work)?.passwords, false, "while None turns it off");

  choosePasswordManager(work, "apple");
  assert.deepEqual(await hiddenBecomes(["", work].sort()), ["", work].sort());

  choosePasswordManager("default", "ardia");
  assert.deepEqual(await hiddenBecomes([work]), [work], "back on Ardia, Chrome's lists come back");
});
