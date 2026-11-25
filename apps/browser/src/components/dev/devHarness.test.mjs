import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { devPluginSeams } = await import("./devHarness.ts");

test("a Release build's harness has no way to turn a plugin on", () => {
  assert.equal(globalThis.__DEV__, false);
  assert.equal(devPluginSeams(), null, "no plugin store, consent or enable seam outside a Debug build");
});
