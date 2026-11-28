import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { profileTheme, scopedTheme, spaceGoFill, PROFILE_COLORS } = await import("./theme.ts");
const { colorRoles } = await import("./tokens.ts");
const { contrastRatio, parseColor, rgbToHsl } = await import("../../lib/color.ts");

const hslOf = (color) => {
  const [r, g, b] = parseColor(color);
  return rgbToHsl(r / 255, g / 255, b / 255);
};
const hueGap = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
const MODES = [true, false];

test("the stock plum space keeps Dia's measured Go fill in both modes", () => {
  for (const dark of MODES) {
    const theme = profileTheme({ color: "plum" }, dark);
    assert.equal(spaceGoFill(theme), theme.goButton);
  }
});

test("every other preset space paints Go in its own hue, at the stock fill's lightness, with its label still readable", () => {
  for (const dark of MODES)
    for (const color of Object.keys(PROFILE_COLORS)) {
      if (color === "plum" || color === "neutral") continue;
      const theme = profileTheme({ color }, dark);
      const fill = spaceGoFill(theme);
      assert.notEqual(fill, theme.goButton, `${color} ${dark ? "dark" : "light"}`);
      assert.ok(hueGap(hslOf(fill)[0], hslOf(theme.powerUpColor)[0]) < 0.01, `${color} ${dark ? "dark" : "light"}: ${fill} against ${theme.powerUpColor}`);
      assert.ok(Math.abs(hslOf(fill)[2] - hslOf(theme.goButton)[2]) < 0.01, `${color} keeps the stock lightness`);
      assert.ok(contrastRatio(theme.onPrimary, fill) >= 7, `${color} ${dark ? "dark" : "light"} label: ${contrastRatio(theme.onPrimary, fill).toFixed(2)}`);
    }
});

test("the neutral space's Go is grey, and an incognito window keeps the stock fill", () => {
  for (const dark of MODES) {
    const neutral = profileTheme({ color: "neutral" }, dark);
    assert.equal(hslOf(spaceGoFill(neutral))[1], 0);
  }
  const incognito = scopedTheme(true, undefined, true, "own");
  assert.equal(spaceGoFill(incognito), incognito.goButton);
});

test("a custom theme whose accent sits nearest plum still paints Go in that accent's hue", () => {
  const rose = { r: 0.85, g: 0.35, b: 0.6, a: 1 };
  const custom = { stops: [{ x: 0.5, y: 0.5, color: rose }], intensity: 0.8, mode: "dark", grain: 0, texture: "grain", translucency: 1 };
  const theme = profileTheme({ color: "plum", theme: custom }, true);
  assert.equal(theme.profileColor, "plum");
  const fill = spaceGoFill(theme);
  assert.notEqual(fill, theme.goButton);
  assert.ok(hueGap(hslOf(fill)[0], hslOf(theme.powerUpColor)[0]) < 0.01, `${fill} against ${theme.powerUpColor}`);
});

test("a theme file's own Go colour is kept as written, not re-hued", () => {
  const own = "rgba(180,180,0,0.85)";
  const palette = { revision: 1, dark: { ...colorRoles.dark, goButton: own }, light: colorRoles.light };
  const theme = profileTheme({ color: "purple" }, true, "own", palette);
  assert.equal(spaceGoFill(theme), own);
});

test("a theme file that keeps the stock Go fill but sets its own label colour keeps the stock fill, so its label reads as written", () => {
  const palette = { revision: 2, dark: { ...colorRoles.dark, onPrimary: "#595959" }, light: colorRoles.light };
  const theme = profileTheme({ color: "purple" }, true, "own", palette);
  assert.equal(spaceGoFill(theme), theme.goButton);
});
