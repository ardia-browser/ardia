import assert from "node:assert/strict";
import { test } from "node:test";
import { notePageFavicon, takePageFaviconCounts } from "./pageFaviconCounts.ts";

test("each favicon a page announces is counted, and those that came back with no image are counted again as empty", () => {
  takePageFaviconCounts();
  assert.equal(notePageFavicon("data:image/png;base64,AA=="), "data:image/png;base64,AA==");
  assert.equal(notePageFavicon(null), null);
  assert.equal(notePageFavicon(null), null);
  assert.deepEqual(takePageFaviconCounts(), { page_favicon_downloads: 3, page_favicon_downloads_empty: 2 });
  assert.deepEqual(takePageFaviconCounts(), { page_favicon_downloads: 0, page_favicon_downloads_empty: 0 });
});
