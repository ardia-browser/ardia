import assert from "node:assert/strict";
import { test } from "node:test";
import { BADGE, badgeFrameOf, badgeGlyphOf, badgeLayoutOf, badgePressCounts, badgeShownFor } from "./fieldBadge.ts";

const AREA = { width: 1000, height: 700 };
const LOGIN = { x: 100, y: 200, width: 300, height: 32 };
const KEY = badgeGlyphOf("password");
const field = (over = {}) => ({ kind: "password", focused: true, main: true, origin: "https://example.com", rect: LOGIN, ...over });
const frame = (rect, over = {}) => badgeFrameOf(over.glyph ?? KEY, rect, over.zoom ?? 1, over.area ?? AREA, over.rtl ?? false, over.inset);
const near = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} vs ${b}`);
const onPixel = (n) => Number.isInteger(n * 2);

test("unknown kinds get no glyph, so a field Ardia can't fill never shows the icon", () => {
  assert.equal(badgeGlyphOf("search"), null);
  assert.equal(badgeGlyphOf(""), null);
  assert.equal(badgeGlyphOf(undefined), null);
  assert.equal(badgeGlyphOf("toString"), null);
});

test("each recognized field shows the sideways key or its own glyph, and the spoken label for what its menu offers", () => {
  assert.deepEqual(badgeGlyphOf("username"), { symbol: "key.horizontal.fill", plus: false, label: "Passwords" });
  assert.deepEqual(badgeGlyphOf("password"), { symbol: "key.horizontal.fill", plus: false, label: "Passwords" });
  assert.deepEqual(badgeGlyphOf("newPassword"), { symbol: "key.horizontal.fill", plus: true, label: "Passwords" });
  assert.equal(badgeGlyphOf("otp").label, "Verification Code");
  assert.notEqual(badgeGlyphOf("otp").symbol, "key.horizontal.fill");
  assert.equal(badgeGlyphOf("address").label, "Addresses");
  assert.equal(badgeGlyphOf("card").label, "Cards");
});

test("no icon without a focused, on-page, secure field and a connected manager", () => {
  assert.equal(badgeShownFor(null, true), false);
  assert.equal(badgeShownFor(field({ focused: false }), true), false);
  assert.equal(badgeShownFor(field({ rect: null }), true), false);
  assert.equal(badgeShownFor(field({ origin: "http://example.com" }), true), false);
  assert.equal(badgeShownFor(field(), false), false);
  assert.equal(badgeShownFor(field({ kind: "search" }), true), false);
});

test("a cross-origin subframe field never shows the icon, since the menu doesn't serve it", () => {
  assert.equal(badgeShownFor(field({ main: false }), true), false);
});

test("the icon steps aside when the page already draws something in the field's trailing edge", () => {
  assert.equal(badgeShownFor(field({ trailingTaken: true }), true), false);
});

test("a focused secure login field with a manager connected shows the icon", () => {
  assert.equal(badgeShownFor(field(), true), true);
  assert.equal(badgeShownFor(field({ origin: "http://localhost:8080" }), true), true);
});

test("the button is about 62% of the field's height, clamped to 18 to 24 pt, and at least square", () => {
  const f = frame(LOGIN);
  assert.equal(f.height, 20);
  assert.ok(f.width >= f.height && f.width <= 24, `width ${f.width}`);
  assert.equal(frame({ ...LOGIN, height: 24 }).height, BADGE.minHeight);
  assert.equal(frame({ ...LOGIN, height: 120 }).height, BADGE.maxHeight);
});

for (const kind of ["password", "newPassword", "otp", "address", "card"])
  for (const height of [18, 19, 20, 21, 22, 23, 24])
    test(`the ${kind} glyph sits centred in a ${height} pt button`, () => {
      const l = badgeLayoutOf(badgeGlyphOf(kind), height);
      const left = (l.plus ?? l.glyph).x;
      const right = l.width - (l.glyph.x + l.glyph.width);
      near(left, right, 0.5, "side padding");
      assert.ok(l.width >= height, "never narrower than tall");
      near(l.glyph.y + l.glyph.height / 2, height / 2, 0.5, "centred vertically");
      if (l.plus) assert.ok(l.plus.x + l.plus.width <= l.glyph.x, "the plus sits before the key, never on it");
      for (const ink of [l.glyph, l.plus].filter(Boolean)) assert.ok(onPixel(ink.imageX) && onPixel(ink.imageY), `${ink.name} on the 2x pixel grid`);
    });

test("the tile's trailing inset is the field's own text inset when the page reports one, else 6 pt", () => {
  const read = frame(LOGIN, { inset: { top: 1, bottom: 1, trailing: 11 } });
  assert.equal(read.x + read.width, LOGIN.x + LOGIN.width - 11);
  const fallback = frame(LOGIN);
  assert.equal(fallback.x + fallback.width, LOGIN.x + LOGIN.width - BADGE.fallbackInset);
  for (const trailing of [0, 1, 40, -3, NaN, Infinity]) {
    const f = frame(LOGIN, { inset: { top: 0, bottom: 0, trailing } });
    assert.equal(f.x + f.width, LOGIN.x + LOGIN.width - BADGE.fallbackInset, `trailing ${trailing}`);
  }
});

test("the tile centres on the field's content box, not its border box", () => {
  const f = frame({ ...LOGIN, height: 40 }, { inset: { top: 2, bottom: 10, trailing: 8 } });
  near(f.y + f.height / 2, LOGIN.y + 2 + (40 - 12) / 2, 0.25, "content centre");
  const squeezed = frame({ ...LOGIN, height: 32 }, { inset: { top: 14, bottom: 14, trailing: 8 } });
  near(squeezed.y + squeezed.height / 2, LOGIN.y + 16, 0.25, "falls back to the border box when the content box is shorter than the tile");
});

test("right-to-left fields put the tile on the leading edge instead", () => {
  assert.equal(frame(LOGIN, { rtl: true }).x, LOGIN.x + BADGE.fallbackInset);
  assert.equal(frame(LOGIN, { rtl: true, inset: { top: 0, bottom: 0, trailing: 9 } }).x, LOGIN.x + 9);
});

test("page zoom scales where the field is, its insets and how big the tile is", () => {
  const plain = frame(LOGIN, { inset: { top: 1, bottom: 1, trailing: 8 } });
  const zoomed = frame({ x: 50, y: 100, width: 150, height: 16 }, { zoom: 2, inset: { top: 0.5, bottom: 0.5, trailing: 4 } });
  assert.deepEqual(zoomed, plain);
});

test("fields under 20 pt tall, or too narrow to hold text and the tile, get no icon", () => {
  assert.equal(frame({ ...LOGIN, height: 19 }), null);
  assert.notEqual(frame({ ...LOGIN, height: 20 }), null);
  assert.equal(frame({ ...LOGIN, width: 60 }), null);
});

test("a field scrolled out of the web view, or only partly in it, hides the tile instead of pinning it to the edge", () => {
  assert.equal(frame({ ...LOGIN, y: -40 }), null);
  assert.equal(frame({ ...LOGIN, y: AREA.height - 10 }), null);
  assert.equal(frame({ ...LOGIN, x: AREA.width - 100 }), null);
  assert.equal(frame({ ...LOGIN, x: -250 }, { rtl: true }), null);
});

test("a rect the page lies about never puts the tile outside the web view or breaks layout", () => {
  for (const bad of [
    { x: NaN, y: 0, width: 300, height: 32 },
    { x: 0, y: Infinity, width: 300, height: 32 },
    { x: 0, y: 0, width: -300, height: 32 },
    { x: 0, y: 0, width: 300, height: -32 },
    { x: 1e12, y: 1e12, width: 1e12, height: 1e12 },
    { x: "1", y: 0, width: 300, height: 32 },
    { x: -5000, y: -5000, width: 20000, height: 20000 },
  ])
    assert.equal(frame(bad), null, JSON.stringify(bad));
  assert.equal(frame(LOGIN, { zoom: 0 }), null);
  assert.equal(frame(LOGIN, { area: { width: 0, height: 0 } }), null);
  assert.notEqual(frame(LOGIN, { inset: { top: "x", bottom: null, trailing: {} } }), null);
});

test("a second press inside the double-click window is ignored, so a double click settles open with no flicker", () => {
  assert.equal(badgePressCounts(1000, -Infinity), true);
  assert.equal(badgePressCounts(1000 + BADGE.doubleClickMs - 1, 1000), false);
  assert.equal(badgePressCounts(1000 + BADGE.doubleClickMs, 1000), true);
});
