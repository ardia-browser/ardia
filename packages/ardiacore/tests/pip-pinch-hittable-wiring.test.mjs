import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const zoom = read("../ios/ArdiaPiPZoom.mm");
const math = read("../ios/ArdiaPiPZoomMath.h");

const body = (source, header) => {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? source.length : end);
};

test("while the stand-in shows a pinch or edge drag, the real window stays where the rest of the gesture lands", () => {
  const began = body(zoom, "- (void)pinchBegan {");
  assert.match(began, /_hiddenAlpha = window\.alphaValue;\s*window\.alphaValue = MIN\(_hiddenAlpha, ardia_pip_zoom::kHittableHiddenAlpha\);/);
  assert.doesNotMatch(began, /window\.alphaValue = 0;/);
  const alpha = Number(math.match(/constexpr double kHittableHiddenAlpha = ([\d.]+);/)?.[1]);
  assert.ok(alpha > 0 && alpha <= 0.02, `kHittableHiddenAlpha ${alpha}`);
});

test("the stand-in's own panel never takes the gesture, and the window gets its alpha back at the hand-off", () => {
  assert.match(body(zoom, "- (void)pinchBegan {"), /panel\.ignoresMouseEvents = YES;/);
  assert.match(body(zoom, "- (void)finishHandOff:(BOOL)timedOut {"), /_window\.alphaValue = _hiddenAlpha;/);
});
