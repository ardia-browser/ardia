import assert from "node:assert/strict";
import test from "node:test";
import { materialColorSource, MATERIAL_FALLBACK_SEED, schemeFor, schemePairFor } from "./schemePick.ts";
import { MATERIAL_SCHEME_KEYS, SEEDED_SCHEMES, type MaterialSchemePair } from "./schemes.ts";

const wallpaper: MaterialSchemePair = { light: { ...SEEDED_SCHEMES.purple.light, primary: "#123456" }, dark: { ...SEEDED_SCHEMES.purple.dark, primary: "#654321" } };

test("every seeded scheme has exactly Compose's 36 ColorScheme roles as #RRGGBB, light and dark", () => {
  assert.equal(MATERIAL_SCHEME_KEYS.length, 36);
  for (const [name, pair] of Object.entries(SEEDED_SCHEMES)) {
    for (const scheme of [pair.light, pair.dark]) {
      assert.deepEqual(Object.keys(scheme).sort(), [...MATERIAL_SCHEME_KEYS].sort(), name);
      for (const value of Object.values(scheme)) assert.match(value, /^#[0-9A-F]{6}$/, name);
    }
  }
});

test("the fallback is the tonal-spot scheme of Ardia's green, light surfaces light and dark surfaces dark", () => {
  assert.equal(SEEDED_SCHEMES[MATERIAL_FALLBACK_SEED].seed, "#3EB489");
  assert.equal(SEEDED_SCHEMES.ardia.light.surface, "#F5FBF5");
  assert.equal(SEEDED_SCHEMES.ardia.dark.surface, "#0F1512");
});

test("with no colour picked the wallpaper's scheme wins, and below Android 12 the fallback", () => {
  assert.equal(schemePairFor(null, wallpaper), wallpaper);
  assert.equal(schemePairFor(null, null), SEEDED_SCHEMES.ardia);
});

test("a profile colour the user picked seeds the scheme over the wallpaper", () => {
  assert.equal(schemePairFor("blue", wallpaper), SEEDED_SCHEMES.blue);
  assert.equal(schemePairFor("plum", null), SEEDED_SCHEMES.plum);
  assert.equal(schemePairFor("nonsense", wallpaper), wallpaper);
});

test("the dark setting picks the dark half", () => {
  assert.equal(schemeFor(wallpaper, true).primary, "#654321");
  assert.equal(schemeFor(wallpaper, false).primary, "#123456");
});

test("the dynamic toggle overrides a saved custom color without forgetting it", () => {
  assert.equal(schemePairFor("blue", wallpaper, true), wallpaper);
  assert.equal(schemePairFor("blue", wallpaper, false), SEEDED_SCHEMES.blue);
  assert.equal(schemePairFor("blue", null, true), SEEDED_SCHEMES.ardia);
  assert.equal(schemePairFor(null, wallpaper, false), SEEDED_SCHEMES.plum);
  assert.equal(materialColorSource(true, "blue", wallpaper, true), "wallpaper");
  assert.equal(materialColorSource(true, "blue", wallpaper, false), "profile");
});

test("the launch event's colour source says wallpaper, a picked profile colour, the fallback palette, or not the material design", () => {
  assert.equal(materialColorSource(true, null, wallpaper), "wallpaper");
  assert.equal(materialColorSource(true, "pink", wallpaper), "profile");
  assert.equal(materialColorSource(true, null, null), "fallback");
  assert.equal(materialColorSource(true, MATERIAL_FALLBACK_SEED, null), "fallback");
  assert.equal(materialColorSource(false, "pink", wallpaper), "not_material");
});
