import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const pm = await import("./passwordManager.ts");

const S = () => useBrowser.getState();
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const pushed = () => stub.passwordProviders.calls.filter((c) => c[0] === "setApplePasswordsProfiles").map((c) => c[1]);

test("native learns which engine profiles picked Apple Passwords, once per change, and forgets one that switches back", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const work = S().createProfile({ name: "Work" });
  const shared = S().createProfile({ name: "Shared", shareWith: work });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  startPlugins();
  stub.pluginHost.folders = [];
  await lifecycle.rescanPlugins(consentToken());
  pm.startPasswordManager();
  await settle();

  pm.choosePasswordManager(work, "apple");
  await settle();
  assert.equal(S().profiles[shared].passwordManager, "apple", "profiles sharing data share the choice");
  assert.deepEqual(pushed(), [[], [work]], "native starts from what JS holds, then the shared engine profile is pushed once");

  pm.choosePasswordManager("default", "apple");
  await settle();
  assert.deepEqual(pushed().at(-1), ["", work]);

  pm.choosePasswordManager(work, "ardia");
  await settle();
  assert.deepEqual(pushed().at(-1), [""]);
  assert.equal(pushed().length, 4);
});
