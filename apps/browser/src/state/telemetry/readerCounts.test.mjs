import assert from "node:assert/strict";
import { test } from "node:test";
import { noteReaderCheck, noteReaderNoArticle, noteReaderOpened, takeReaderCounts } from "./readerCounts.ts";

test("reading mode counts opens, articles not found and the pages checked, then starts over", () => {
  noteReaderOpened();
  noteReaderOpened();
  noteReaderNoArticle();
  noteReaderCheck(true);
  noteReaderCheck(false);
  noteReaderCheck(false);
  assert.deepEqual(takeReaderCounts(), { reader_opens: 2, reader_no_article: 1, reader_pages_checked: 3, reader_pages_without_article: 2 });
  assert.deepEqual(takeReaderCounts(), { reader_opens: 0, reader_no_article: 0, reader_pages_checked: 0, reader_pages_without_article: 0 });
});
