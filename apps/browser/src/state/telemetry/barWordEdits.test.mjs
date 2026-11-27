import assert from "node:assert/strict";
import { test } from "node:test";
import { setConsentPeriod } from "./consentPeriod.ts";
import { noteBarWordEdit, takeBarWordEditCounts } from "./barWordEdits.ts";

const NONE = { bar_word_deletes: 0, bar_word_deletes_split_at_dot: 0, bar_word_moves: 0, bar_word_moves_split_at_dot: 0 };

test("bar word deletes and moves are counted, those that stopped at a dot apart, and taking them starts over", () => {
  setConsentPeriod(true, "e1");
  const token = "e1";
  noteBarWordEdit(token, "delete", true);
  noteBarWordEdit(token, "delete", false);
  noteBarWordEdit(token, "delete", true);
  noteBarWordEdit(token, "move", true);
  noteBarWordEdit(token, "move", false);
  noteBarWordEdit(token, "move", false);
  assert.deepEqual(takeBarWordEditCounts(), { bar_word_deletes: 3, bar_word_deletes_split_at_dot: 2, bar_word_moves: 3, bar_word_moves_split_at_dot: 1 });
  assert.deepEqual(takeBarWordEditCounts(), NONE);
});

test("an edit stamped in another consent period or with no stamp is not counted", () => {
  setConsentPeriod(true, "e2");
  noteBarWordEdit("e1", "delete", true);
  noteBarWordEdit(null, "move", false);
  assert.deepEqual(takeBarWordEditCounts(), NONE);
});
