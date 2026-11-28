import assert from "node:assert/strict";
import { test } from "node:test";
import { androidAlwaysDark, backdropIsDark, compositeOver, inkContrastOnPlate, inkContrastOverGray, liftedInk, PLATE_INK, plateBounds, plateFace, plateIsDark, READABLE_GLYPH, READABLE_TEXT, readableVeil } from "./readableInk.ts";

const reads = (veil: string, ink: string, backdrop: string) => {
  const seen = compositeOver(veil, backdrop);
  const gray = (parseInt(seen.slice(1, 3), 16) * 0.2126 + parseInt(seen.slice(3, 5), 16) * 0.7152 + parseInt(seen.slice(5, 7), 16) * 0.0722) / 255;
  return inkContrastOverGray(ink, gray);
};

test("the plate bounds leave the chrome inks at five to one, as the iPhone shader's readableCeiling and readableFloor do", () => {
  assert.ok(plateBounds.ceiling > 0.08 && plateBounds.ceiling < 0.13);
  assert.ok(plateBounds.floor > 0.2 && plateBounds.floor < 0.32);
  assert.ok(inkContrastOverGray(PLATE_INK.onDark, plateBounds.ceilingGray) >= 4.99);
  assert.ok(inkContrastOverGray(PLATE_INK.onLight, plateBounds.floorGray) >= 4.99);
});

test("a translucent fill that carries ink is raised until it holds the bound over a white page, and one that already holds is left alone", () => {
  for (const [fill, dark] of [["rgba(255,255,255,0.18)", true], ["rgba(30,30,32,0.6)", true], ["rgba(255,255,255,0.14)", true], ["rgba(0,0,0,0.25)", true], ["rgba(255,255,255,0.2)", false], ["rgba(255,255,255,0.62)", false]] as const) {
    const veil = readableVeil(fill, dark);
    for (const page of ["#FFFFFF", "#808080", "#000000"]) assert.ok(reads(veil, PLATE_INK[dark ? "onDark" : "onLight"], page) >= READABLE_TEXT, `${fill} ${dark} over ${page}`);
  }
  assert.equal(readableVeil("rgba(14,14,16,0.86)", true), "rgba(14,14,16,0.86)");
  assert.equal(readableVeil("rgba(255,255,255,0.62)", false), "rgba(255,255,255,0.62)");
});

test("an opaque fill decides its own shade, a clear one keeps the asked shade", () => {
  assert.deepEqual(plateFace("#FFFFFF", true), { fill: "#FFFFFF", dark: false });
  assert.deepEqual(plateFace("#101012", false), { fill: "#101012", dark: true });
  assert.deepEqual(plateFace("#00000000", true), { fill: "#00000000", dark: true });
});

test("role inks are lifted only as far as the plate needs: text to 4.5 to 1 and quiet glyphs to 3 to 1", () => {
  assert.equal(liftedInk("#FFFFFF", true, READABLE_TEXT), "#FFFFFF");
  assert.equal(liftedInk("#000000", false, READABLE_TEXT), "#000000");
  for (const [ink, dark, target] of [["rgba(255,255,255,0.5)", true, READABLE_GLYPH], ["rgba(60,60,67,0.6)", false, READABLE_GLYPH], ["rgba(235,235,245,0.3)", true, READABLE_GLYPH], ["rgba(255,255,255,0.8)", true, READABLE_TEXT]] as const)
    assert.ok(inkContrastOnPlate(liftedInk(ink, dark, target), dark) >= target, `${ink} on ${dark ? "dark" : "light"}`);
});

test("a backdrop's shade is read from its colours, so a dark scheme over a light theme's stops gets dark ink", () => {
  assert.equal(backdropIsDark(["#F4D7E0", "#FBE7EE"]), false);
  assert.equal(backdropIsDark(["#1A1A1E", "#0E0E10"]), true);
  assert.equal(backdropIsDark(["#6B2D5C", "#4A1942"]), true);
});

test("on Android the Incognito look is always dark, as LookRules.dark decides natively; on iPhone the asked shade stands", () => {
  assert.equal(androidAlwaysDark("android", true), true);
  assert.equal(plateIsDark({ requested: false, incognitoLook: true, themeDark: false, os: "android" }), true);
  assert.equal(plateIsDark({ requested: false, incognitoLook: true, themeDark: false, os: "ios" }), false);
  assert.equal(plateIsDark({ requested: undefined, incognitoLook: true, themeDark: false, os: "ios" }), true);
  assert.equal(plateIsDark({ requested: undefined, incognitoLook: false, themeDark: true, os: "ios" }), true);
});
