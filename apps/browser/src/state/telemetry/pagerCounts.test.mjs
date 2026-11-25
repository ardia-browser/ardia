import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });
const client = await import("./client.ts");
const { noteProfileDotReorder, notePagerRestSeenByWatch, notePagerSettle, notePagerSwitchAfterRest, takePagerCounts } = await import("./pagerCounts.ts");
after(() => client.setSharing(false, "settings"));

const none = { profile_pager_settles: 0, profile_pager_settles_without_switch: 0, profile_dot_reorders: 0, profile_pager_switches_after_rest: 0, profile_pager_rests_seen_by_watch: 0 };

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
