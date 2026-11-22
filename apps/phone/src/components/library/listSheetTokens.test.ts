import assert from "node:assert/strict";
import { test } from "node:test";
import { listRowLayout, listRowTitleLines } from "./listSheetTokens.ts";

const roomy = 320;

test("a native list row's title takes one line at normal sizes and up to three from the large-text threshold, for Spaces, Archive and the Library alike", () => {
  assert.equal(listRowTitleLines({ fontScale: 1, titleWidth: roomy }), 1);
  assert.equal(listRowTitleLines({ fontScale: 1, titleWidth: null }), 1);
  assert.equal(listRowTitleLines({ fontScale: listRowLayout.largeTextScale - 0.01, titleWidth: roomy * listRowLayout.largeTextScale }), 1);
  assert.equal(listRowTitleLines({ fontScale: listRowLayout.largeTextScale, titleWidth: roomy }), 3);
  assert.equal(listRowTitleLines({ fontScale: 3, titleWidth: roomy }), 3);
});

test("a narrow row's title gets a second line at ordinary text sizes, measured against the width the text scale needs, and large text keeps its three lines however narrow the row", () => {
  assert.equal(listRowTitleLines({ fontScale: 1, titleWidth: listRowLayout.narrowTitleWidth - 1 }), listRowLayout.narrowTitleLines);
  assert.equal(listRowTitleLines({ fontScale: 1, titleWidth: listRowLayout.narrowTitleWidth }), 1);
  assert.equal(listRowTitleLines({ fontScale: 1.2, titleWidth: listRowLayout.narrowTitleWidth }), listRowLayout.narrowTitleLines);
  assert.equal(listRowTitleLines({ fontScale: 1.2, titleWidth: listRowLayout.narrowTitleWidth * 1.2 }), 1);
  assert.equal(listRowTitleLines({ fontScale: listRowLayout.largeTextScale, titleWidth: 100 }), listRowLayout.largeTextTitleLines);
  assert.ok(listRowLayout.narrowTitleLines > listRowLayout.titleLines && listRowLayout.narrowTitleLines <= listRowLayout.largeTextTitleLines);
});
