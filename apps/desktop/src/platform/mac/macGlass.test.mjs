import assert from "node:assert/strict";
import test from "node:test";
import { animationMovesBackdrop, fadesOnly, BACKDROP_METHOD, BACKDROP_RETRY_MS, createMacBackdrops, measureBackdrop, WINDOW_TREATMENT_CAPABILITY, windowBackdropMaterial } from "./macGlass.ts";

function harness({ fail = () => false } = {}) {
  const sent = [];
  const frames = [];
  const timers = [];
  const watched = new Map();
  const rects = new Map();
  const replies = [];
  let motion = null;
  let animating = false;
  const backdrops = createMacBackdrops({
    send: (regions) => {
      sent.push(regions);
      const reply = fail(sent.length) ? Promise.reject(new Error("host refused")) : Promise.resolve();
      replies.push(reply.catch(() => {}));
      return reply;
    },
    measure: (element) => rects.get(element) ?? null,
    frame: (run) => frames.push(run),
    timeout: (run, ms) => (timers.push({ run, ms }), timers.length),
    clearTimeout: () => {},
    watch: (element, changed) => {
      watched.set(element, changed);
      return () => watched.delete(element);
    },
    watchMotion: (changed) => {
      motion = changed;
      return () => (motion = null);
    },
    animating: () => animating,
  });
  const settle = async () => {
    await Promise.all(replies);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const runFrames = async () => {
    frames.splice(0).forEach((run) => run());
    await settle();
  };
  return { sent, frames, timers, watched, rects, backdrops, runFrames, motion: () => motion, setAnimating: (value) => (animating = value) };
}

test("the Mac WebUI asks the host for glass behind the window where each vibrancy backdrop sits, once per frame", async () => {
  assert.equal(BACKDROP_METHOD, "shell.backdropRegions");
  const { sent, frames, watched, rects, backdrops, runFrames } = harness();
  const sidebar = {};
  const toolbar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  rects.set(toolbar, { x: 240, y: 0, width: 1000, height: 40 });
  backdrops.add(sidebar);
  backdrops.add(toolbar, "sidebar");
  assert.equal(frames.length, 1, "two layers in one frame send once");
  await runFrames();
  assert.deepEqual(sent, [[{ rect: { x: 0, y: 0, width: 240, height: 800 }, material: "liquid" }, { rect: { x: 240, y: 0, width: 1000, height: 40 }, material: "sidebar" }]]);
  watched.get(sidebar)();
  await runFrames();
  assert.equal(sent.length, 1, "an unchanged layout sends nothing");
  rects.set(sidebar, { x: 0, y: 0, width: 300, height: 800 });
  watched.get(sidebar)();
  await runFrames();
  assert.equal(sent.at(-1)[0].rect.width, 300);
});

test("a backdrop moved without resizing, by an ancestor's transform or a running transition, keeps its glass under it", async () => {
  const { sent, rects, backdrops, runFrames, motion, setAnimating, frames } = harness();
  const sidebar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  backdrops.add(sidebar);
  await runFrames();
  rects.set(sidebar, { x: -120, y: 0, width: 240, height: 800 });
  motion()();
  await runFrames();
  assert.equal(sent.at(-1)[0].rect.x, -120, "a style or class change on an ancestor re-measures");
  setAnimating(true);
  motion()();
  for (const x of [-80, -40, 0]) {
    rects.set(sidebar, { x, y: 0, width: 240, height: 800 });
    await runFrames();
    assert.equal(sent.at(-1)[0].rect.x, x, "every frame of a slide is followed");
  }
  setAnimating(false);
  await runFrames();
  assert.equal(frames.length, 0, "the frame loop stops once nothing animates");
});

test("a send the host refuses is retried, and only an accepted layout counts as sent", async () => {
  const { sent, timers, rects, backdrops, runFrames } = harness({ fail: (n) => n === 1 });
  const sidebar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  backdrops.add(sidebar);
  await runFrames();
  assert.equal(sent.length, 1);
  assert.equal(timers.length, 1, "a refused send schedules a retry");
  assert.equal(timers[0].ms, BACKDROP_RETRY_MS);
  timers[0].run();
  await runFrames();
  assert.equal(sent.length, 2, "the same layout is sent again after a refusal");
  backdrops.flushNow();
  await runFrames();
  assert.equal(sent.length, 2, "once accepted, the layout isn't sent again");
});

test("frames that move a backdrop while a refused send waits for its retry send nothing until the retry, then the latest layout once", async () => {
  const { sent, timers, rects, backdrops, runFrames, motion, setAnimating } = harness({ fail: (n) => n === 1 });
  const sidebar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  backdrops.add(sidebar);
  await runFrames();
  assert.equal(sent.length, 1);
  assert.equal(timers.length, 1);
  setAnimating(true);
  motion()();
  for (const x of [-60, -40, -20, -10]) {
    rects.set(sidebar, { x, y: 0, width: 240, height: 800 });
    await runFrames();
  }
  assert.equal(sent.length, 1, "no send while the retry waits, however many frames move the backdrop");
  setAnimating(false);
  await runFrames();
  timers[0].run();
  await runFrames();
  assert.equal(sent.length, 2, "one send when the retry comes due");
  assert.equal(sent.at(-1)[0].rect.x, -10, "and it carries the latest layout");
  assert.equal(timers.length, 1, "an accepted retry schedules no more retries");
});

test("a hidden or removed backdrop takes its glass away, and the material follows the setting", async () => {
  const { sent, watched, rects, backdrops, runFrames, motion } = harness();
  const sidebar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  const remove = backdrops.add(sidebar);
  await runFrames();
  backdrops.setMaterial("underWindow");
  await runFrames();
  assert.equal(sent.at(-1)[0].material, "underWindow");
  rects.delete(sidebar);
  watched.get(sidebar)();
  await runFrames();
  assert.deepEqual(sent.at(-1), []);
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  watched.get(sidebar)();
  await runFrames();
  remove();
  assert.equal(watched.size, 0, "removing stops watching");
  assert.equal(motion(), null, "the last backdrop stops watching for motion");
  await runFrames();
  assert.deepEqual(sent.at(-1), []);
  assert.equal(backdrops.size(), 0);
});

const fakeElement = (rect, { connected = true, children = [] } = {}) => ({
  isConnected: connected,
  getBoundingClientRect: () => rect,
  contains(other) {
    return other === this || children.some((child) => child === other || child.contains?.(other));
  },
});

test("a connected backdrop with a size but visibility hidden or collapse gets no glass", () => {
  const rect = { x: 10, y: 20, width: 240, height: 800 };
  const element = fakeElement(rect);
  assert.deepEqual(measureBackdrop(element, () => ({ visibility: "visible" })), { x: 10, y: 20, width: 240, height: 800 });
  assert.equal(measureBackdrop(element, () => ({ visibility: "hidden" })), null);
  assert.equal(measureBackdrop(element, () => ({ visibility: "collapse" })), null);
  assert.deepEqual(measureBackdrop(element, () => null), { x: 10, y: 20, width: 240, height: 800 }, "without computed styles the rect decides");
  assert.equal(measureBackdrop(fakeElement(rect, { connected: false }), () => ({ visibility: "visible" })), null);
  assert.equal(measureBackdrop(fakeElement({ x: 0, y: 0, width: 0, height: 10 }), () => ({ visibility: "visible" })), null);
});

test("only animations on a backdrop or one of its ancestors keep glass following every frame", () => {
  const backdrop = fakeElement({ x: 0, y: 0, width: 1, height: 1 });
  const sidebar = fakeElement({ x: 0, y: 0, width: 1, height: 1 }, { children: [backdrop] });
  const spinner = fakeElement({ x: 0, y: 0, width: 1, height: 1 });
  const running = (target) => ({ playState: "running", effect: { target } });
  assert.equal(animationMovesBackdrop([running(spinner)], [backdrop]), false, "a spinner elsewhere doesn't");
  assert.equal(animationMovesBackdrop([running(backdrop)], [backdrop]), true, "the backdrop itself does");
  assert.equal(animationMovesBackdrop([running(sidebar)], [backdrop]), true, "an ancestor sliding does");
  assert.equal(animationMovesBackdrop([{ playState: "finished", effect: { target: sidebar } }], [backdrop]), false, "a finished slide doesn't");
  assert.equal(animationMovesBackdrop([{ playState: "running", effect: null }], [backdrop]), false);
  assert.equal(animationMovesBackdrop([running(spinner)], []), false);
});

test("the frame loop passes the registered backdrops, so an unrelated animation doesn't keep it running", async () => {
  const seen = [];
  const frames = [];
  const sidebar = {};
  const backdrops = createMacBackdrops({
    send: async () => {},
    measure: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    frame: (run) => frames.push(run),
    timeout: () => 0,
    clearTimeout: () => {},
    watch: () => () => {},
    watchMotion: () => () => {},
    animating: (layers) => (seen.push(layers), false),
  });
  backdrops.add(sidebar);
  frames.splice(0).forEach((run) => run());
  assert.deepEqual(seen, [[sidebar]]);
  assert.equal(frames.length, 0);
});

test("the window backdrop asks for the Mac app's vibrancy treatment, never Liquid Glass with its rim, where the host can draw it", async () => {
  assert.equal(windowBackdropMaterial((method) => method === WINDOW_TREATMENT_CAPABILITY), "windowTreatment");
  assert.equal(windowBackdropMaterial(() => false), "liquid", "an older engine keeps the glass it knows");
  const source = (await import("node:fs")).readFileSync(new URL("../windowGlass.mac.ts", import.meta.url), "utf8");
  assert.match(source, /return backdrops\.add\(element, windowBackdropMaterial\(\(method\) => hostSupports\(method\)\), theme\);/);
  const { sent, rects, backdrops, runFrames } = harness();
  const window = {};
  rects.set(window, { x: 0, y: 0, width: 1280, height: 800 });
  backdrops.add(window, "windowTreatment");
  await runFrames();
  assert.deepEqual(sent, [[{ rect: { x: 0, y: 0, width: 1280, height: 800 }, material: "windowTreatment" }]]);
});

test("profile pages stacked over the same window rect ask the host for one backdrop, not one per page", async () => {
  const { sent, rects, backdrops, runFrames } = harness();
  const pages = [{}, {}, {}];
  for (const page of pages) {
    rects.set(page, { x: 0, y: 0, width: 1280, height: 800 });
    backdrops.add(page, "windowTreatment");
  }
  const sidebar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  backdrops.add(sidebar, "windowTreatment");
  await runFrames();
  assert.deepEqual(sent, [[{ rect: { x: 0, y: 0, width: 1280, height: 800 }, material: "windowTreatment" }, { rect: { x: 0, y: 0, width: 240, height: 800 }, material: "windowTreatment" }]]);
});

test("a fade on a backdrop's ancestor moves nothing, so an idle window with one profile drains its frame queue", async () => {
  const backdrop = fakeElement({ x: 0, y: 0, width: 1280, height: 800 });
  const tintLayer = fakeElement({ x: 0, y: 0, width: 1280, height: 800 }, { children: [backdrop] });
  const fade = { playState: "running", effect: { target: tintLayer, getKeyframes: () => [{ offset: 0, computedOffset: 0, easing: "linear", composite: "auto", opacity: "1" }, { offset: 1, computedOffset: 1, easing: "linear", composite: "auto", opacity: "1" }] } };
  const slide = { playState: "running", effect: { target: tintLayer, getKeyframes: () => [{ offset: 0, transform: "translateX(0px)" }, { offset: 1, transform: "translateX(40px)" }] } };
  assert.equal(fadesOnly(fade), true);
  assert.equal(fadesOnly(slide), false);
  assert.equal(fadesOnly({ playState: "running", effect: { target: tintLayer } }), false, "without keyframes an animation still counts as motion");
  assert.equal(fadesOnly({ playState: "running", effect: { target: tintLayer, getKeyframes: () => [] } }), true, "an empty keyframe list moves nothing");
  assert.equal(animationMovesBackdrop([fade], [backdrop]), false);
  assert.equal(animationMovesBackdrop([fade, slide], [backdrop]), true);
  const frames = [];
  let measured = 0;
  const backdrops = createMacBackdrops({
    send: async () => {},
    measure: () => (measured++, { x: 0, y: 0, width: 1280, height: 800 }),
    frame: (run) => frames.push(run),
    timeout: () => 0,
    clearTimeout: () => {},
    watch: () => () => {},
    watchMotion: () => () => {},
    animating: (layers) => animationMovesBackdrop([fade], layers),
  });
  backdrops.add(backdrop, "windowTreatment");
  for (let i = 0; i < 5 && frames.length; i++) frames.splice(0).forEach((run) => run());
  assert.equal(frames.length, 0, "no frame is queued once the backdrop is sent");
  assert.equal(measured, 1);
});
