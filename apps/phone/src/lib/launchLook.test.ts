import assert from "node:assert/strict";
import { test } from "node:test";
import { startingTheme } from "@ardia/core/src/theme.ts";
import { launchLookFor, launchLookSourcesLoaded, launchLookWriter, type SavedLaunchLook } from "./launchLook.ts";
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

test("the writer saves each change of the current sources once and again when the app leaves", () => {
  const writes: SavedLaunchLook[] = [];
  let current: SavedLaunchLook | null = launchLookFor(plum, null);
  const writer = launchLookWriter(() => current, (saved) => writes.push(saved));
  writer.settle();
  writer.settle();
  assert.equal(writes.length, 1);
  current = launchLookFor(blue, null);
  writer.settle();
  assert.equal(writes.at(-1)!.color, "blue");
  writer.leave();
  assert.equal(writes.length, 3);
  assert.equal(writes.at(-1)!.color, "blue");
});

test("nothing is saved before the current space is known, even when the app leaves", () => {
  const writes: SavedLaunchLook[] = [];
  let current: SavedLaunchLook | null = null;
  const writer = launchLookWriter(() => current, (saved) => writes.push(saved));
  writer.settle();
  writer.leave();
  assert.equal(writes.length, 0);
  current = launchLookFor(macSpace, null);
  writer.settle();
  assert.deepEqual(writes, [launchLookFor(macSpace, null)]);
});

test("leaving saves the sources as they are now, not the last change the writer was told about", () => {
  const writes: SavedLaunchLook[] = [];
  let current: SavedLaunchLook | null = launchLookFor(plum, null);
  const writer = launchLookWriter(() => current, (saved) => writes.push(saved));
  writer.settle();
  current = launchLookFor(blue, null);
  writer.leave();
  assert.equal(writes.at(-1)!.color, "blue");
});

test("the launch look waits for sync's first snapshot only where sync is offered", () => {
  assert.equal(launchLookSourcesLoaded({ ready: true, syncOffered: true, syncLoaded: false }), false);
  assert.equal(launchLookSourcesLoaded({ ready: true, syncOffered: true, syncLoaded: true }), true);
  assert.equal(launchLookSourcesLoaded({ ready: true, syncOffered: false, syncLoaded: false }), true);
  assert.equal(launchLookSourcesLoaded({ ready: false, syncOffered: false, syncLoaded: true }), false);
});
