import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("an official plugin's blurb wraps to two lines beside its button instead of being cut to one", () => {
  const source = readFileSync(new URL("./OfficialPlugins.tsx", import.meta.url), "utf8");
  const lines = /<Text selectable=\{view\.failed\} lines=\{view\.failed \? undefined : (\d+)\}/.exec(source);
  assert.ok(lines, "the blurb's Text");
  assert.equal(Number(lines[1]), 2);
});
