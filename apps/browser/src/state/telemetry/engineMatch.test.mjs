import assert from "node:assert/strict";
import { test } from "node:test";
const { engineMatchProperties } = await import("./engineMatch.ts");
const { WHATS_SENT } = await import("./copy.ts");

test("app_launched carries the engine match the build stamped, from its fixed list only", () => {
  for (const match of ["exact", "nearest", "local", "unknown"]) assert.deepEqual(engineMatchProperties(match), { engine_match: match });
});

test("a build with no stamp, or anything else in the stamp, adds nothing", () => {
  for (const value of [undefined, null, "", "EXACT", "nearest ", "09fc41004ed8", 1, {}]) assert.deepEqual(engineMatchProperties(value), {});
});

test("What's Sent names the engine match beside launches", () => {
  const launches = WHATS_SENT.flatMap((group) => group.items).find((item) => item.startsWith("Launches, updates"));
  assert.match(launches ?? "", /engine/);
  assert.match(launches ?? "", /exact/);
  assert.match(launches ?? "", /nearest|older/);
  assert.match(launches ?? "", /built locally|local/);
  assert.match(launches ?? "", /couldn't look up/);
});
