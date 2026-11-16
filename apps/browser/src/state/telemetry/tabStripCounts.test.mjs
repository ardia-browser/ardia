import assert from "node:assert/strict";
import { test } from "node:test";
import { noteTabStripGroupToggle, noteTextOnlyRow, takeTabStripCounts } from "./tabStripCounts.ts";

test("group collapses and expands from the strip are counted, and taking them starts over", () => {
  noteTabStripGroupToggle();
  noteTabStripGroupToggle();
  noteTextOnlyRow();
  assert.deepEqual(takeTabStripCounts(), { tab_strip_group_toggles: 2, pinned_rows_made_text_only: 1 });
  assert.deepEqual(takeTabStripCounts(), { tab_strip_group_toggles: 0, pinned_rows_made_text_only: 0 });
});
