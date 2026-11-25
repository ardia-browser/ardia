import assert from "node:assert/strict";
import { test } from "node:test";
const geometry = await import("./geometry.ts");

test("a live folder's header starts at its box's edge, as a group's does, so their icons and titles line up (#3003)", () => {
  assert.equal(geometry.LIVE_FOLDER_BOX_PAD + geometry.LIVE_FOLDER_HEADER_MARGIN, 0);
});
