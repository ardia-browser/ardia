import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FILM_GRAIN_POINTS, FILM_GRAIN_SIDE, filmGrainAlpha, filmGrainHash, filmGrainOpacity, filmGrainSize } from "./shims/web/gl/themeSwatch.ts";

const fract = (v) => v - Math.floor(v);
function metalGrainHash(x, y) {
  const p3 = [fract(x * 0.1031), fract(y * 0.1031), fract(x * 0.1031)];
  const yzx = [p3[1] + 33.33, p3[2] + 33.33, p3[0] + 33.33];
  const d = p3[0] * yzx[0] + p3[1] * yzx[1] + p3[2] * yzx[2];
  const q = p3.map((v) => v + d);
  return fract((q[0] + q[1]) * q[2]);
}

test("film grain uses WindowBackdropView's grainHash for every tile cell", () => {
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [17, 93], [127, 127]]) assert.equal(filmGrainHash(x, y), metalGrainHash(x, y));
  const bytes = filmGrainAlpha();
  assert.equal(bytes.length, FILM_GRAIN_SIDE * FILM_GRAIN_SIDE * 4);
  for (let i = 0; i < FILM_GRAIN_SIDE * FILM_GRAIN_SIDE; i++) {
    assert.equal(bytes[i * 4] + bytes[i * 4 + 1] + bytes[i * 4 + 2], 0);
    const x = i % FILM_GRAIN_SIDE, y = Math.floor(i / FILM_GRAIN_SIDE);
    assert.equal(bytes[i * 4 + 3], Math.round((1 - metalGrainHash(x, y)) * 255));
  }
  const distinct = new Set(Array.from({ length: FILM_GRAIN_SIDE * FILM_GRAIN_SIDE }, (_, i) => bytes[i * 4 + 3]));
  assert.ok(distinct.size > 200, "the tile is real per-pixel noise, not a flat wash");
});

test("grain opacity and scale clamp like the Metal uniforms", () => {
  assert.equal(filmGrainOpacity(0.09), 0.09);
  assert.equal(filmGrainOpacity(-1), 0);
  assert.equal(filmGrainOpacity(3), 1);
  assert.equal(filmGrainOpacity(Number.NaN), 0);
  assert.equal(filmGrainSize(1), FILM_GRAIN_POINTS);
  assert.equal(filmGrainSize(2), FILM_GRAIN_POINTS * 2);
  assert.equal(filmGrainSize(0), FILM_GRAIN_POINTS * 0.25);
});

test("stock-preset vibrancy renders a crisp grain layer over its gradient", async (t) => {
  const painted = [];
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (image) => painted.push(image.data) }),
      toDataURL: () => "data:image/png;base64,GRAIN",
    }),
  };
  t.after(() => { globalThis.document = previous; });
  const { Vibrancy } = await import("./shims/web/gl/Vibrancy.tsx");
  const html = renderToStaticMarkup(createElement(Vibrancy, { dark: false, grainOpacity: 0.09, grainScale: 1 }));
  assert.match(html, /data-ardia-film-grain/);
  assert.match(html, /opacity:0\.09/);
  assert.match(html, /background-size:128px 128px/);
  assert.equal(FILM_GRAIN_POINTS, FILM_GRAIN_SIDE, "one grain cell per point, as WindowBackdropView draws it");
  assert.match(html, /image-rendering:pixelated/);
  assert.match(html, /GRAIN/);
  assert.equal(painted.length, 1);
  assert.deepEqual(painted[0], filmGrainAlpha());
  assert.doesNotMatch(renderToStaticMarkup(createElement(Vibrancy, { dark: true, grainOpacity: 0 })), /data-ardia-film-grain/);
});

test("both WindowBackdrop shims hand the preset grain to vibrancy and the behind-window treatment", () => {
  const desktop = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(desktop, /<Vibrancy [^>]*grainOpacity=\{grainOpacity\} grainScale=\{grainScale\}/);
  assert.match(desktop, /treatment \? <FilmGrain grainOpacity=\{grainOpacity\} grainScale=\{grainScale\} \/>/);
  const demo = readFileSync(new URL("../../../packages/demo/src/shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(demo, /<Vibrancy [^>]*grainOpacity=\{grainOpacity\} grainScale=\{grainScale\}/);
  for (const file of ["web/gl/Vibrancy.tsx", "web/gl/themeSwatch.ts"]) {
    assert.equal(readFileSync(new URL(`./shims/${file}`, import.meta.url), "utf8"), readFileSync(new URL(`../../../packages/demo/src/shims/${file}`, import.meta.url), "utf8"), file);
  }
});
