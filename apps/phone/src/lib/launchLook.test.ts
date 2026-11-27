import assert from "node:assert/strict";
import { test } from "node:test";
import { startingTheme } from "@ardia/core/src/theme.ts";
import { launchLookFor, launchLookWriter, type SavedLaunchLook } from "./launchLook.ts";
import { customLook, lookOf, nativeLookColors, presetLook, themeLookFor } from "./profileLook.ts";

const presets = [
  { key: "plum", swatch: "#C07A98", tint: "#B25B6B" },
  { key: "blue", swatch: "#4691C3" },
];

const plum = presetLook(presets[0]!);
const blue = presetLook(presets[1]!);
const macSpace = lookOf({ color: null, theme: { colors: ["#FF6A00", "#7A3CFF"], darkColors: ["#401A00", "#1E0F40"] } }, presets, "plum");

test("the launch look is the current space's colours, never a theme look for a plain space", () => {
  assert.deepEqual(launchLookFor(blue, null), { color: "blue", themeColors: [], themeLooks: { light: { dark: false }, dark: { dark: true } } });
  const mac = launchLookFor(macSpace, null);
  assert.deepEqual(mac.themeColors, ["#FF6A00", "#7A3CFF"]);
  assert.deepEqual(mac.darkThemeColors, ["#401A00", "#1E0F40"]);
});

test("each system appearance keeps the light or dark the app draws in it", () => {
  assert.deepEqual(launchLookFor(plum, null).themeLooks, { light: { dark: false }, dark: { dark: true } });
  assert.deepEqual(launchLookFor(plum, "dark").themeLooks, { light: { dark: true }, dark: { dark: true } });
  assert.deepEqual(launchLookFor(plum, "light").themeLooks, { light: { dark: false }, dark: { dark: false } });
});

test("a custom theme saves the look it draws in each appearance", () => {
  const look = customLook(startingTheme("#4691C3"), "own");
  const saved = launchLookFor(look, null);
  assert.equal(saved.color, nativeLookColors(look, false).color);
  assert.deepEqual(saved.themeLooks.light, { look: themeLookFor(look, false)!, dark: false });
  assert.deepEqual(saved.themeLooks.dark, { look: themeLookFor(look, true)!, dark: true });
  assert.deepEqual(launchLookFor(look, "dark").themeLooks.light, { look: themeLookFor(look, true)!, dark: true });
});

test("the writer saves each settled change once and writes again when the app leaves", () => {
  const writes: SavedLaunchLook[] = [];
  const writer = launchLookWriter((saved) => writes.push(saved));
  writer.leave();
  assert.equal(writes.length, 0);
  writer.settle(launchLookFor(plum, null));
  writer.settle(launchLookFor(plum, null));
  assert.equal(writes.length, 1);
  writer.settle(launchLookFor(blue, null));
  assert.equal(writes.at(-1)!.color, "blue");
  writer.leave();
  assert.equal(writes.length, 3);
  assert.equal(writes.at(-1)!.color, "blue");
});
