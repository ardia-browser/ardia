import assert from "node:assert/strict";
import { test } from "node:test";
const { createStripDrags } = await import("./stripPointer.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("blur, a fold or the strip going away cancels the hand-off in flight, and a second press cancels the first", () => {
  const log = [];
  const target = (name) => ({ begin: () => log.push(`${name}:begin`), move: () => {}, end: () => log.push(`${name}:end`), cancel: () => log.push(`${name}:cancel`) });
  const drags = createStripDrags();
  const a = drags.track(target("a"));
  const b = drags.track(target("b"));
  a.begin(1, 1);
  b.begin(2, 2);
  drags.cancelAll();
  drags.cancelAll();
  assert.deepEqual(log, ["a:begin", "a:cancel", "b:begin", "b:cancel"]);
  b.begin(3, 3);
  b.end(true);
  drags.cancelAll();
  assert.deepEqual(log.slice(4), ["b:begin", "b:end"], "a finished drag is not cancelled after the fact");
});
