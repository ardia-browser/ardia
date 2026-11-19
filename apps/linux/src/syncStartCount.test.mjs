import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./syncEngine.ts", import.meta.url), "utf8");

test("every authority handover starts sync without counting unsettled starts, so closing windows never pauses it", () => {
  const starts = source.match(/engine\.startSync\([^)]*\)/g) ?? [];
  assert.deepEqual(starts, ["engine.startSync({ countStarts: false })"]);
  assert.match(source, /async function becomeAuthority[\s\S]*?engine\.startSync\(\{ countStarts: false \}\)/);
});
