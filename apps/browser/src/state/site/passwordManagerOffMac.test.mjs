import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
PLATFORM_FEATURES.systemPasswordManagers = false;
const { useBrowser } = await import("../browser/store.ts");
const { currentPasswordManager, startPasswordManager, passwordManagerSnapshot } = await import("./passwordManager.ts");

test("off the Mac, starting the password manager calls none of the Mac-only verbs and every profile reads as Ardia", async () => {
  useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "P", color: "plum", icon: null, createdAt: 0, passwordManager: "plugin:x" } }, profileOrder: ["default"] });
  stub.passwordProviders.calls.length = 0;
  startPasswordManager();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(stub.passwordProviders.calls, []);
  assert.equal(currentPasswordManager("default"), "ardia");
  assert.deepEqual(passwordManagerSnapshot(), {});
});
