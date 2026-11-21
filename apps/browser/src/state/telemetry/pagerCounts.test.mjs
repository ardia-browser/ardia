import assert from "node:assert/strict";
import { test } from "node:test";
import { noteProfileDotReorder, notePagerSettle, takePagerCounts } from "./pagerCounts.ts";

test("pager settles are counted, those that kept the profile apart, switcher reorders too, and taking them starts over", () => {
  notePagerSettle(true);
  notePagerSettle(false);
  notePagerSettle(false);
  noteProfileDotReorder();
  assert.deepEqual(takePagerCounts(), { profile_pager_settles: 3, profile_pager_settles_without_switch: 2, profile_dot_reorders: 1 });
  assert.deepEqual(takePagerCounts(), { profile_pager_settles: 0, profile_pager_settles_without_switch: 0, profile_dot_reorders: 0 });
});
