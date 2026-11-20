import assert from "node:assert/strict";
import { test } from "node:test";
import { noteWindowRoot, takeWindowRootCounts } from "./windowRootCounts.ts";

test("a window whose interface starts while another copy of it is still up is counted once per extra copy", () => {
  takeWindowRootCounts();
  const first = noteWindowRoot("w-1");
  const other = noteWindowRoot("w-2");
  const second = noteWindowRoot("w-1");
  assert.deepEqual(takeWindowRootCounts(), { window_roots_doubled: 1, window_title_band_presses: 0, window_title_band_text_presses: 0 });
  second();
  const again = noteWindowRoot("w-1");
  assert.deepEqual(takeWindowRootCounts(), { window_roots_doubled: 1, window_title_band_presses: 0, window_title_band_text_presses: 0 });
  first();
  again();
  other();
  noteWindowRoot("w-1")();
  assert.deepEqual(takeWindowRootCounts(), { window_roots_doubled: 0, window_title_band_presses: 0, window_title_band_text_presses: 0 });
});
