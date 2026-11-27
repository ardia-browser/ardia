import assert from "node:assert/strict";
import { test } from "node:test";

const { askToSleep, forgetSleepAsks, noteShownAgain, noteTabReady, sleepAskedNow } = await import("./sleepAsks.ts");

function deferredAsk(id) {
  let answer;
  let settled;
  const done = askToSleep(id, () => new Promise((resolve) => (answer = resolve)), (result) => (settled = result));
  return { answer: (keptBy) => answer(keptBy), settled: async () => (await done, settled) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an answer for a tab whose view was replaced while the ask was out never counts the replacement as asleep", async () => {
  const pending = deferredAsk("replaced");
  await settle();
  forgetSleepAsks("replaced");
  noteTabReady("replaced");
  assert.equal(sleepAskedNow("replaced"), false, "the replacement isn't held by the old ask");
  pending.answer([]);
  const { keptBy, awakeMeanwhile, openedMeanwhile } = await pending.settled();
  assert.deepEqual(keptBy, []);
  assert.equal(awakeMeanwhile, true);
  assert.equal(openedMeanwhile, false, "the old ask doesn't credit the replacement's open as its reopen");
});

test("an ask whose tab was forgotten counts as stale even if no replacement loaded", async () => {
  const pending = deferredAsk("gone");
  await settle();
  forgetSleepAsks("gone");
  pending.answer([]);
  assert.equal((await pending.settled()).awakeMeanwhile, true);
});

test("a replacement's own ask isn't released by the old ask finishing", async () => {
  const old = deferredAsk("swap");
  await settle();
  forgetSleepAsks("swap");
  const fresh = deferredAsk("swap");
  await settle();
  old.answer([]);
  await old.settled();
  assert.equal(sleepAskedNow("swap"), true, "the fresh ask still holds the tab");
  fresh.answer([]);
  assert.equal((await fresh.settled()).awakeMeanwhile, false);
  assert.equal(sleepAskedNow("swap"), false);
});

test("generations never return to a value a pending ask captured, across tabs and after cleanup", async () => {
  noteShownAgain("a");
  noteTabReady("a");
  const pending = deferredAsk("a");
  await settle();
  forgetSleepAsks("a");
  const fresh = deferredAsk("a");
  await settle();
  noteShownAgain("b");
  noteTabReady("a");
  pending.answer([]);
  fresh.answer([]);
  assert.equal((await pending.settled()).awakeMeanwhile, true);
  const after = await fresh.settled();
  assert.equal(after.awakeMeanwhile, true, "the replacement became ready while its own ask was out");
  assert.equal(after.openedMeanwhile, false);
});
