import assert from "node:assert/strict";
import { test } from "node:test";

const { AccessibilityInfo } = await import("react-native");
const settle = [];
const fail = [];
const changeListeners = [];
AccessibilityInfo.isReduceMotionEnabled = () => new Promise((resolve, reject) => {
  settle.push(resolve);
  fail.push(reject);
});
AccessibilityInfo.addEventListener = (type, listener) => {
  if (type === "reduceMotionChanged") changeListeners.push(listener);
  return { remove() {} };
};

const load = async (tag, matchMedia) => {
  const previous = globalThis.window;
  if (matchMedia === undefined) delete globalThis.window;
  else globalThis.window = { matchMedia };
  try {
    return await import(`./reduceMotion.ts?${tag}`);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
};

test("on the web the first render already knows the reduced-motion preference, before the async answer lands", async () => {
  const queries = [];
  const reduced = await load("reduced", (query) => (queries.push(query), { matches: true }));
  assert.deepEqual(queries, ["(prefers-reduced-motion: reduce)"]);
  assert.equal(reduced.reduceMotion(), true);
  const full = await load("full", () => ({ matches: false }));
  assert.equal(full.reduceMotion(), false);
});

test("without matchMedia the preference stays unknown until the platform answers, as on the Mac and in Node", async () => {
  const native = await load("native", undefined);
  assert.equal(native.reduceMotion(), null);
  const broken = await load("broken", () => null);
  assert.equal(broken.reduceMotion(), false);
  settle[2](true);
  await native.reduceMotionKnown;
  assert.equal(native.reduceMotion(), true);
});

test("a Reduce Motion change that lands before the first answer is not overwritten by that answer", async () => {
  const at = settle.length;
  const late = await load("late", undefined);
  changeListeners.at(-1)(true);
  settle[at](false);
  assert.equal(await late.reduceMotionKnown, true);
  assert.equal(late.reduceMotion(), true);
  changeListeners.at(-1)(false);
  assert.equal(late.reduceMotion(), false);
});

test("a failed first answer keeps the reduced-motion preference the web already read, and falls back to off only when nothing is known", async () => {
  const at = fail.length;
  const web = await load("rejected-web", () => ({ matches: true }));
  fail[at](new Error("unavailable"));
  assert.equal(await web.reduceMotionKnown, true);
  assert.equal(web.reduceMotion(), true);
  const unknown = await load("rejected-native", undefined);
  fail[at + 1](new Error("unavailable"));
  assert.equal(await unknown.reduceMotionKnown, false);
  assert.equal(unknown.reduceMotion(), false);
});

test("a first answer that lands after the web already read the preference does not overwrite it, and later changes still do", async () => {
  const at = settle.length;
  const web = await load("resolved-web", () => ({ matches: true }));
  settle[at](false);
  assert.equal(await web.reduceMotionKnown, true);
  assert.equal(web.reduceMotion(), true);
  changeListeners.at(-1)(false);
  assert.equal(web.reduceMotion(), false);
  changeListeners.at(-1)(true);
  assert.equal(web.reduceMotion(), true);
});
