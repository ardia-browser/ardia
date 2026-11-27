import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });
const client = await import("./client.ts");
const { noteProfileDotReorder, notePagerRestSeenByWatch, notePagerSettle, notePagerSettleFrames, notePagerSwitchAfterRest, takePagerCounts } = await import("./pagerCounts.ts");
after(() => client.setSharing(false, "settings"));

const none = { profile_pager_settles: 0, profile_pager_settles_without_switch: 0, profile_dot_reorders: 0, profile_pager_switches_after_rest: 0, profile_pager_rests_seen_by_watch: 0, profile_pager_settles_sampled: 0, profile_pager_settle_frames: 0, profile_pager_settle_long_frames: 0, profile_pager_settles_with_long_frames: 0, profile_pager_settle_worst_gap_ms: 0 };

test("pager settles are counted, those that kept the profile apart, switcher reorders too, and taking them starts over", () => {
  notePagerSettle(true);
  notePagerSettle(false);
  notePagerSettle(false);
  noteProfileDotReorder();
  assert.deepEqual(takePagerCounts(), { ...none, profile_pager_settles: 3, profile_pager_settles_without_switch: 2, profile_dot_reorders: 1 });
  assert.deepEqual(takePagerCounts(), none);
});

test("switches the sidebar waited on until the pages rested, and rests only the watch saw, count while sharing was on when the swipe began", () => {
  client.setSharing(true, "onboarding");
  const consent = client.consentToken();
  notePagerSwitchAfterRest(consent);
  notePagerSwitchAfterRest(consent);
  notePagerRestSeenByWatch(consent);
  assert.deepEqual(takePagerCounts(), { ...none, profile_pager_switches_after_rest: 2, profile_pager_rests_seen_by_watch: 1 });
  client.setSharing(false, "settings");
  notePagerSwitchAfterRest(consent);
  notePagerRestSeenByWatch(client.consentToken());
  assert.deepEqual(takePagerCounts(), none);
});

test("the settle's frames, its late ones, the settles that had any and the worst gap count while sharing was on, and a pager that sends none counts nothing", () => {
  client.setSharing(true, "onboarding");
  const consent = client.consentToken();
  notePagerSettleFrames({ frames: 30, longFrames: 0, worstGapMs: 8.4 }, consent);
  notePagerSettleFrames({ frames: 28, longFrames: 2, worstGapMs: 33.3 }, consent);
  notePagerSettleFrames({}, consent);
  assert.deepEqual(takePagerCounts(), { ...none, profile_pager_settles_sampled: 2, profile_pager_settle_frames: 58, profile_pager_settle_long_frames: 2, profile_pager_settles_with_long_frames: 1, profile_pager_settle_worst_gap_ms: 33 });
  client.setSharing(false, "settings");
  notePagerSettleFrames({ frames: 30, longFrames: 3, worstGapMs: 50 }, consent);
  assert.deepEqual(takePagerCounts(), none);
});
