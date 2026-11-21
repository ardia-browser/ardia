import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, rgbOf, weakest } from "../lib/contrast.ts";
import { BANDS, INK_FLOOR, pairs, paintCss, tokensOf, type BandName } from "./paint.ts";

const names = Object.keys(BANDS) as BandName[];
const groundsOf = (name: BandName) => BANDS[name].stops.map(([colour]) => rgbOf(colour));

test("every colour a band hands out clears its contrast floor on every stop of that band's paint", () => {
  const failing = pairs()
    .filter((pair) => pair.ratio < pair.need)
    .map((pair) => `${pair.band} ${pair.token} on ${pair.ground}: ${pair.ratio.toFixed(2)} of ${pair.need}`);
  assert.deepEqual(failing, []);
});

test("no band is painted in the middle greys: its ink clears the ink floor on every stop", () => {
  for (const name of names) {
    const ratio = weakest(rgbOf(tokensOf(name).ink), groundsOf(name));
    assert.ok(ratio >= INK_FLOOR, `${name}: ink reaches only ${ratio.toFixed(2)}`);
  }
});

test("body, secondary and label text stay three distinct steps on every band", () => {
  for (const name of names) {
    const grounds = groundsOf(name);
    const { ink, ink2, ink3 } = tokensOf(name);
    const [first, second, third] = [ink, ink2, ink3].map((colour) => weakest(rgbOf(colour), grounds));
    assert.ok(first / second >= 1.15, `${name}: secondary text is too close to the main ink (${first.toFixed(2)} vs ${second.toFixed(2)})`);
    assert.ok(second / third >= 1.12, `${name}: label text is too close to secondary text (${second.toFixed(2)} vs ${third.toFixed(2)})`);
  }
});

test("buttons keep their label readable on every band", () => {
  for (const name of names) {
    const { ink, inkOn } = tokensOf(name);
    assert.ok(contrast(rgbOf(ink), rgbOf(inkOn)) >= 7, `${name}: --ink-on on --ink`);
  }
});

test("paint tokens are scoped to painted sections only", () => {
  assert.doesNotMatch(paintCss(), /data-band/);
});
