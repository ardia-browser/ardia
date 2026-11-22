import assert from "node:assert/strict";
import { test } from "node:test";
import { notePageFavicon, notePageFaviconFailed, takePageFaviconCounts } from "./pageFaviconCounts.ts";
import { setConsentPeriod } from "./consentPeriod.ts";

setConsentPeriod(true, "page-favicon-test");

test("each favicon a page announces is counted, and those that came back with no image are counted again as empty", () => {
  takePageFaviconCounts();
  assert.equal(notePageFavicon("data:image/png;base64,AA=="), "data:image/png;base64,AA==");
  assert.equal(notePageFavicon(null), null);
  assert.equal(notePageFavicon(null), null);
  assert.deepEqual(takePageFaviconCounts(), { page_favicon_downloads: 3, page_favicon_downloads_empty: 2 });
  assert.deepEqual(takePageFaviconCounts(), { page_favicon_downloads: 0, page_favicon_downloads_empty: 0 });
});

test("a download that failed counts as one that came back empty, and its error is logged", () => {
  takePageFaviconCounts();
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => void warned.push(args);
  try {
    assert.equal(notePageFaviconFailed(new Error("no engine")), null);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(takePageFaviconCounts(), { page_favicon_downloads: 1, page_favicon_downloads_empty: 1 });
  assert.equal(warned.length, 1);
  assert.equal(warned[0][0], "[favicons] page download failed");
});

test("with sharing off, a favicon download or failure counts nothing", () => {
  takePageFaviconCounts();
  setConsentPeriod(false, null);
  try {
    notePageFavicon(null);
    notePageFavicon("data:image/png;base64,AA==", "page-favicon-test");
    const warn = console.warn;
    console.warn = () => {};
    try {
      notePageFaviconFailed(new Error("no engine"));
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(takePageFaviconCounts(), { page_favicon_downloads: 0, page_favicon_downloads_empty: 0 });
  } finally {
    setConsentPeriod(true, "page-favicon-test");
  }
});
