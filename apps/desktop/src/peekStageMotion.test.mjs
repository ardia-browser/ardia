import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collapsedTransform, compositorOnly, computedPresentation, continuedMotion, createBoundsCommit, createStageController, createWebAnimator, ENTER_MS, expandedTransform, PEEK_MOVING_ATTRIBUTE, stageMotion, STEP_MS } from "./peekStageMotion.ts";

const geometry = { width: 1200, height: 800, card: { x: 200, y: 100, width: 800, height: 600 }, source: { x: 40, y: 40, width: 20, height: 20 }, fullscreen: false };
const MOVES = ["enter", "close", "promote"];

test("every Peek move animates only transform and opacity, never layout", () => {
  for (const move of MOVES) for (const reduce of [false, true]) for (const fullscreen of [false, true]) {
    const motion = stageMotion(move, { ...geometry, fullscreen }, reduce);
    assert.ok(compositorOnly(motion.card), `${move} card`);
    assert.ok(compositorOnly(motion.scrim), `${move} scrim`);
  }
  assert.equal(compositorOnly([{ width: 10 }]), false);
  assert.equal(compositorOnly([{ top: 0, opacity: 1 }]), false);
});

test("the stage source animates through the Web Animations API, not per-frame style writes", () => {
  const stage = readFileSync(new URL("./shims/web/PeekStage.tsx", import.meta.url), "utf8");
  const motion = readFileSync(new URL("./peekStageMotion.ts", import.meta.url), "utf8");
  assert.match(stage, /createWebAnimator\(/);
  assert.match(motion, /\.animate\(/);
  assert.doesNotMatch(stage, /Animated\./);
});

test("reduced motion and a fullscreen peek snap every move in zero time", () => {
  for (const move of MOVES) {
    assert.equal(stageMotion(move, geometry, true).duration, 0);
    assert.equal(stageMotion(move, { ...geometry, fullscreen: true }, false).duration, 0);
  }
  assert.equal(stageMotion("enter", geometry, false).duration, ENTER_MS);
  assert.equal(stageMotion("close", geometry, false).duration, STEP_MS);
});

test("arrival grows from the source point, dismissal shrinks back to it, and expansion fills the window", () => {
  assert.equal(collapsedTransform(geometry), "translate(-550px, -350px) scale(0.12, 0.12)");
  assert.equal(expandedTransform(geometry), "translate(0px, 0px) scale(1.5, 1.3333)");
  const enter = stageMotion("enter", geometry, false);
  assert.equal(enter.card[0].transform, collapsedTransform(geometry));
  assert.equal(enter.card.at(-1).transform, "translate(0px, 0px) scale(1, 1)");
  assert.equal(stageMotion("close", geometry, false).card.at(-1).transform, collapsedTransform(geometry));
  assert.equal(stageMotion("promote", geometry, false).scrim.at(-1).opacity, 0);
  assert.ok(!/cubic-bezier\([^)]*,\s*1\.[0-9]*[1-9]/.test(enter.easing), "no overshoot");
});

function controllerHarness({ reduceMotion = false } = {}) {
  const log = [];
  const runs = [];
  let held = false;
  const animator = {
    hold: () => { held = true; log.push("hold"); },
    release: () => { held = false; log.push("release"); },
    cancel: () => log.push("cancel"),
    run: (move, motion) => new Promise((resolve, reject) => runs.push({ move, motion, resolve, reject })),
  };
  const states = [];
  const done = [];
  const controller = createStageController(animator, { state: (phase, generation, entrance) => states.push({ phase, generation, entrance }), done: (generation, outcome) => done.push({ generation, outcome }) }, () => ({ geometry, reduceMotion }));
  return { controller, runs, states, done, log, held: () => held };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the stage holds native bounds while moving and releases them once it settles", async () => {
  const h = controllerHarness();
  assert.equal(h.controller.begin(1), true);
  assert.equal(h.held(), true);
  assert.deepEqual(h.states.map((s) => s.phase), ["entering"]);
  h.runs.at(-1).resolve();
  await tick();
  assert.equal(h.held(), false);
  assert.deepEqual(h.states.map((s) => s.phase), ["entering", "open"]);
  assert.equal(h.controller.close(1), true);
  assert.equal(h.held(), true);
  h.runs.at(-1).resolve();
  await tick();
  assert.deepEqual(h.done, [{ generation: 1, outcome: "closed" }]);
  assert.equal(h.held(), false);
});

test("stale generations, double closes and moves after finishing are refused", async () => {
  const h = controllerHarness();
  h.controller.begin(2);
  assert.equal(h.controller.begin(2), false);
  assert.equal(h.controller.begin(1), false);
  assert.equal(h.controller.close(1), false);
  assert.equal(h.controller.close(2), true);
  assert.equal(h.controller.close(2), false);
  assert.equal(h.controller.promote(2), false);
  h.runs[0].resolve();
  h.runs[1].resolve();
  await tick();
  assert.deepEqual(h.done, [{ generation: 2, outcome: "closed" }]);
  assert.ok(!h.states.some((s) => s.phase === "open"), "an interrupted entrance never reports open");
});

test("a cancelled move still settles the newer one, and promote finishes as promoted", async () => {
  const h = controllerHarness();
  h.controller.begin(1);
  h.controller.promote(1);
  h.runs[0].reject(new Error("AbortError"));
  await tick();
  assert.equal(h.held(), true);
  h.runs[1].resolve();
  await tick();
  assert.equal(h.held(), false);
  assert.deepEqual(h.done, [{ generation: 1, outcome: "promoted" }]);
});

test("reduced motion reports the fade entrance and snaps", () => {
  const h = controllerHarness({ reduceMotion: true });
  h.controller.begin(1);
  assert.equal(h.states[0].entrance, "fade");
  assert.equal(h.runs[0].motion.duration, 0);
  const instant = controllerHarness();
  instant.controller.begin(1, false);
  assert.equal(instant.runs[0].motion.duration, 0);
});

test("held bounds publish nothing while moving and only the settled value on release", () => {
  const published = [];
  const commit = createBoundsCommit((value) => published.push(value));
  commit.offer({ visible: true, rect: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(published.length, 1);
  commit.hold();
  for (let frame = 0; frame < 12; frame++) commit.offer({ visible: true, rect: { x: frame, y: frame, width: 100 + frame, height: 100 } });
  assert.equal(published.length, 1, "a live page is never hidden or moved mid-motion");
  commit.release();
  assert.deepEqual(published.slice(1), [{ visible: true, rect: { x: 11, y: 11, width: 111, height: 100 } }]);
  commit.release();
  assert.equal(published.length, 2);
  commit.hold();
  commit.release();
  assert.equal(published.length, 2, "a hold with no measurement publishes nothing");
});

function fakeNode() {
  const attributes = new Set();
  const animations = [];
  return {
    attributes,
    animations,
    setAttribute: (name) => attributes.add(name),
    removeAttribute: (name) => attributes.delete(name),
    animate(frames, options) {
      let settle;
      const finished = new Promise((resolve, reject) => (settle = { resolve, reject }));
      finished.catch(() => {});
      const animation = { frames, options, cancelled: false, finished, cancel() { this.cancelled = true; settle.reject(new Error("AbortError")); }, finish: () => settle.resolve() };
      animations.push(animation);
      return animation;
    },
  };
}

test("the animator releases the very node it marked, even after the root is replaced", () => {
  const first = fakeNode();
  const second = fakeNode();
  let root = first;
  let settled = 0;
  const animator = createWebAnimator(() => root, () => null, () => null, () => settled++);
  animator.hold();
  assert.ok(first.attributes.has(PEEK_MOVING_ATTRIBUTE));
  root = second;
  animator.release();
  assert.equal(first.attributes.has(PEEK_MOVING_ATTRIBUTE), false);
  assert.equal(second.attributes.has(PEEK_MOVING_ATTRIBUTE), false);
  assert.equal(settled, 1);
  animator.release();
  assert.equal(settled, 1);
});

test("one interrupted animation cancels its sibling before the run settles, and a restart cancels both", async () => {
  const card = fakeNode();
  const scrim = fakeNode();
  const animator = createWebAnimator(() => fakeNode(), () => card, () => scrim, () => {});
  const motion = stageMotion("enter", geometry, false);
  const run = animator.run("enter", motion);
  card.animations[0].cancel();
  await assert.rejects(run);
  assert.equal(scrim.animations[0].cancelled, true);
  const again = animator.run("close", stageMotion("close", geometry, false));
  void animator.run("promote", stageMotion("promote", geometry, false));
  assert.equal(card.animations[1].cancelled, true);
  assert.equal(scrim.animations[1].cancelled, true);
  await assert.rejects(again);
  for (const node of [card, scrim]) assert.equal(node.animations[2].cancelled, false);
});

test("disposing mid-move cancels every animation before releasing the hold", () => {
  const root = fakeNode();
  const card = fakeNode();
  const scrim = fakeNode();
  const order = [];
  const animator = createWebAnimator(() => root, () => card, () => scrim, () => order.push("released"));
  const controller = createStageController({ ...animator, cancel: () => { animator.cancel(); order.push(`cancelled ${card.animations.every((a) => a.cancelled) && scrim.animations.every((a) => a.cancelled)}`); } }, { state() {}, done() {} }, () => ({ geometry, reduceMotion: false }));
  controller.begin(1);
  assert.ok(root.attributes.has(PEEK_MOVING_ATTRIBUTE));
  controller.dispose();
  assert.deepEqual(order, ["cancelled true", "released"]);
  assert.equal(root.attributes.has(PEEK_MOVING_ATTRIBUTE), false);
});

test("a close or promote reports done while the hold is still on, so nothing reads bounds mid-move", async () => {
  const h = controllerHarness();
  const seen = [];
  h.controller.begin(1);
  h.runs[0].resolve();
  await tick();
  h.controller.promote(1);
  const originalDone = h.done.push.bind(h.done);
  h.done.push = (entry) => { seen.push(h.held()); return originalDone(entry); };
  h.runs[1].resolve();
  await tick();
  assert.deepEqual(seen, [true]);
  assert.equal(h.held(), false);
});

test("a scrim animate() that throws cancels the card animation already started and releases the moving marker", async () => {
  const root = fakeNode();
  const card = fakeNode();
  const scrim = { ...fakeNode(), animate() { throw new Error("animate failed"); } };
  let settledBounds = 0;
  const states = [];
  const animator = createWebAnimator(() => root, () => card, () => scrim, () => settledBounds++);
  const controller = createStageController(animator, { state: (phase) => states.push(phase), done() {} }, () => ({ geometry, reduceMotion: false }));
  controller.begin(1);
  assert.equal(card.animations[0].cancelled, true, "the card animation is cancelled at once");
  await tick();
  assert.equal(root.attributes.has(PEEK_MOVING_ATTRIBUTE), false);
  assert.equal(settledBounds, 1);
  assert.deepEqual(states, ["entering", "open"]);
});

test("an animator whose run throws synchronously still releases the hold", async () => {
  const released = [];
  const controller = createStageController({ hold() { released.push("hold"); }, release() { released.push("release"); }, cancel() {}, run() { throw new Error("boom"); } }, { state() {}, done() {} }, () => ({ geometry, reduceMotion: false }));
  assert.equal(controller.begin(1), true);
  await tick();
  assert.deepEqual(released, ["hold", "release"]);
});

test("a card animation cancelled because the scrim's animate() threw never surfaces an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const card = {
      setAttribute() {},
      removeAttribute() {},
      animate() {
        let reject;
        const finished = new Promise((_resolve, rejectFinished) => (reject = rejectFinished));
        return { finished, cancel: () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })) };
      },
    };
    const scrim = { setAttribute() {}, removeAttribute() {}, animate() { throw new Error("animate failed"); } };
    const animator = createWebAnimator(() => fakeNode(), () => card, () => scrim, () => {});
    await assert.rejects(animator.run("enter", stageMotion("enter", geometry, false)), /animate failed/);
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("closing during the entrance continues from the card's live transform and opacity, over the share of the close the entrance covered", async () => {
  const root = fakeNode();
  const card = fakeNode();
  const scrim = fakeNode();
  const live = new Map([[card, { transform: "matrix(0.5, 0, 0, 0.5, -120, -80)", opacity: 0.6 }], [scrim, { opacity: 0.4 }]]);
  const animator = createWebAnimator(() => root, () => card, () => scrim, () => {}, (node) => live.get(node) ?? null);
  const done = [];
  const controller = createStageController(animator, { state() {}, done: (generation, outcome) => done.push(outcome) }, () => ({ geometry, reduceMotion: false }));
  controller.begin(1);
  card.animations[0].currentTime = 80;
  assert.equal(controller.close(1), true);
  assert.equal(card.animations[0].cancelled, true);
  const closing = card.animations[1];
  assert.deepEqual(closing.frames[0], { transform: "matrix(0.5, 0, 0, 0.5, -120, -80)", opacity: 0.6 }, "no jump back to full size and opacity");
  assert.equal(closing.frames.at(-1).transform, collapsedTransform(geometry));
  assert.equal(closing.options.duration, Math.round(STEP_MS * 80 / ENTER_MS));
  assert.deepEqual(scrim.animations[1].frames[0], { opacity: 0.4 });
  assert.ok(compositorOnly(closing.frames));
  closing.finish();
  scrim.animations[1].finish();
  await tick();
  assert.deepEqual(done, ["closed"]);
});

test("a close after the entrance settled, or a first move, keeps its full keyframes and duration", () => {
  const card = fakeNode();
  const scrim = fakeNode();
  const animator = createWebAnimator(() => fakeNode(), () => card, () => scrim, () => {}, () => ({ transform: "matrix(1, 0, 0, 1, 0, 0)", opacity: 1 }));
  animator.run("enter", stageMotion("enter", geometry, false)).catch(() => {});
  assert.deepEqual(card.animations[0].frames[0], stageMotion("enter", geometry, false).card[0]);
  card.animations[0].currentTime = ENTER_MS;
  animator.run("close", stageMotion("close", geometry, false)).catch(() => {});
  assert.equal(card.animations[1].options.duration, STEP_MS);
  animator.cancel();
  const plain = stageMotion("close", geometry, false);
  assert.deepEqual(continuedMotion(plain, { card: null, scrim: null }, 1), plain);
  const snap = stageMotion("close", geometry, true);
  assert.deepEqual(continuedMotion(snap, { card: { transform: "matrix(2, 0, 0, 2, 0, 0)", opacity: 0.2 }, scrim: null }, 0.5), snap);
  assert.equal(continuedMotion(plain, { card: null, scrim: null }, Number.NaN).duration, STEP_MS);
});

test("the live presentation reads the computed transform and opacity, treating none as identity", () => {
  const saved = globalThis.getComputedStyle;
  try {
    globalThis.getComputedStyle = () => ({ transform: "none", opacity: "0.25" });
    assert.deepEqual(computedPresentation({}), { transform: "translate(0px, 0px) scale(1, 1)", opacity: 0.25 });
    globalThis.getComputedStyle = () => ({ transform: "matrix(0.3, 0, 0, 0.3, 4, 5)", opacity: "" });
    assert.deepEqual(computedPresentation({}), { transform: "matrix(0.3, 0, 0, 0.3, 4, 5)" });
    delete globalThis.getComputedStyle;
    assert.equal(computedPresentation({}), null);
  } finally {
    if (saved) globalThis.getComputedStyle = saved;
  }
});
