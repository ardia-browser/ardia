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

test("the cover waits at most four seconds, settles 150 ms on a page that was already loaded, and fades in 180 ms", () => {
  assert.deepEqual(PAGE_COVER, { deadlineMs: 4_000, settleMs: 150, fadeMs: 180 });
});
