import assert from "node:assert/strict";
import { test } from "node:test";
import { luminance } from "../../lib/color.ts";
import { touchRetryInk, vaultHighlight } from "./highlight.ts";

const DARK_GLASS = "#3F3F3F";
const LIGHT_GLASS = "#DBDBDB";
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const ink = (h) => (h.onLight ? "#000000" : "#FFFFFF");

test("the selected row takes the site's colour when the frame does, else the system accent", () => {
  assert.equal(vaultHighlight("#1A73E8", true, "#0A84FF", "#1E1E1E").fill, "#1A73E8");
  assert.equal(vaultHighlight("#1A73E8", false, "#0A84FF", "#1E1E1E").fill, "#0A84FF");
  assert.equal(vaultHighlight(null, true, "#0A84FF", "#1E1E1E").fill, "#0A84FF");
  assert.equal(vaultHighlight("rgb(1,2,3)", true, "#0A84FF", "#1E1E1E").fill, "#0A84FF");
});

test("a page or frame colour without hue, or too close to the menu, gives way to the system accent with white text", () => {
  const plain = ["#F4F5F7", "#FFFFFF", "#E6E6E6", "#717171", "#8E8E93", "#1C1C1E", "#000000", "#E8F0FE"];
  for (const surface of [DARK_GLASS, LIGHT_GLASS])
    for (const color of plain) {
      const h = vaultHighlight(color, true, "#0A84FF", surface);
      assert.equal(h.fill, "#0A84FF", `${color} on ${surface}`);
      assert.equal(h.onLight, false, `${color} on ${surface}: white text`);
    }
  assert.equal(vaultHighlight("#FFD60A", true, "#0A84FF", DARK_GLASS).fill, "#FFD60A", "yellow stands out on the dark menu");
  assert.equal(vaultHighlight("#FFD60A", true, "#0A84FF", LIGHT_GLASS).fill, "#0A84FF", "yellow vanishes on the light menu");
});

test("a brand colour that stands apart keeps its colour and readable text in both appearances", () => {
  const brands = ["#1A73E8", "#FF3B30", "#34C759", "#5856D6", "#7A1F1F", "#00A86B"];
  for (const surface of [DARK_GLASS, LIGHT_GLASS])
    for (const color of brands) {
      const h = vaultHighlight(color, true, "#0A84FF", surface);
      if (h.fill === "#0A84FF") continue;
      assert.ok(ratio(ink(h), h.fill) >= 4.5, `${color} on ${surface}: text ${ratio(ink(h), h.fill).toFixed(2)}`);
      assert.ok(ratio(h.fill, surface) >= 1.6, `${color} on ${surface}: apart ${ratio(h.fill, surface).toFixed(2)}`);
    }
  assert.equal(vaultHighlight("#1A73E8", true, "#0A84FF", DARK_GLASS).fill, "#1A73E8");
  assert.equal(vaultHighlight("#1A73E8", true, "#0A84FF", LIGHT_GLASS).fill, "#1A73E8");
});

test("a light brand colour is deepened until white text reads on it, keeping its hue", () => {
  for (const surface of [DARK_GLASS, LIGHT_GLASS]) {
    const h = vaultHighlight("#A78BFA", true, "#0A84FF", surface);
    assert.notEqual(h.fill, "#0A84FF", surface);
    assert.equal(h.onLight, false, surface);
    assert.ok(ratio("#FFFFFF", h.fill) >= 4.5, `${surface}: ${h.fill}`);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.fill.slice(i, i + 2), 16));
    assert.ok(b > r && r > g, `${h.fill} is still purple`);
  }
});

test("the accent fallback reads with white text, and a pale accent gets black text", () => {
  for (const surface of [DARK_GLASS, LIGHT_GLASS]) {
    const blue = vaultHighlight(null, true, "#0A84FF", surface);
    assert.equal(blue.onLight, false);
    assert.ok(ratio("#FFFFFF", blue.fill) >= 3, surface);
  }
  const pale = vaultHighlight(null, true, "#FFD60A", DARK_GLASS);
  assert.equal(pale.onLight, true);
  assert.ok(ratio("#000000", pale.fill) >= 4.5);
});

test("the Touch ID retry glyph is red where red reads, and white on a red disc on a fill it doesn't", () => {
  const RED = "#FF3B30";
  assert.deepEqual(touchRetryInk(null, RED), { glyph: RED, disc: null });
  assert.deepEqual(touchRetryInk("#FFFFFF", RED), { glyph: RED, disc: null });
  const onBlue = touchRetryInk("#0A84FF", RED);
  assert.equal(onBlue.disc, RED, "red on an accent highlight is too close to read");
  assert.ok(ratio(onBlue.glyph, onBlue.disc) >= 3);
  for (const fill of ["#0A84FF", "#FF2D55", "#34C759", "#FFD60A", "#1C1C1E"]) {
    const shown = touchRetryInk(fill, RED);
    assert.ok(ratio(shown.glyph, shown.disc ?? fill) >= 3, fill);
  }
});
