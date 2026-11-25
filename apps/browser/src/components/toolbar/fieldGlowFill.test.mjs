import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const calls = [];
globalThis.acTestNativeModules = {
  ...(globalThis.acTestNativeModules ?? {}),
  ArdiaFieldGlow: {
    show: (...args) => calls.push(["show", ...args]),
    progress: (...args) => calls.push(["progress", ...args]),
    finish: (...args) => calls.push(["finish", ...args]),
    reset: (...args) => calls.push(["reset", ...args]),
  },
};

const { useBrowser } = await import("../../state/browser/store.ts");
const { setLive } = await import("../../state/tabs/tabLive.ts");
const { FieldLoadFill } = await import("./FieldLoadFill.tsx");
const { FieldGlowFill, FIELD_GLOW_TIMINGS, fieldGlowLook, nativeSink } = await import("./FieldGlowFill.tsx");
const { driveFieldLoad } = await import("./fieldLoadDrive.ts");
const { FIELD_LOAD } = await import("./tokens.ts");
const { parseColor } = await import("../../lib/color.ts");
const { fieldGlowFixture } = await import("./fieldGlowFixture.mjs");
const { colorRoles } = await import("../ui/tokens.ts");

const S = () => useBrowser.getState();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://a.example/" });
const tab = S().windows[w].tabIds[0];

test("with the native glow present, the field's fill is one native host with no layout callback, no Animated value and no timer", () => {
  assert.equal(FieldLoadFill, FieldGlowFill);
  const source = readFileSync(new URL("./FieldGlowFill.tsx", import.meta.url), "utf8");
  const rendered = source.slice(source.indexOf("if (!Host) return null;"));
  assert.equal((rendered.match(/<[A-Z]\w*/g) ?? []).join(","), "<Host");
  assert.doesNotMatch(source, /Animated|GradientFill|<View\b|Surface|onLayout|useState|setTimeout|setInterval|requestAnimationFrame/);
});

test("a lasting load drives the native view: show, the page's raw progress, finish, and nothing after a reset", async () => {
  calls.length = 0;
  const drive = driveFieldLoad(tab, nativeSink("g1"));
  assert.deepEqual(calls, []);
  setLive(tab, { isLoading: true });
  await sleep(220);
  assert.deepEqual(calls[0], ["show", "g1", FIELD_GLOW_TIMINGS]);
  assert.equal(calls[1][0], "progress");
  assert.equal(typeof calls[1][2], "number");
  setLive(tab, { isLoading: false });
  assert.deepEqual(calls.at(-1), ["finish", "g1", false]);
  drive.stop();
  assert.deepEqual(calls.at(-1), ["reset", "g1"]);
  const before = calls.length;
  setLive(tab, { isLoading: true });
  await sleep(220);
  drive.refit();
  setLive(tab, { isLoading: false });
  assert.equal(calls.length, before);
});

test("the timings and the look sent to the native view are the field load tokens", () => {
  const { motion } = FIELD_LOAD;
  assert.deepEqual(FIELD_GLOW_TIMINGS, [motion.show.duration, motion.progress.duration, motion.finish.duration, motion.hold, motion.hide.duration]);
  const look = fieldGlowLook(colorRoles.dark.accent);
  assert.deepEqual(look.rgba, parseColor(colorRoles.dark.accent));
  assert.deepEqual(look.glow, FIELD_LOAD.glow.map(([at, alpha]) => [at, alpha]));
  assert.deepEqual([look.tail, look.cap, look.frontShare, look.tailCeiling, look.line, look.floor], [FIELD_LOAD.tail, FIELD_LOAD.cap, FIELD_LOAD.frontShareOfField, FIELD_LOAD.tailCeiling, FIELD_LOAD.line, FIELD_LOAD.floor]);
});

test("the native geometry fixture is today's JavaScript plates, so the Swift test checks the native view against the real look", () => {
  const saved = JSON.parse(readFileSync(new URL("../../../../../packages/shell/fieldglow-tests/fieldGlowFixture.json", import.meta.url), "utf8"));
  assert.deepEqual(saved.cases, JSON.parse(JSON.stringify(fieldGlowFixture())));
  const look = fieldGlowLook(colorRoles.dark.accent);
  for (const key of ["glow", "tailFade", "capFade", "tail", "cap", "frontShare", "tailCeiling", "line", "floor"]) assert.deepEqual(saved.look[key], look[key]);
});

test("the native timing table is the fill's own motion tokens and curves, read from their source", async () => {
  const { fieldGlowMotion } = await import("./fieldGlowMotion.mjs");
  const saved = JSON.parse(readFileSync(new URL("../../../../../packages/shell/fieldglow-tests/fieldGlowFixture.json", import.meta.url), "utf8"));
  assert.deepEqual(saved.motion, JSON.parse(JSON.stringify(fieldGlowMotion())));
  assert.deepEqual(Object.keys(saved.motion).sort(), ["finish", "hide", "hold", "progress", "show"]);
});
