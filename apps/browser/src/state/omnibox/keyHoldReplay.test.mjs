import assert from "node:assert/strict";
import { test } from "node:test";

const { keyHoldReplayForCheck, REPLAY_GUARD_MS } = await import("./keyHoldReplay.ts");
const { takeInlineCompletionCounts } = await import("../telemetry/inlineCompletionCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "key-hold-test");

test("a replay announced for a field holds completion off until it's over, and only for that field", () => {
  const { heard, replayingInto } = keyHoldReplayForCheck;
  heard(41, 3);
  assert.equal(replayingInto(41), true);
  assert.equal(replayingInto(42), false);
  heard(41, 0);
  assert.equal(replayingInto(41), false);
});

test("a lost end of replay can't leave completion off: the guard lets go after its deadline and is counted", async () => {
  const { heard, replayingInto } = keyHoldReplayForCheck;
  takeInlineCompletionCounts();
  const realSetTimeout = globalThis.setTimeout;
  let fire;
  globalThis.setTimeout = (fn, ms) => {
    assert.equal(ms, REPLAY_GUARD_MS);
    fire = fn;
    return 1;
  };
  try {
    heard(51, 2);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(replayingInto(51), true);
  fire();
  assert.equal(replayingInto(51), false);
  assert.equal(takeInlineCompletionCounts().command_bar_replay_guards_expired, 1);
});
