import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { themeFor, profileTheme, tintTheme, PROFILE_COLORS } = await import("../ui/theme.ts");
const { profileSurfaces, contrastRatio, toneStep, MIN_PANE_TEXT_CONTRAST } = await import("./profileSurfaces.ts");
const { startingTheme, oklab } = await import("../../lib/profileLook.ts");
const { colorDistance, parseColor } = await import("../../lib/color.ts");

const lab = (color) => {
  const [r, g, b] = parseColor(color);
  return oklab({ r: r / 255, g: g / 255, b: b / 255, a: 1 });
};
const chroma = (color) => Math.hypot(lab(color)[1], lab(color)[2]);
const hue = (color) => Math.atan2(lab(color)[2], lab(color)[1]);
const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};

const presets = Object.keys(PROFILE_COLORS);
const themes = [
  ...["dark", "light"].flatMap((mode) => presets.map((c) => [`${c}:${mode}`, tintTheme(themeFor(`${c}:${mode}`))])),
  ["incognito", themeFor("incognito")],
  ...[true, false].flatMap((dark) => ["#2E8C9A", "#1B1F3B", "#F2C14E"].map((swatch) => [`custom ${swatch} ${dark ? "dark" : "light"}`, tintTheme(profileTheme({ color: "green", theme: startingTheme(swatch) }, dark))])),
];

test("the neutral profile's ghost stays the near-black (dark) and white (light) solid it was", () => {
  const dark = profileSurfaces(themeFor("neutral:dark")).ghost;
  const light = profileSurfaces(themeFor("neutral:light")).ghost;
  assert.ok(colorDistance(dark, "#0F0F14") < 0.04 && chroma(dark) < 0.01, dark);
  assert.ok(colorDistance(light, "#FFFFFF") < 0.02 && chroma(light) < 0.01, light);
});

test("a coloured profile's ghost and panes carry its hue and more colour than the neutral profile's", () => {
  for (const mode of ["dark", "light"]) {
    const neutral = profileSurfaces(themeFor(`neutral:${mode}`));
    for (const color of presets.filter((c) => c !== "neutral")) {
      const s = profileSurfaces(themeFor(`${color}:${mode}`));
      for (const [part, fill] of [["ghost", s.ghost], ["pane", s.activePanes.rest], ["selected pane", s.activePanes.selected]]) {
        if (chroma(fill) < 0.004) continue;
        assert.ok(hueGap(fill, themeFor(`${color}:${mode}`).backdrop.tintColor) < 0.35, `${color}:${mode} ${part} ${fill} keeps the profile hue`);
      }
      assert.ok(chroma(s.activePanes.rest) > chroma(neutral.activePanes.rest) + 0.005, `${color}:${mode} panes are tinted`);
    }
  }
});

test("the ghost's text reads at least as well as the selected row's, in every profile", () => {
  for (const [name, theme] of themes) {
    const s = profileSurfaces(theme);
    assert.ok(contrastRatio(s.ghostText, s.ghost) >= contrastRatio(theme.rowSelectedText, s.selectedRow) - 1e-9, `${name}: ${s.ghostText} on ${s.ghost}`);
  }
});

test("split panes stand apart from their row and from the shown pane, and the shown pane's title stays readable", () => {
  for (const [name, theme] of themes) {
    const s = profileSurfaces(theme);
    for (const [surface, tones] of [[s.selectedRow, s.activePanes]]) {
      assert.ok(colorDistance(tones.rest, surface) > 0.02, `${name}: pane ${tones.rest} on row ${surface}`);
      assert.ok(colorDistance(tones.selected, tones.rest) > 0.04, `${name}: shown pane ${tones.selected} against ${tones.rest}`);
      assert.ok(colorDistance(tones.hover, tones.rest) > 0.01, `${name}: hover ${tones.hover} against ${tones.rest}`);
      assert.ok(contrastRatio(theme.rowSelectedText, tones.selected) >= MIN_PANE_TEXT_CONTRAST, `${name}: shown title on ${tones.selected}`);
    }
    assert.ok(contrastRatio(theme.textTab, s.activePanes.rest) >= MIN_PANE_TEXT_CONTRAST, `${name}: title on ${s.activePanes.rest}`);
  }
});

test("a pane on a light custom backdrop steps away from white titles instead of washing them out", () => {
  const theme = tintTheme(profileTheme({ color: "green", theme: startingTheme("#2E8C9A") }, true));
  const s = profileSurfaces(theme);
  const row = contrastRatio(theme.textTab, s.selectedRow);
  assert.ok(contrastRatio(theme.textTab, s.activePanes.rest) >= row, `${s.activePanes.rest} on ${s.selectedRow}: ${row}`);
});

test("a tone near white keeps its hue instead of clipping to another one", () => {
  const blue = toneStep("#F5F7FA", "#DCE5ED", 0.03);
  assert.ok(chroma(blue) < 0.03 && (chroma(blue) < 0.004 || hueGap(blue, "#DCE5ED") < 0.35), blue);
  assert.equal(toneStep("#808080", "#808080", 0), "#808080");
});

test("the palette is worked out once per theme", () => {
  const theme = themeFor("blue:dark");
  assert.equal(profileSurfaces(theme), profileSurfaces(theme));
});
