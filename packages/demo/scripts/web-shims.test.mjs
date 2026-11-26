import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { backdropFragment, haloFragment, powerUpFragment } from "../src/shims/web/gl/sources.ts";
import { frameSubscription, measuredSize, MIN_FRAME_INTERVAL, stepAnimation, wantsFrames } from "../src/shims/web/gl/viewClock.ts";
import { baseStops, FILM_GRAIN_POINTS, FILM_GRAIN_SIDE, filmGrainAlpha, filmGrainHash, filmGrainOpacity, filmGrainSize, GRAIN_SIDE, grainAlpha, overlayStops, padLayers, srgbFromOklab, SWATCH_SAMPLES, swatchColors } from "../src/shims/web/gl/themeSwatch.ts";
import { readFileSync } from "node:fs";
import { MENU_MARGIN, placeMenu } from "../src/shims/web/menuPlacement.ts";
import { oklab } from "../src/shims/web/gl/colors.ts";

test("web shims survive ticker failures, reject inherited palettes and enter a view under a still pointer", { timeout: 30_000 }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ardia-web-shims-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const server = await createServer({
    cacheDir,
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${server.resolvedUrls.local[0]}tests/web-shims.html`);
  await page.getByRole("button", { name: "Run checks" }).click();
  await page.waitForFunction(() => document.getElementById("results")?.textContent);
  const results = JSON.parse(await page.locator("#results").textContent());
  const cornerPixel = async (selector) => {
    const card = await page.locator(selector).boundingBox();
    const shot = await page.screenshot({ clip: { x: card.x, y: card.y, width: 12, height: 12 } });
    return page.evaluate(async (png) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return [...context.getImageData(4, 4, 1, 1).data];
    }, shot.toString("base64"));
  };
  const ringCorner = await cornerPixel("#ring > div");
  const coveredCorner = await cornerPixel("#ring-under > div");
  results.checks.siblingOverlayAboveRing = coveredCorner[0] > 200 && coveredCorner[1] < 60 && coveredCorner[2] < 60;
  results.checks.selectedRingCorner = ringCorner[2] > 200 && ringCorner[0] < 60;
  const dragAcross = async (id) => {
    const handle = page.locator(`#${id} [style*='height: 20px']`).first();
    await handle.scrollIntoViewIfNeeded();
    const track = await handle.boundingBox();
    const middle = track.y + track.height / 2;
    await page.mouse.move(track.x + track.width * 0.3, middle);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(track.x + track.width * (0.3 + step * 0.05), middle);
    await page.mouse.up();
    const dragged = await page.evaluate((key) => window.sliderValues[key], id);
    t.diagnostic(`slider drag ${id} ${JSON.stringify(dragged)}`);
    const live = dragged.filter((entry) => !entry.endsWith("!")).map(Number);
    return live.length === 11 && Math.abs(live[0] - 0.3) < 0.01 && Math.abs(live.at(-1) - 0.8) < 0.01 &&
      live.every((value, i) => i === 0 || value > live[i - 1]) && dragged.at(-1) === `${live.at(-1).toFixed(3)}!`;
  };
  results.checks.sliderFollowsDrag = await dragAcross("drag");
  const followsScrolled = await dragAcross("drag-far");
  const scrolled = await page.evaluate(() => [window.scrollX, window.scrollY]);
  results.checks.sliderFollowsDragScrolled = followsScrolled && scrolled[0] > 0 && scrolled[1] > 0;
  t.diagnostic(JSON.stringify(results));
  assert.deepEqual(results.checks, {
    pointerBeforeSubscriber: true,
    inheritedPalette: true,
    validPalette: true,
    clockSurvivesThrow: true,
    enterOnMount: true,
    fadeLabelStrikethrough: true,
    themeSwatchGradient: true,
    themeSwatchGrain: true,
    colorPad: true,
    themedBackdrop: true,
    darkVisualEffect: true,
    lightToastOnLightHud: true,
    darkToastOnDarkHud: true,
    hudCloseOnDarkHud: true,
    breathe: true,
    holdKeyLookQuiet: true,
    retinaStripeTile: true,
    retinaIconSharp: true,
    retinaMarkLogical: true,
    selectedRingCorner: true,
    siblingOverlayAboveRing: true,
    sliderFollowsDrag: true,
    sliderFollowsDragScrolled: true,
  });
});

const near = (actual, expected, slack = 1e-4) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} is not ${expected}`);

test("the demo's theme swatch reads at most three colours and blends the first two in Oklab", () => {
  assert.deepEqual(swatchColors([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 9, 9, 9, 9]), [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 0.5]]);
  assert.deepEqual(swatchColors([1, 0, 0]), []);
  const a = [0.79, 0.31, 0.95, 1];
  const b = [0.39, 0.48, 0.95, 1];
  const stops = baseStops([a, b]);
  assert.equal(stops.length, SWATCH_SAMPLES + 1);
  for (const i of [0, 1, 2]) near(stops[0].color[i], a[i], 2e-3);
  for (const i of [0, 1, 2]) near(stops.at(-1).color[i], b[i], 2e-3);
  const [la, lb] = [oklab(a), oklab(b)];
  const middle = srgbFromOklab([(la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2, (la[2] + lb[2]) / 2, 1]);
  assert.deepEqual(stops[SWATCH_SAMPLES / 2].color.map((v) => +v.toFixed(4)), middle.map((v) => +v.toFixed(4)));
  assert.equal(baseStops([a]).length, 2);
  assert.deepEqual(baseStops([]), []);
  assert.deepEqual(overlayStops([a, b]), []);
  assert.deepEqual(overlayStops([a, b, [0, 0, 1, 0.8]]), [{ offset: 0, color: [0, 0, 1, 0] }, { offset: 1, color: [0, 0, 1, 0.8] }]);
});

test("the demo's colour pad and grain tiles match the app's", () => {
  const pad = padLayers(0.5);
  assert.match(pad.wheel, /^conic-gradient\(from 90deg, hsl\(0 100% 50%\) 0deg, /);
  assert.equal(pad.centre, "radial-gradient(closest-side, rgba(128, 128, 128, 1), rgba(128, 128, 128, 0))");
  assert.match(padLayers(2).wheel, /hsl\(360 100% 100%\) 360deg\)$/);
  for (const texture of ["grain", "sand", "denim", "tweed", "unknown"]) {
    const bytes = grainAlpha(texture);
    assert.equal(bytes.length, GRAIN_SIDE * GRAIN_SIDE * 4);
    assert.ok(bytes.some((v, i) => i % 4 === 3 && v > 0), texture);
    assert.ok(bytes.every((v, i) => i % 4 === 3 || v === 0), texture);
  }
  assert.deepEqual(grainAlpha("sand"), grainAlpha("sand"));
  assert.notDeepEqual(grainAlpha("denim"), grainAlpha("tweed"));
});

test("the PowerUp and Halo shaders never call pow where ANGLE's D3D11 backend returns NaN for a zero or negative base", () => {
  const halo = haloFragment;
  const power = powerUpFragment;
  assert.doesNotMatch(halo, /pow\(w,/);
  assert.match(halo, /vec4 w2 = w \* w;\s*w = w2 \* w2;/);
  assert.doesNotMatch(power, /pow\(lms,/);
  assert.match(power, /lms = lms \* lms \* lms;/);
  assert.doesNotMatch(power, /pow\(-2\.0 \* t \+ 2\.0,/);
  assert.match(power, /float u2 = u \* u;\s*return 1\.0 - u2 \* u2 \* 0\.5;/);
  assert.doesNotMatch(power, /pow\(abs\(crossPos/);
  assert.match(power, /float bend = \(1\.0 - b2 \* b2 \* b\) \* -0\.0500000007;/);
  for (const division of power.matchAll(/[^\n]*\/ edge[^\n]*/g)) assert.match(division[0], /edge > 0\.0 \?/);
  assert.match(power, /\/ edge/);
  for (const source of [halo, power, backdropFragment]) {
    for (const call of source.matchAll(/pow\(([^,]+),/g)) assert.match(call[1], /^(2\.0|a|ac|abs\([^)]*\))$/, `pow(${call[1]}, …) may see a base of zero or below`);
  }
});

test("a GL view sizes its canvas from the first layout instead of waiting at 300 by 150 for the resize observer", () => {
  assert.deepEqual(measuredSize(200, 100, 2), { css: [200, 100], pixels: [400, 200] });
  assert.deepEqual(measuredSize(100.4, 50.2, 1.5), { css: [100.4, 50.2], pixels: [151, 75] });
  assert.deepEqual(measuredSize(80, 40, 0), { css: [80, 40], pixels: [80, 40] });
  assert.equal(measuredSize(0, 100, 2), null);
  assert.equal(measuredSize(100, 0, 2), null);
});

test("an animated GL view holds its clock at zero until it has a size, then plays every frame and stops on the last one", () => {
  const clock = { css: [0, 0], time: 0, started: false, pending: 0 };
  assert.equal(stepAnimation(clock, 0.5, 1), "unmeasured");
  assert.equal(stepAnimation(clock, 0.5, 1), "unmeasured");
  assert.deepEqual([clock.time, clock.started, clock.pending], [0, false, 0]);
  clock.css = [120, 60];
  assert.equal(stepAnimation(clock, 0.5, 1), "draw");
  assert.deepEqual([clock.time, clock.started], [0, true]);
  assert.equal(stepAnimation(clock, 0.001, 1), "skip");
  assert.equal(clock.time, 0);
  assert.equal(stepAnimation(clock, MIN_FRAME_INTERVAL, 1), "draw");
  assert.ok(Math.abs(clock.time - (0.001 + MIN_FRAME_INTERVAL)) < 1e-9);
  assert.equal(stepAnimation(clock, 5, 1), "finish");
  assert.equal(clock.time, 1);
});

test("an onscreen GL view with no size holds no frame subscription, and takes one only once it is measured", () => {
  let subscribed = 0;
  let unsubscribed = 0;
  const frames = frameSubscription(() => {
    subscribed++;
    return () => unsubscribed++;
  });
  const clock = { css: [0, 0], done: false };
  const sync = (visible) => frames.sync(wantsFrames(visible, clock.css, clock.done));
  sync(true);
  sync(true);
  assert.equal(frames.active(), false);
  assert.equal(subscribed, 0);
  clock.css = [0, 40];
  sync(true);
  assert.equal(frames.active(), false);
  clock.css = [120, 40];
  sync(true);
  sync(true);
  assert.deepEqual([frames.active(), subscribed, unsubscribed], [true, 1, 0]);
  clock.css = [0, 0];
  sync(true);
  assert.deepEqual([frames.active(), subscribed, unsubscribed], [false, 1, 1]);
  clock.css = [120, 40];
  sync(false);
  assert.equal(frames.active(), false);
  sync(true);
  assert.deepEqual([frames.active(), subscribed], [true, 2]);
  clock.done = true;
  sync(true);
  assert.deepEqual([frames.active(), subscribed, unsubscribed], [false, 2, 2]);
});

test("the demo's preset vibrancy carries the app's crisp film grain", () => {
  const fract = (v) => v - Math.floor(v);
  const metal = (x, y) => {
    const p = [fract(x * 0.1031), fract(y * 0.1031), fract(x * 0.1031)];
    const d = p[0] * (p[1] + 33.33) + p[1] * (p[2] + 33.33) + p[2] * (p[0] + 33.33);
    return fract((p[0] + d + p[1] + d) * (p[2] + d));
  };
  for (const [x, y] of [[0, 0], [5, 9], [127, 64]]) assert.equal(filmGrainHash(x, y), metal(x, y));
  const bytes = filmGrainAlpha();
  assert.equal(bytes.length, FILM_GRAIN_SIDE * FILM_GRAIN_SIDE * 4);
  assert.equal(bytes[3], Math.round((1 - metal(0, 0)) * 255));
  assert.equal(filmGrainOpacity(0.09), 0.09);
  assert.equal(filmGrainSize(1), FILM_GRAIN_POINTS);
  const vibrancy = readFileSync(new URL("../src/shims/web/gl/Vibrancy.tsx", import.meta.url), "utf8");
  assert.match(vibrancy, /<FilmGrain grainOpacity=\{grainOpacity\} grainScale=\{grainScale\} \/>/);
  assert.match(vibrancy, /imageRendering: "pixelated"/);
  const shaders = readFileSync(new URL("../src/shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(shaders, /<Vibrancy [^>]*grainOpacity=\{grainOpacity\} grainScale=\{grainScale\}/);
});

test("demo submenus open beside their row at any depth, flip left at the right edge and stay on screen", () => {
  const viewport = { width: 1000, height: 700 };
  const size = { width: 240, height: 300 };
  assert.deepEqual(placeMenu(size, { x: 100, y: 120 }, viewport), { left: 100, top: 120 });
  assert.deepEqual(placeMenu(size, { x: 900, y: 650 }, viewport), { left: viewport.width - size.width - MENU_MARGIN, top: viewport.height - size.height - MENU_MARGIN });
  const first = { left: 100, top: 100, right: 340, width: 240 };
  const second = placeMenu(size, { row: { top: 160 }, parent: first }, viewport);
  assert.deepEqual(second, { left: 336, top: 155 });
  const secondBox = { left: second.left, top: second.top, right: second.left + size.width, width: size.width };
  const third = placeMenu(size, { row: { top: 200 }, parent: secondBox }, viewport);
  assert.deepEqual(third, { left: 572, top: 195 });
  const thirdBox = { left: third.left, top: third.top, right: third.left + size.width, width: size.width };
  const fourth = placeMenu(size, { row: { top: 600 }, parent: thirdBox }, viewport);
  assert.equal(fourth.left, thirdBox.left - size.width + 4, "a submenu at the right edge flips to the left of its parent");
  assert.equal(fourth.top, viewport.height - size.height - MENU_MARGIN);
  const menus = readFileSync(new URL("../src/shims/web/menus.tsx", import.meta.url), "utf8");
  assert.match(menus, /createPortal\(/);
  assert.match(menus, /document\.body/);
  assert.match(menus, /anchor=\{\{ row: sub\.row \}\}/);
});
