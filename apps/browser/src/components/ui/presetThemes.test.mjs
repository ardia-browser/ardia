import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

globalThis.__DEV__ = false;

const { profileTheme, PROFILE_COLORS } = await import("./theme.ts");
const look_ = { ...(await import("../../lib/profileLook.ts")), ...(await import("../../lib/presetLook.ts")) };
const { editedPresetCount, presetStartingTheme, presetThemeOf, PROFILE_COLOR_NAMES, withPresetChosen } = look_;
const { themeFromRecord } = await import("../../state/sync/profileAdapters.ts");

const look = (r, intensity = 0.5) => ({ stops: [{ x: 0.2, y: 0.7, color: { r, g: 0.4, b: 0.8, a: 1 } }], intensity, mode: "auto", grain: 0, texture: "grain", translucency: 1 });
const EDIT_A = look(0.1);
const EDIT_B = look(0.9, 0.8);

const digest = (theme) => createHash("sha256").update(JSON.stringify(theme)).digest("hex");
const SAVED_CUSTOM = { stops: [{ x: 0.2, y: 0.7, color: { r: 0.9, g: 0.4, b: 0.8, a: 1 } }, { x: 0.8, y: 0.3, color: { r: 0.2, g: 0.7, b: 0.5, a: 1 } }], intensity: 0.8, mode: "auto", grain: 0.3, texture: "sand", translucency: 0.5, angle: 200 };
const digests = () =>
  Object.fromEntries(
    PROFILE_COLOR_NAMES.flatMap((color) =>
      ["light", "dark"].flatMap((mode) => [
        [`${color}:${mode}`, digest(profileTheme({ color }, mode === "dark"))],
        [`custom:${color}:${mode}`, digest(profileTheme({ color, theme: SAVED_CUSTOM }, mode === "dark"))],
      ]),
    ),
  );
const BEFORE = JSON.parse(readFileSync(new URL("./fixtures/preset-themes-0247.json", import.meta.url), "utf8"));

test("an untouched preset computes the same theme as 0.2.47 did, for all nine in light and dark", () => {
  const now = digests();
  for (const key of Object.keys(BEFORE).filter((k) => !k.startsWith("custom:"))) assert.equal(now[key], BEFORE[key], key);
  for (const color of PROFILE_COLOR_NAMES) {
    assert.deepEqual(profileTheme({ color, theme: null, presetThemes: { [color === "plum" ? "blue" : "plum"]: EDIT_A } }, true), profileTheme({ color }, true), `${color}: another preset's edit changes nothing here`);
  }
});

test("the nine presets are the only swatches, in the order the picker draws them", () => {
  assert.deepEqual(Object.keys(PROFILE_COLORS), [...PROFILE_COLOR_NAMES]);
});

test("this Mac's own looks: an edit is kept under the preset it was made on, and a pick shows that preset's own look or plain", () => {
  const { withOwnLook } = look_;
  let profile = { color: "plum", theme: null, presetThemes: {} };
  profile = { ...profile, ...withOwnLook(profile, EDIT_A) };
  assert.deepEqual(profile.presetThemes, { plum: EDIT_A });
  profile = { ...profile, ...withPresetChosen(profile, "blue") };
  assert.equal(profile.color, "blue");
  assert.equal(profile.theme, null, "blue has no own look, so it shows plain");
  assert.deepEqual(profile.presetThemes, { plum: EDIT_A }, "a pick never moves anything");
  profile = { ...profile, ...withOwnLook(profile, EDIT_B) };
  profile = { ...profile, ...withPresetChosen(profile, "plum") };
  assert.deepEqual(profile.theme, EDIT_A);
  assert.deepEqual(profile.presetThemes, { plum: EDIT_A, blue: EDIT_B });
  assert.equal(editedPresetCount(profile), 2);
  assert.deepEqual(presetThemeOf(profile, "blue"), EDIT_B);
});

test("picking the preset that's already showing changes nothing", () => {
  assert.equal(withPresetChosen({ color: "plum", theme: EDIT_A, presetThemes: { plum: EDIT_A } }, "plum"), null);
});

test("Reset clears the showing preset's own look and nothing else", () => {
  const { withOwnLook } = look_;
  const profile = { color: "blue", theme: EDIT_B, presetThemes: { blue: EDIT_B, plum: EDIT_A } };
  assert.deepEqual(withOwnLook(profile, null), { theme: null, presetThemes: { plum: EDIT_A } });
});

test("the showing swatch draws what's on screen, which may be a synced look; the others draw this Mac's own looks", () => {
  const profile = { color: "blue", theme: EDIT_A, presetThemes: { blue: EDIT_B } };
  assert.deepEqual(presetThemeOf(profile, "blue"), EDIT_A);
  assert.equal(presetThemeOf(profile, "plum"), null);
});

test("a colour or look from sync never touches this Mac's own looks", () => {
  const { withSyncedColor } = look_;
  const profile = { color: "plum", theme: EDIT_A, presetThemes: { plum: EDIT_B } };
  assert.deepEqual(withSyncedColor(profile, "blue", EDIT_A), { color: "blue", theme: EDIT_A });
  assert.deepEqual(withSyncedColor(profile, "blue", undefined), { color: "blue", theme: undefined }, "no synced look: nothing shows until one arrives");
  assert.equal(withSyncedColor(profile, "plum", EDIT_A), null);
});

test("a profile saved before this version takes its shown theme as its own look of that preset, once", () => {
  const { withOwnLooksSeeded } = look_;
  assert.deepEqual(withOwnLooksSeeded({ color: "blue", theme: EDIT_A }).presetThemes, { blue: EDIT_A });
  assert.deepEqual(withOwnLooksSeeded({ color: "blue", theme: null }).presetThemes, {});
  const migrated = { color: "blue", theme: EDIT_A, presetThemes: {} };
  assert.equal(withOwnLooksSeeded(migrated), migrated, "a profile that already has its own looks is left as it is");
});

test("a slider ignores the pointer until its track has a real width, and snaps only within half a pixel of the start", () => {
  const { trackValueAt } = look_;
  assert.equal(trackValueAt(500, 100, 0, 0.6), null, "no measurement yet: no value");
  assert.equal(trackValueAt(500, 100, -1, 0.6), null);
  assert.equal(trackValueAt(220, 100, 120, undefined), 1);
  assert.equal(trackValueAt(220, 100, 120, 0.6), 1, "a clamped 1 stays 1");
  assert.equal(trackValueAt(172.3, 100, 120, 0.6), 0.6, "0.3 px from the start snaps to it");
});

test("a 0.2.47 custom theme becomes the edit of the preset it was on, and the window looks exactly the same", () => {
  for (const color of PROFILE_COLOR_NAMES) {
    const saved = { color, theme: SAVED_CUSTOM };
    for (const mode of ["light", "dark"]) assert.equal(digests()[`custom:${color}:${mode}`], BEFORE[`custom:${color}:${mode}`], `${color} ${mode}: drawn as 0.2.47 drew it`);
    const seeded = look_.withOwnLooksSeeded(saved);
    assert.deepEqual(presetThemeOf(seeded, color), SAVED_CUSTOM, `${color}: its swatch draws the custom look`);
    assert.equal(editedPresetCount(seeded), 1);
    const away = { ...seeded, ...withPresetChosen(seeded, color === "green" ? "red" : "green") };
    assert.deepEqual({ ...away, ...withPresetChosen(away, color) }.theme, SAVED_CUSTOM, `${color}: nothing is lost by switching away and back`);
  }
});

test("a preset opens in the editor as one colour, its swatch, with the custom editor's defaults", () => {
  for (const color of PROFILE_COLOR_NAMES) {
    const start = presetStartingTheme(PROFILE_COLORS[color].swatch);
    assert.equal(start.stops.length, 1);
    assert.deepEqual({ intensity: start.intensity, grain: start.grain, translucency: start.translucency, texture: start.texture, mode: start.mode, angle: start.angle }, { intensity: 0.6, grain: 0, translucency: 1, texture: "grain", mode: "auto", angle: undefined });
    const hex = `#${[start.stops[0].color.r, start.stops[0].color.g, start.stops[0].color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
    assert.equal(hex.toLowerCase(), PROFILE_COLORS[color].swatch.toLowerCase());
  }
});

test("the theme record is read as before", () => {
  assert.deepEqual(themeFromRecord({ t: EDIT_B }), { theme: EDIT_B });
  assert.deepEqual(themeFromRecord({ preset: true }), { theme: null });
});

test("an edit counts as untouched when every value is back at the start, whatever the key order or an explicit default angle", () => {
  const { sameTheme, sanitizeTheme, withAngle } = look_;
  const start = presetStartingTheme(PROFILE_COLORS.blue.swatch);
  assert.ok(sameTheme(withAngle(withAngle(start, 200), 135), start));
  assert.ok(sameTheme(sanitizeTheme(JSON.parse(JSON.stringify(start))), start));
  assert.ok(!sameTheme({ ...start, intensity: 0.61 }, start));
  assert.ok(!sameTheme(withAngle(start, 136), start));
});

test("putting a colour point or the brightness back where the preset started counts as untouched", () => {
  const { sameTheme, withStopAt, withStopLightness, stopLightness } = look_;
  for (const color of PROFILE_COLOR_NAMES) {
    const start = presetStartingTheme(PROFILE_COLORS[color].swatch);
    const [stop] = start.stops;
    assert.ok(sameTheme(withStopAt(start, 0, stop.x, stop.y), start), `${color}: the point dragged back`);
    assert.ok(sameTheme(withStopLightness(start, 0, stopLightness(stop)), start), `${color}: the brightness put back`);
    assert.ok(!sameTheme(withStopAt(start, 0, stop.x + 0.02, stop.y), start), `${color}: a real move still counts`);
  }
});

test("a control lands on the preset's start only within half a pixel of it, and anything you can see as different stays an edit", () => {
  const { isUntouched, snapToStart, snapPointToStart } = look_;
  const start = presetStartingTheme(PROFILE_COLORS.blue.swatch);
  const TRACK = 120;
  assert.equal(snapToStart(0.6 + 0.4 / TRACK, 0.6, TRACK), 0.6, "0.4 px off snaps back");
  assert.equal(snapToStart(0.61, 0.6, TRACK), 0.61, "1.2 px off is a real adjustment");
  assert.ok(!isUntouched({ ...start, intensity: 0.61 }, start), "and it stays an edit");
  assert.ok(isUntouched({ ...start, intensity: snapToStart(0.6 - 0.3 / TRACK, 0.6, TRACK) }, start));
  const [stop] = start.stops;
  assert.deepEqual(snapPointToStart({ x: stop.x + 0.4 / 172, y: stop.y - 0.4 / 172 }, stop, 172), { x: stop.x, y: stop.y }, "the pad snaps within half a point");
  assert.equal(snapPointToStart({ x: stop.x + 1 / 172, y: stop.y }, stop, 172).x, stop.x + 1 / 172, "a point away stays");
  for (const color of PROFILE_COLOR_NAMES) {
    const s0 = presetStartingTheme(PROFILE_COLORS[color].swatch);
    const p = s0.stops[0];
    const snapped = snapPointToStart({ x: p.x + 0.3 / 172, y: p.y }, p, 172);
    assert.ok(isUntouched(look_.withStopAt(s0, 0, snapped.x, snapped.y), s0), `${color}: dragged back onto its start`);
  }
});

test("a theme changed by 0.2.47 after this version saved is taken as this Mac's own look of that preset on the way back", () => {
  const { withOwnLooksSeeded } = look_;
  const saved = { color: "plum", theme: EDIT_B, presetThemes: { plum: EDIT_A }, seenTheme: EDIT_A };
  assert.deepEqual(withOwnLooksSeeded(saved).presetThemes, { plum: EDIT_B }, "0.2.47 changed the theme, so its look is the newest own look of plum");
  const untouched = { color: "plum", theme: EDIT_A, presetThemes: { plum: EDIT_A, blue: EDIT_B }, seenTheme: EDIT_A };
  assert.equal(withOwnLooksSeeded(untouched), untouched, "a theme this version last saw is left alone");
  const synced = { color: "plum", theme: EDIT_B, presetThemes: { plum: EDIT_A }, seenTheme: EDIT_B };
  assert.equal(withOwnLooksSeeded(synced), synced, "a synced look this version saw shown stays out of the own looks");
});

test("a press that starts before its track is measured is ignored to its release", () => {
  const { trackPress } = look_;
  const press = trackPress();
  press.grant(0);
  assert.equal(press.at(220, 100, 120, 0.6), null, "the track measured later doesn't revive the press");
  press.grant(120);
  assert.equal(press.at(220, 100, 120, 0.6), 1, "the next press works");
});

test("a downgrade round trip after the first migration, and a reset made on 0.2.47, both come back as made", () => {
  const { withOwnLooksSeeded } = look_;
  const first = withOwnLooksSeeded({ color: "plum", theme: EDIT_A });
  assert.deepEqual(first.seenTheme, EDIT_A, "the first migration records what it saw");
  assert.deepEqual(withOwnLooksSeeded({ ...first, theme: EDIT_B }).presetThemes, { plum: EDIT_B }, "an edit made on 0.2.47 after that is the newest own look");
  assert.deepEqual(withOwnLooksSeeded({ ...first, theme: null }).presetThemes, {}, "a reset made on 0.2.47 clears the own look");
});

test("a press that was never armed doesn't commit when it's taken away", () => {
  const { trackPress } = look_;
  const press = trackPress();
  press.grant(0);
  assert.equal(press.armed(), false);
  press.grant(120);
  assert.equal(press.armed(), true);
});

test("a preset picked on 0.2.47 after a downgrade never deletes this Mac's saved look of it", () => {
  const { withOwnLooksSeeded } = look_;
  const after = { color: "blue", theme: null, presetThemes: { plum: EDIT_A, blue: EDIT_B }, seenTheme: EDIT_A, seenColor: "plum" };
  assert.deepEqual(withOwnLooksSeeded(after).presetThemes, { plum: EDIT_A, blue: EDIT_B }, "0.2.47 cleared the theme because it switched colour, not because blue was reset");
  const reset = { color: "plum", theme: null, presetThemes: { plum: EDIT_A, blue: EDIT_B }, seenTheme: EDIT_A, seenColor: "plum" };
  assert.deepEqual(withOwnLooksSeeded(reset).presetThemes, { blue: EDIT_B }, "a clear on the same colour is a reset");
});

test("a profile made on this version records the look it starts with, so a 0.2.47 edit of it is kept on the way back", async () => {
  const { withOwnLooksSeeded } = look_;
  const { useBrowser } = await import("../../state/browser/store.ts");
  useBrowser.getState().hydrate({});
  const id = useBrowser.getState().createProfile({ name: "Fresh", color: "green" });
  const made = useBrowser.getState().profiles[id];
  assert.equal(made.seenTheme, null);
  assert.equal(made.seenColor, "green");
  const editedOn0247 = { ...made, theme: EDIT_A };
  assert.deepEqual(withOwnLooksSeeded(editedOn0247).presetThemes, { green: EDIT_A });
});
