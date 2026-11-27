import assert from "node:assert/strict";
import test from "node:test";
import { luminance } from "../../lib/color.ts";
import { lookOf, presetLook, windowTintStops, type PresetSpec, type ProfileLook } from "../../lib/profileLook.ts";
import { emphasisInkFor, spaceAccentFor } from "./accentRoles.ts";
import { rgbToHsl, parseColor } from "../../lib/color.ts";
import { contrastMinimum, neutralFills, PROFILE_COLORS, type ProfileColor } from "./paletteTokens.ts";

const ratio = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
};

const presets: PresetSpec[] = (Object.keys(PROFILE_COLORS) as ProfileColor[]).map((key) => ({ key, swatch: PROFILE_COLORS[key].swatch, tint: PROFILE_COLORS[key].tint }));

const customLooks: [string, ProfileLook][] = [
  ["pale lemon", lookOf({ color: "#FFF59D", theme: null }, presets, "plum")],
  ["bright cyan", lookOf({ color: "#00E5FF", theme: null }, presets, "plum")],
  ["deep navy", lookOf({ color: "#0B1A4A", theme: null }, presets, "plum")],
  ["mint and peach theme", lookOf({ color: null, theme: { colors: ["#B9F6CA", "#FFCCBC"], darkColors: null } }, presets, "plum")],
  ["two-scheme theme", lookOf({ color: null, theme: { colors: ["#FFE082", "#FFAB91"], darkColors: ["#4A148C", "#311B92"] } }, presets, "plum")],
];

const looks: [string, ProfileLook][] = [...presets.map((preset): [string, ProfileLook] => [PROFILE_COLORS[preset.key as ProfileColor].name, presetLook(preset)]), ...customLooks];

for (const [name, look] of looks) {
  for (const dark of [false, true]) {
    const scheme = dark ? "dark" : "light";
    const accent = spaceAccentFor(look, dark);
    const fills = dark ? neutralFills.dark : neutralFills.light;
    const backdrops = { ...fills, canvas: windowTintStops(look, dark)[0] };

    test(`${name} in ${scheme}: text on the accent fill reads at ${contrastMinimum.text}:1`, () => {
      const measured = ratio(accent.onSpaceAccent, accent.spaceAccent);
      assert.ok(measured >= contrastMinimum.text, `${accent.onSpaceAccent} on ${accent.spaceAccent} is ${measured.toFixed(2)}:1`);
    });

    for (const [backdrop, fill] of Object.entries(backdrops)) {
      test(`${name} in ${scheme}: accent ink reads at ${contrastMinimum.text}:1 on the ${backdrop}`, () => {
        const measured = ratio(accent.spaceAccentInk, fill);
        assert.ok(measured >= contrastMinimum.text, `${accent.spaceAccentInk} on ${fill} is ${measured.toFixed(2)}:1`);
      });
      test(`${name} in ${scheme}: an emphasized word reads at ${contrastMinimum.text}:1 on the ${backdrop}`, () => {
        const measured = ratio(emphasisInkFor(look, dark), fill);
        assert.ok(measured >= contrastMinimum.text, `${emphasisInkFor(look, dark)} on ${fill} is ${measured.toFixed(2)}:1`);
      });
      test(`${name} in ${scheme}: accent glyphs and edges show at ${contrastMinimum.glyph}:1 on the ${backdrop}`, () => {
        const measured = ratio(accent.spaceAccentGlyph, fill);
        assert.ok(measured >= contrastMinimum.glyph, `${accent.spaceAccentGlyph} on ${fill} is ${measured.toFixed(2)}:1`);
      });
    }
  }
}

test("presets keep their swatches; the accent roles are derived, not new swatches", () => {
  assert.equal(PROFILE_COLORS.green.swatch, "#3EB489");
  assert.equal(PROFILE_COLORS.yellow.swatch, "#E3AC38");
  assert.equal(PROFILE_COLORS.plum.tint, "#B25B6B");
});

test("an accent that already reads keeps its hue: plum's fill stays plum", () => {
  const plum = spaceAccentFor(presetLook(presets.find((preset) => preset.key === "plum")!), false);
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(plum.spaceAccent.slice(at, at + 2), 16)) as [number, number, number];
  assert.ok(r > g && r > b, `${plum.spaceAccent} is no longer red-led`);
});

const saturationOf = (color: string) => {
  const [r, g, b] = parseColor(color);
  return rgbToHsl(r / 255, g / 255, b / 255)[1];
};

test("an emphasized word in dark keeps the colour's saturation where the accent ink washes it toward white", () => {
  for (const key of ["plum", "blue", "purple", "red"] as const) {
    const look = presetLook(presets.find((preset) => preset.key === key)!);
    assert.ok(saturationOf(emphasisInkFor(look, true)) > saturationOf(spaceAccentFor(look, true).spaceAccentInk), `${key}: ${emphasisInkFor(look, true)} is no more vivid than ${spaceAccentFor(look, true).spaceAccentInk}`);
  }
});
