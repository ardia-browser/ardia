import assert from "node:assert/strict";
import test from "node:test";
import { designFor } from "./design.ts";

test("iPhone is always redesigned, and Android only when the lab asks for it", () => {
  assert.equal(designFor("ios"), "redesigned");
  assert.equal(designFor("android"), "original");
  assert.equal(designFor("android", true), "redesigned");
  assert.equal(designFor("ios", false), "redesigned");
});
