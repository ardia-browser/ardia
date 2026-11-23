import assert from "node:assert/strict";
import { test } from "node:test";
const { homeRelative } = await import("./homePath.ts");

test("a path in a home folder reads from ~", () => {
  assert.equal(homeRelative("/Users/me/Downloads"), "~/Downloads");
  assert.equal(homeRelative("/Users/me"), "~");
  assert.equal(homeRelative("/Users/me/"), "~/");
  assert.equal(homeRelative("/Volumes/Disk/Users/me"), "/Volumes/Disk/Users/me");
  assert.equal(homeRelative("/Users/"), "/Users/");
  assert.equal(homeRelative("/tmp/x"), "/tmp/x");
  assert.equal(homeRelative(""), "");
});
