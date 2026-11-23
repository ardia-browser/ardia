import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;
const frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (run) => {
  const id = nextFrame++;
  frames.set(id, run);
  return id;
};
globalThis.cancelAnimationFrame = (id) => void frames.delete(id);
const frameAt = (at) => {
  now = at;
  const due = [...frames];
  frames.clear();
  for (const [, run] of due) run(now);
};

const client = await import("./client.ts");
const { consentToken } = await import("./consentPeriod.ts");
const { noteFoldMotion, takeFoldMotionCounts } = await import("./foldMotion.ts");
after(() => {
  client.setSharing(false, "settings");
  Date.now = realNow;
});

function sharing(on) {
  client.loadChoice();
  client.setSharing(on, "settings");
}

function fold(start, frameTimes, endAt, finished = true) {
  now = start;
  const timing = noteFoldMotion(150);
  for (const at of frameTimes) frameAt(at);
  now = endAt;
  timing.end(finished);
}

test("a fold counts once it finishes; a JS frame gap over 34 ms is a stutter, one 50 ms past its plan an overrun", () => {
  sharing(true);
  assert.ok(consentToken());
  takeFoldMotionCounts();
  fold(0, Array.from({ length: 18 }, (_, i) => (i + 1) * 8.3), 150);
  fold(1000, [1008, 1016, 1060, 1068, 1150], 1150);
  fold(2000, [2008, 2016, 2033, 2050, 2216], 2216);
  fold(3000, [3008], 3008, false);
  assert.deepEqual(takeFoldMotionCounts(), { sidebar_folds: 3, sidebar_fold_stutters: 2, sidebar_fold_overruns: 1 });
  assert.deepEqual(takeFoldMotionCounts(), { sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
});

test("a fold that starts with sharing off, or ends after the sharing period changed, is not counted", () => {
  sharing(false);
  fold(0, [8, 16], 150);
  sharing(true);
  now = 1000;
  const crossed = noteFoldMotion(150);
  sharing(false);
  sharing(true);
  now = 1150;
  crossed.end(true);
  assert.deepEqual(takeFoldMotionCounts(), { sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
});

test("counts from one sharing period are dropped when the period changes before they are sent", () => {
  sharing(true);
  takeFoldMotionCounts();
  fold(0, [8, 16, 100], 300);
  sharing(false);
  sharing(true);
  assert.deepEqual(takeFoldMotionCounts(), { sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
});
