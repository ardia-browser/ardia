import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AccessibilityInfo } from "react-native";

const calls = [];
const motionListeners = new Set();
const initialMotion = Promise.withResolvers();
AccessibilityInfo.isReduceMotionEnabled = () => initialMotion.promise;
AccessibilityInfo.addEventListener = (event, listener) => {
  if (event === "reduceMotionChanged") motionListeners.add(listener);
  return { remove: () => motionListeners.delete(listener) };
};
const reduceMotion = (on) => { for (const listener of motionListeners) listener(on); };
globalThis.acTestNativeModules = {
  ...(globalThis.acTestNativeModules ?? {}),
  ArdiaFieldGlow: {
    show: (...args) => calls.push(["show", ...args]),
    progress: (...args) => calls.push(["progress", ...args]),
    pulse: (...args) => calls.push(["pulse", ...args]),
    finish: (...args) => calls.push(["finish", ...args]),
    reset: (...args) => calls.push(["reset", ...args]),
  },
};

const { useBrowser } = await import("../../state/browser/store.ts");
const { setLive } = await import("../../state/tabs/tabLive.ts");
const { FieldLoadFill } = await import("./FieldLoadFill.tsx");
const { FieldGlowFill, FIELD_GLOW_TIMINGS, fieldGlowLook, nativeSink } = await import("./FieldGlowFill.tsx");
const { driveFieldLoad } = await import("./fieldLoadDrive.ts");
const { setPageProgress } = await import("../../state/tabs/pageProgress.ts");
const { FIELD_LOAD } = await import("./tokens.ts");
const { parseColor } = await import("../../lib/color.ts");
const { fieldGlowFixture } = await import("./fieldGlowFixture.mjs");
const { colorRoles } = await import("../ui/tokens.ts");
const { reduceMotionKnown } = await import("../ui/reduceMotion.ts");

const S = () => useBrowser.getState();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://a.example/" });
const tab = S().windows[w].tabIds[0];

test("the glow does not pulse before the startup Reduce Motion preference is known", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  calls.length = 0;
  const drive = driveFieldLoad(tab, nativeSink("startup"));
  try {
    setLive(tab, { isLoading: true });
    t.mock.timers.tick(150);
    t.mock.timers.tick(FIELD_LOAD.pulse.wait);
    assert.ok(calls.some(([name]) => name === "show"));
    assert.equal(calls.some(([name]) => name === "pulse"), false);
    initialMotion.resolve(true);
    await reduceMotionKnown;
    t.mock.timers.tick(FIELD_LOAD.pulse.wait);
    assert.equal(calls.some(([name]) => name === "pulse"), false);
  } finally {
    initialMotion.resolve(true);
    await reduceMotionKnown;
    drive.stop();
    setLive(tab, { isLoading: false });
    reduceMotion(false);
  }
});

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

test("slow progress pulses, refits and tiny updates do not delay it, and real progress turns it off", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { wait, period, low } = FIELD_LOAD.pulse;
  calls.length = 0;
  const drive = driveFieldLoad(tab, nativeSink("stall"));
  const pulses = () => calls.filter(([name]) => name === "pulse");
  try {
    setPageProgress(tab, 0.2);
    setLive(tab, { isLoading: true });
    t.mock.timers.tick(150);
    t.mock.timers.tick(wait - 1);
    drive.refit();
    setPageProgress(tab, 0.21);
    assert.deepEqual(pulses(), []);
    t.mock.timers.tick(1);
    assert.deepEqual(pulses(), [["pulse", "stall", period, low]]);
    setPageProgress(tab, 0.22);
    assert.equal(pulses().length, 1);
    setPageProgress(tab, 0.23);
    assert.deepEqual(pulses().at(-1), ["pulse", "stall", 0, low]);
    t.mock.timers.tick(wait);
    assert.deepEqual(pulses().at(-1), ["pulse", "stall", period, low]);
    setLive(tab, { isLoading: false });
    assert.deepEqual(calls.slice(-2), [["pulse", "stall", 0, low], ["finish", "stall", false]]);
    setLive(tab, { isLoading: true });
    t.mock.timers.tick(150);
    drive.stop();
    t.mock.timers.tick(wait * 2);
    assert.deepEqual(calls.at(-1), ["reset", "stall"]);
    assert.equal(pulses().length, 4);
  } finally {
    drive.stop();
    setLive(tab, { isLoading: false });
    setPageProgress(tab, 0);
  }
});

test("reduce motion stops a running pulse and prevents one from starting", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { wait, period, low } = FIELD_LOAD.pulse;
  calls.length = 0;
  const drive = driveFieldLoad(tab, nativeSink("reduced"));
  const pulses = () => calls.filter(([name]) => name === "pulse");
  try {
    reduceMotion(true);
    setLive(tab, { isLoading: true });
    t.mock.timers.tick(150);
    t.mock.timers.tick(wait);
    assert.deepEqual(pulses(), []);
    reduceMotion(false);
    t.mock.timers.tick(wait);
    assert.deepEqual(pulses(), [["pulse", "reduced", period, low]]);
    reduceMotion(true);
    t.mock.timers.tick(wait);
    assert.deepEqual(pulses(), [["pulse", "reduced", period, low], ["pulse", "reduced", 0, low]]);
  } finally {
    drive.stop();
    setLive(tab, { isLoading: false });
    reduceMotion(false);
  }
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
