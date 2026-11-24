import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
globalThis.require ??= (id) => (id.endsWith("useAnimatedProps") ? { default: (props) => [props, () => {}] } : nodeRequire(id));
await import("../../test-native/index.ts");
const frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (run) => {
  const id = nextFrame++;
  frames.set(id, run);
  return id;
};
globalThis.cancelAnimationFrame = (id) => void frames.delete(id);
const drainFrames = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const run of due) run(0);
  return due.length;
};
const { mount } = await import("../../test-hooks.mjs");
const { Animated } = await import("react-native");
const { Fold, FoldSettling } = await import("./Fold.tsx");

const ROW = 30;
const entries = (n) => Array.from({ length: n }, (_, i) => ({ key: `tab:t${i}`, node: null }));
const rowsIn = (element) => {
  const inner = element.props.children;
  const provider = [inner.props.children].flat().find((c) => c?.type === FoldSettling.Provider);
  return provider.props.children.filter((slot) => slot?.key?.startsWith("tab:")).length;
};
const fold = (settling, n = 500) =>
  mount(() => Fold({ fold: { open: new Animated.Value(1), moving: false, finish() {} }, collapsed: false, entries: entries(n), rowHeight: () => ROW }), { contexts: [[FoldSettling, settling]] });

test("an open fold mounted while an ancestor is still moving or filling in mounts one window of rows, not its whole list", () => {
  const settling = fold(true);
  const shown = rowsIn(settling.value);
  assert.ok(shown > 0 && shown < 100, `mounted ${shown} of 500`);
  settling.unmount();
});

test("an open fold mounted with nothing above it settling mounts every row, as before", () => {
  const settled = fold(false);
  assert.equal(rowsIn(settled.value), 500);
  settled.unmount();
});

const settlingFlag = (element) => [element.props.children.props.children].flat().find((c) => c?.type === FoldSettling.Provider).props.value;

test("a fold still filling in after its ancestors settle tells the folds inside it to wait, so a group it reaches mounts in slices too", () => {
  const filling = fold(true);
  const element = filling.setContext(FoldSettling, false);
  assert.ok(rowsIn(element) < 500, "it is still filling in");
  assert.equal(settlingFlag(element), true);
  filling.unmount();
});

test("a fold with every row mounted lets the folds inside it fill in", () => {
  const settled = fold(false);
  assert.equal(settlingFlag(settled.value), false);
  settled.unmount();
});

test("once its ancestors settle, a deferred fold fills in every row and then lets the folds inside it fill too", () => {
  const filling = fold(true);
  let element = filling.setContext(FoldSettling, false);
  for (let i = 0; i < 400 && drainFrames(); i++) element = filling.value;
  assert.equal(rowsIn(element), 500);
  assert.equal(settlingFlag(element), false);
  assert.equal(frames.size, 0, "nothing left scheduled");
  filling.unmount();
});

test("a fold still filling in mounts every row at once when a drag or a reveal asks", async () => {
  const { flushFolds, foldsFilling } = await import("./foldFlush.ts");
  const filling = fold(true);
  const element = filling.setContext(FoldSettling, false);
  assert.ok(rowsIn(element) < 500);
  assert.equal(foldsFilling(""), true);
  void flushFolds("");
  assert.equal(rowsIn(filling.value), 500);
  assert.equal(foldsFilling(""), false);
  filling.unmount();
});

test("opening a fold with a kept row lays the rows past the window out at full height, so a reveal sees the settled length", () => {
  const kept = mount(() => Fold({ fold: { open: new Animated.Value(0), moving: true, finish() {} }, collapsed: false, entries: entries(200), keep: "tab:t150", rowHeight: () => ROW }), { contexts: [[FoldSettling, false]] });
  const slots = [kept.value.props.children.props.children].flat().find((c) => c?.type === FoldSettling.Provider).props.children;
  const far = slots.filter((slot) => slot?.key?.startsWith("tab:t1") && Number(slot.key.slice(5)) > 100);
  assert.ok(far.length > 0);
  for (const slot of far) assert.notDeepEqual(slot.props.children.props.style, { display: "none" });
  kept.unmount();
});

test("a fold still moving finishes its motion when a drag or a reveal flushes it", async () => {
  const { flushFolds, foldsFilling } = await import("./foldFlush.ts");
  let finished = 0;
  const moving = mount(() => Fold({ fold: { open: new Animated.Value(0.4), moving: true, finish: () => finished++ }, collapsed: false, entries: entries(10), rowHeight: () => ROW }), { contexts: [[FoldSettling, false]] });
  assert.equal(foldsFilling(""), true, "a moving fold counts as pending");
  void flushFolds("");
  assert.equal(finished, 1);
  moving.unmount();
});
