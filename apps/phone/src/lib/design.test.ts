import assert from "node:assert/strict";
import test from "node:test";
import { designFor } from "./design.ts";

test("both phones are redesigned, with or without the lab switch", () => {
  assert.equal(designFor("ios"), "redesigned");
  assert.equal(designFor("android"), "redesigned");
  assert.equal(designFor("android", true), "redesigned");
  assert.equal(designFor("ios", false), "redesigned");
});

test("Material You is Android's only when its switch is on, and never the iPhone's", () => {
  assert.equal(designFor("android", false, true), "material");
  assert.equal(designFor("android", true, true), "material");
  assert.equal(designFor("android", false, false), "redesigned");
  assert.equal(designFor("ios", false, true), "redesigned");
});
