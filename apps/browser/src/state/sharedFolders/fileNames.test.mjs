import assert from "node:assert/strict";
import { test } from "node:test";
const { fileKey, uniqueFileName } = await import("./tree.ts");

test("file names are reserved the way APFS compares them: Unicode normalization and case together", () => {
  const decomposed = "Café";
  assert.equal(fileKey("Café"), fileKey(decomposed));
  assert.equal(fileKey("CAFÉ"), fileKey(decomposed));
  assert.equal(uniqueFileName("Café", "dir", new Set([fileKey(decomposed)])), "Café 2");
  assert.equal(uniqueFileName("café", "link", new Set([fileKey("CAFÉ.webloc")])), "café 2.webloc");
  assert.equal(uniqueFileName("Plans", "dir", new Set([fileKey("Other")])), "Plans");
});
