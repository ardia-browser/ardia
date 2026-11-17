import assert from "node:assert/strict";
import { test } from "node:test";
const { translationMenuTitle } = await import("./translate.ts");

test("manual page translation is absent when the platform has no translator", () => {
  assert.equal(translationMenuTitle("https://example.com/", false), "");
  assert.equal(translationMenuTitle("https://example.com/", true), "");
});
