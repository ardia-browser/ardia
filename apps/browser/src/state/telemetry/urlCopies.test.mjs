import assert from "node:assert/strict";
import { test } from "node:test";
import { noteSelectedTabUrlsCopied, noteUrlCopied, takeUrlCopyCounts } from "./urlCopies.ts";

test("address copies are counted, those taken before the first page apart, and taking them starts over", () => {
  noteUrlCopied(false);
  noteUrlCopied(true);
  noteUrlCopied(true);
  noteSelectedTabUrlsCopied();
  assert.deepEqual(takeUrlCopyCounts(), { url_copies: 4, url_copies_while_pending: 2, url_copies_of_selected_tabs: 1 });
  assert.deepEqual(takeUrlCopyCounts(), { url_copies: 0, url_copies_while_pending: 0, url_copies_of_selected_tabs: 0 });
});
