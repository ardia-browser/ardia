import assert from "node:assert/strict";
import { test } from "node:test";
import { revealOffset } from "./revealScroll.ts";
import { settingsReveal } from "./tokens.ts";

const REVEAL_INSET = settingsReveal.inset;
const SECTION_HEADER_GAP = settingsReveal.headerGap;

const base = { headerTops: [], scrollTop: 0, viewport: 500, contentHeight: 3000 };

test("a row already in view with its header doesn't scroll", () => {
  assert.equal(revealOffset({ ...base, rowTop: 200, rowHeight: 40, headerTop: 150 }), null);
});

test("a jump puts the row's section header text the inset below the top", () => {
  assert.equal(revealOffset({ ...base, rowTop: 1200, rowHeight: 40, headerTop: 1100 }), 1100 + SECTION_HEADER_GAP - REVEAL_INSET);
});

test("a row too far below its header gets the inset itself", () => {
  assert.equal(revealOffset({ ...base, rowTop: 1900, rowHeight: 40, headerTop: 1100 }), 1900 - REVEAL_INSET);
});

test("near the end it stops on an earlier header instead of cutting a label at the top", () => {
  const offset = revealOffset({ ...base, contentHeight: 2000, rowTop: 1880, rowHeight: 40, headerTop: 1800, headerTops: [900, 1300, 1450, 1800] });
  assert.equal(offset, 1450 + SECTION_HEADER_GAP - REVEAL_INSET);
});

test("with no header that fits it falls back to the end", () => {
  assert.equal(revealOffset({ ...base, contentHeight: 2000, rowTop: 1880, rowHeight: 40, headerTop: 1800, headerTops: [1800] }), 1500);
});
