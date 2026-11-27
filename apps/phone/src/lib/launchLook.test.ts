import assert from "node:assert/strict";
import { test } from "node:test";
import { startingTheme } from "@ardia/core/src/theme.ts";
import { launchLookFor, launchLookNeedsSync, launchLookOf, launchLookSourcesLoaded, launchLookWriter, type LaunchLookState, type SavedLaunchLook } from "./launchLook.ts";
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

test("a look that needs nothing from sync is saved while sync is stuck, as after picking Blue with sync needing folder access", () => {
  assert.equal(launchLookSourcesLoaded({ ready: true, syncOffered: true, syncLoaded: false, needsSync: false }), true);
  assert.equal(launchLookSourcesLoaded({ ready: true, syncOffered: true, syncLoaded: false, needsSync: true }), false);
  assert.equal(launchLookSourcesLoaded({ ready: false, syncOffered: true, syncLoaded: false, needsSync: false }), false);
  assert.equal(launchLookNeedsSync({ colorChoice: "blue", schemeChoice: "system", design: "redesigned" }), false);
  assert.equal(launchLookNeedsSync({ colorChoice: "custom", schemeChoice: "dark", design: "redesigned" }), false);
  assert.equal(launchLookNeedsSync({ colorChoice: "blue", schemeChoice: "matchMac", design: "original" }), false);
  assert.equal(launchLookNeedsSync({ colorChoice: null, schemeChoice: "system", design: "redesigned" }), true);
  assert.equal(launchLookNeedsSync({ colorChoice: "blue", schemeChoice: "matchMac", design: "redesigned" }), true);
});

test("the launch look takes the space's colours and its appearance from the same space", () => {
  const stops = [[0.05, 0.05, 0.1], [0.05, 0.08, 0.1]].map(([r, g, b], i) => ({ color: { r: r!, g: g!, b: b!, a: 1 }, x: 0.2 + i * 0.3, y: 0.5 }));
  const night = { ...startingTheme("#4691C3"), stops, translucency: 0, angle: 0 };
  const work = { color: "blue", theme: { colors: ["#0D0D1A"], darkColors: null, mode: "auto" as const, look: night } };
  const personal = { color: "plum", theme: null };
  const state = (space: LaunchLookState["space"]): LaunchLookState => ({ design: "redesigned", schemeChoice: "system", colorChoice: null, customTheme: null, presetThemes: {}, materialYou: false, syncEnabled: true, macLook: null, space });
  const saved = launchLookOf(state(work), presets, "plum");
  assert.deepEqual([saved.themeLooks.light.dark, saved.themeLooks.dark.dark], [true, true]);
  assert.deepEqual(launchLookOf(state(personal), presets, "plum").themeLooks, { light: { dark: false }, dark: { dark: true } });
  assert.deepEqual(saved, launchLookFor(lookOf(work, presets, "plum"), "dark"));
});

test("a selected preset launches as the app draws it, never as the saved Custom theme, and its own edits launch with it", () => {
  const darkRed = { ...startingTheme("#8B1A1A"), mode: "dark" as const };
  const base: LaunchLookState = { design: "redesigned", schemeChoice: "light", colorChoice: "blue", customTheme: darkRed, presetThemes: {}, materialYou: false, syncEnabled: false, macLook: null, space: null };
  assert.deepEqual(launchLookOf(base, presets, "plum"), launchLookFor(blue, "light"));
  const editedBlue = { ...startingTheme("#4691C3"), grain: 0.7 };
  const edited = { ...base, presetThemes: { blue: editedBlue } };
  assert.deepEqual(launchLookOf(edited, presets, "plum"), launchLookFor({ ...customLook(editedBlue, "own"), preset: "blue" }, "light"));
  assert.deepEqual(launchLookOf({ ...edited, materialYou: true }, presets, "plum"), launchLookFor(blue, "light"));
});
