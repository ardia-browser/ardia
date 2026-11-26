import assert from "node:assert/strict";
import { test } from "node:test";

const { continuousCorners, radius } = await import("./tokens.ts");
const { DEFAULT_LOOK } = await import("../../lib/themeLook.ts");
const { setActiveLook } = await import("../../lib/activeLook.ts");
const { tabCloseRadius, tabRadius } = await import("../tabstrip/tokens.ts");

test("continuous corners retain the configured radius", () => {
  const previous = { ...DEFAULT_LOOK, radii: { ...DEFAULT_LOOK.radii, chrome: 14 } };
  setActiveLook(previous);
  try {
    assert.equal(tabRadius(), 14);
    assert.equal(tabCloseRadius(), 8);
    assert.deepEqual(continuousCorners(tabRadius()), { borderRadius: 14, borderCurve: "continuous" });
    assert.equal(radius.chrome, 14);
  } finally {
    setActiveLook(DEFAULT_LOOK);
  }
});
