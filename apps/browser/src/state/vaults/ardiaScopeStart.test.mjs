import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { startArdiaScope } = await import("./ardiaScope.ts");

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

test("when the scope starts before the plugin scan, the Default profile still reaches native as \"\" once the scan ends", async () => {
  useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  native.vaultFakes.ardiaProfiles.length = 0;
  startArdiaScope();
  await settle();
  assert.deepEqual(native.vaultFakes.ardiaProfiles.at(-1), [], "nothing is on Ardia before the scan");
  usePlugins.setState({ scanned: true });
  await settle();
  assert.deepEqual(native.vaultFakes.ardiaProfiles.at(-1), [""]);
});
