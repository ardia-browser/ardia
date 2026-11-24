import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_COVER, pageCoverNeeded } from "./pageCover.ts";

test("the cover shows unless the page is already live and settled with no saved picture, as Compose's PageCover decides", () => {
  assert.equal(pageCoverNeeded(null, false), true);
  assert.equal(pageCoverNeeded({ isLive: false, isLoading: false }, false), true);
  assert.equal(pageCoverNeeded({ isLive: true, isLoading: true }, false), true);
  assert.equal(pageCoverNeeded({ isLive: true, isLoading: false }, false), false);
  assert.equal(pageCoverNeeded({ isLive: true, isLoading: false }, true), true);
});

test("the cover waits at most four seconds, settles 150 ms on a page that was already loaded, fades in 180 ms, and on iPhone gives up waiting for a loaded page's draw after a second", () => {
  assert.deepEqual(PAGE_COVER, { deadlineMs: 4_000, settleMs: 150, fadeMs: 180, paintDeadlineMs: 1_000 });
});
