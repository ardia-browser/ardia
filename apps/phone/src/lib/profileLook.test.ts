import assert from "node:assert/strict";
import { test } from "node:test";
import { startingTheme, themeUnderColor, themeLayerAlpha, themeUnderlayAlpha, themeGrainAlpha, readableDark, opaqueThemeTint, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { activeCustomLook, backdropStops, choiceAfterMatchToggle, customLook, lookGlassTint, lookForApp, lookOf, nativeLookColors, presetLook, showsTheme, spaceTone, themedScheme, themeLookFor, windowTintStops } from "./profileLook.ts";

const presets = [
  { key: "plum", swatch: "#C07A98", tint: "#B25B6B" },
  { key: "blue", swatch: "#4691C3" },
  { key: "green", swatch: "#3EB489" },
  { key: "neutral", swatch: "#8E8E93" },
];

const plum = presetLook(presets[0]!);
const macTheme = { color: null, theme: { colors: ["#FF6A00", "#7A3CFF"], darkColors: ["#401A00", "#1E0F40"] } };

test("a preset keeps the window tint the app always had", () => {
  assert.deepEqual(windowTintStops(plum, false), ["#E7CFD3", "#F2E7E9"]);
  assert.deepEqual(windowTintStops(plum, true), ["#342123", "#3B3031"]);
  assert.deepEqual(windowTintStops(presetLook(presets[1]!), false), ["#D0DDE7", "#E7EDF2"]);
  assert.deepEqual(windowTintStops(presetLook(presets[3]!), true), ["#1F1B1A", "#231F1E"]);
  assert.equal(presetLook(presets[1]!).tint, "#5B8FB2");
});

test("a Mac theme tints the windows from the mix of its colours, not the nearest preset", () => {
  const look = lookOf(macTheme, presets, "plum");
  assert.equal(look.preset, null);
  assert.equal(look.swatch, "#BD5380");
  assert.equal(look.tint, "#B25B80");
  assert.equal(look.isNeutral, false);
  assert.deepEqual(windowTintStops(look, false), ["#E7CFD9", "#F2E7EB"]);
});

test("the start page draws the Mac's own gradient, with its dark colours in dark mode", () => {
  const look = lookOf(macTheme, presets, "plum");
  assert.equal(showsTheme(look, false, true), true);
  assert.deepEqual(backdropStops(look, false, true), ["#FF6A00", "#7A3CFF"]);
  assert.deepEqual(backdropStops(look, true, true), ["#401A00", "#1E0F40"]);
  assert.deepEqual(backdropStops(look, false, false), windowTintStops(look, false));
  const lightOnly = lookOf({ color: null, theme: { colors: ["#FF6A00", "#7A3CFF"], darkColors: null } }, presets, "plum");
  assert.deepEqual(backdropStops(lightOnly, true, true), ["#FF6A00", "#7A3CFF"]);
});

test("a one-colour theme or a plain colour has no gradient to draw", () => {
  const single = lookOf({ color: null, theme: { colors: ["#FF6A00"], darkColors: null } }, presets, "plum");
  assert.equal(showsTheme(single, false, true), false);
  assert.deepEqual(backdropStops(single, false, true), windowTintStops(single, false));
});

test("a Mac colour that is a preset is that preset, by name or by hex", () => {
  assert.equal(lookOf({ color: "#4691C3", theme: null }, presets, "plum").preset, "blue");
  assert.equal(lookOf({ color: "Green", theme: null }, presets, "plum").preset, "green");
  assert.equal(lookOf({ color: "#4691C4", theme: null }, presets, "plum").preset, null);
  assert.equal(lookOf({ color: null, theme: null }, presets, "plum").preset, "plum");
});

test("a grey Mac theme is neutral and tints grey", () => {
  const look = lookOf({ color: null, theme: { colors: ["#808080", "#7A7A7A"], darkColors: null } }, presets, "plum");
  assert.equal(look.isNeutral, true);
  assert.equal(look.tint, "#868686");
});

test("a chosen colour wins over the Mac, and Match My Mac needs sync", () => {
  assert.equal(lookForApp("green", true, macTheme, presets, "plum").preset, "green");
  assert.equal(lookForApp(null, true, macTheme, presets, "plum").swatch, "#BD5380");
  assert.equal(lookForApp(null, false, macTheme, presets, "plum").preset, "plum");
  assert.equal(lookForApp(null, true, null, presets, "plum").preset, "plum");
});

test("turning Match My Mac off keeps the Mac's colour when it is a preset, else goes back to plum", () => {
  assert.equal(choiceAfterMatchToggle(true, plum, "plum"), null);
  assert.equal(choiceAfterMatchToggle(false, lookOf({ color: "#4691C3", theme: null }, presets, "plum"), "plum"), "blue");
  assert.equal(choiceAfterMatchToggle(false, lookOf(macTheme, presets, "plum"), "plum"), "plum");
});

test("synced Spaces take the shown profile's own colours, softened toward the background", () => {
  assert.deepEqual(spaceTone(macTheme, false, false, presets, "plum"), ["#FFE1CC", "#E4D8FF"]);
  assert.deepEqual(spaceTone(macTheme, true, false, presets, "plum"), ["#301400", "#160B30"]);
  assert.deepEqual(spaceTone({ color: "blue", theme: null }, false, false, presets, "plum"), ["#DAE9F3", "#D3E5F1"]);
  assert.deepEqual(spaceTone(null, true, false, presets, "plum"), ["#412934", "#36222B"]);
});

test("with Increased Contrast the Spaces tone moves further toward the background", () => {
  assert.deepEqual(spaceTone(macTheme, false, true, presets, "plum"), ["#FFF0E6", "#F2ECFF"]);
  assert.deepEqual(spaceTone(macTheme, true, true, presets, "plum"), ["#200D00", "#0F0820"]);
});

test("the native look views get a preset by name, and the Mac's own look by its colour and theme", () => {
  assert.deepEqual(nativeLookColors(presetLook(presets[1]!), false), { color: "blue", themeColors: [], darkThemeColors: null, themeLook: null });
  assert.deepEqual(nativeLookColors(lookOf(macTheme, presets, "plum"), true), { color: "#BD5380", themeColors: ["#FF6A00", "#7A3CFF"], darkThemeColors: ["#401A00", "#1E0F40"], themeLook: null });
});

test("the glass takes the look's tint at 15%, and the neutral look leaves the glass untinted", () => {
  assert.equal(lookGlassTint(presetLook({ key: "plum", swatch: "#B25B6B", tint: "#B25B6B" })), "rgba(178, 91, 107, 0.15)");
  assert.equal(lookGlassTint(presetLook({ key: "neutral", swatch: "#8E8E93" })), undefined);
});

const blue = startingTheme("#4691C3");
const look = (stops: [number, number, number][], extra: Partial<ProfileTheme> = {}): ProfileTheme => ({
  ...blue,
  stops: stops.map(([r, g, b], i) => ({ color: { r, g, b, a: 1 }, x: 0.2 + i * 0.3, y: 0.5 })),
  ...extra,
});
const macFull = {
  color: null,
  theme: {
    colors: ["#FF6A00", "#7A3CFF"],
    darkColors: ["#401A00", "#1E0F40"],
    mode: "auto" as const,
    look: { ...blue, angle: 90, grain: 0.4, texture: "denim" as const },
    dark: { ...look([[0.1, 0.05, 0.2], [0.05, 0.1, 0.2]]), angle: 200 },
  },
};

test("the Mac's starting theme and its alphas hold the Mac's numbers", () => {
  assert.equal(blue.stops.length, 2);
  assert.equal(blue.intensity, 0.6);
  assert.equal(blue.translucency, 1);
  assert.equal(blue.mode, "auto");
  assert.equal(themeUnderColor(blue, false), "#F5F5F5");
  assert.equal(themeUnderColor(blue, true), "#222222");
  assert.equal(themeLayerAlpha(blue), 0.53);
  assert.equal(themeUnderlayAlpha(blue, false), 0.5);
  assert.equal(themeUnderlayAlpha(blue, true), 0.175);
  assert.equal(themeGrainAlpha({ ...blue, grain: 0.5, texture: "sand" }), 0.075);
  assert.deepEqual(opaqueThemeTint(blue, false), ["#A4E5E3", "#A4AFE5"]);
  assert.equal(readableDark(blue, false), false);
  assert.equal(readableDark(blue, true), true);
});

test("the phone's own theme is a look of its own: accent swatch, palette, and the theme drawn natively", () => {
  const own = customLook(blue, "own");
  assert.equal(own.preset, null);
  assert.equal(own.swatch, "#5D94D7");
  assert.deepEqual(own.theme, ["#5CD6D3", "#5C71D6"]);
  assert.equal(own.darkTheme, null);
  assert.equal(showsTheme(own, false, true), true);
  assert.deepEqual(backdropStops(own, false, true), ["#A4E5E3", "#A4AFE5"]);
  assert.deepEqual(backdropStops(own, false, false), windowTintStops(own, false));
  const colors = nativeLookColors(own, false);
  assert.equal(colors.color, "#5D94D7");
  assert.deepEqual(colors.themeColors, ["#5CD6D3", "#5C71D6"]);
  assert.deepEqual(colors.themeLook, { stops: blue.stops, intensity: 0.6, grain: 0, texture: "grain", translucency: 1, angle: 135 });
});

test("Custom wins with a saved theme, and without one falls back to the default preset", () => {
  assert.equal(lookForApp("custom", true, macTheme, presets, "plum", blue).custom?.source, "own");
  assert.equal(lookForApp("custom", true, macTheme, presets, "plum", null).preset, "plum");
  assert.equal(lookForApp("green", true, macTheme, presets, "plum", blue).preset, "green");
});

test("Match My Mac draws the Mac's full theme, its dark look in dark, and follows the app's appearance", () => {
  const mac = lookForApp(null, true, macFull, presets, "plum");
  assert.equal(mac.custom?.source, "app");
  assert.deepEqual(mac.theme, ["#5CD6D3", "#5C71D6"]);
  assert.equal(themeLookFor(mac, false)?.angle, 90);
  assert.equal(themeLookFor(mac, false)?.texture, "denim");
  assert.equal(themeLookFor(mac, true)?.angle, 200);
  assert.deepEqual(themeLookFor(mac, true)?.stops[0]?.color, { r: 0.1, g: 0.05, b: 0.2, a: 1 });
  assert.equal(lookForApp(null, false, macFull, presets, "plum").preset, "plum");
  assert.deepEqual(activeCustomLook(null, null, true, macFull)?.source, "app");
  assert.equal(activeCustomLook(null, null, false, macFull), null);
  assert.equal(activeCustomLook("blue", blue, true, macFull), null);
  assert.equal(activeCustomLook("custom", blue, false, null)?.source, "own");
});

test("a Mac theme without its full look still draws as colours, as before", () => {
  const old = lookForApp(null, true, macTheme, presets, "plum");
  assert.equal(old.custom, null);
  assert.equal(themeLookFor(old, false), null);
});

test("the theme's mode and readable ink decide light or dark, the way the Mac does", () => {
  const own = (theme: ProfileTheme) => ({ theme, source: "own" as const });
  assert.equal(themedScheme(null, null), null);
  assert.equal(themedScheme(null, "dark"), "dark");
  assert.equal(themedScheme(own(blue), null), null);
  assert.equal(themedScheme(own(blue), "light"), "light");
  assert.equal(themedScheme(own({ ...blue, mode: "dark" }), "light"), "dark");
  assert.equal(themedScheme(own({ ...blue, mode: "light" }), "dark"), "light");
  const night = look([[0.05, 0.05, 0.1], [0.05, 0.08, 0.1]], { translucency: 0, mode: "light" });
  assert.equal(themedScheme(own(night), "light"), "dark");
  assert.equal(themedScheme(own({ ...night, mode: "auto" }), null), "dark");
  const app = { theme: { ...blue, mode: "dark" as const }, source: "app" as const };
  assert.equal(themedScheme(app, "light"), "light");
});

test("the native look is the one shown for the view's light or dark, kept dark when the ink needs it", () => {
  const night = look([[0.05, 0.05, 0.1], [0.05, 0.08, 0.1]], { translucency: 0, mode: "light" });
  const view = customLook(night, "own");
  assert.deepEqual(themeLookFor(view, true)?.stops.map((s) => s.color.r), [0.05, 0.05]);
  const split = customLook({ ...blue, dark: { ...look([[0.2, 0.1, 0.1]]), angle: 30 } }, "own");
  assert.equal(themeLookFor(split, true)?.stops.length, 1);
  assert.equal(themeLookFor(split, true)?.angle, 30);
  assert.equal(themeLookFor(split, false)?.stops.length, 2);
  assert.equal(themeLookFor(split, false)?.angle, 135);
});

test("turning Match My Mac off keeps the Mac's full theme as Custom", () => {
  assert.equal(choiceAfterMatchToggle(false, lookForApp(null, true, macFull, presets, "plum"), "plum"), "custom");
});
