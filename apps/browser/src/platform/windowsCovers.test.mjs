import assert from "node:assert/strict";
import { test } from "node:test";
import { holesFor } from "../../../../packages/expo-windows/src/engine/covers.ts";

const card = { x: 100, y: 50, width: 600, height: 400, radius: 12 };
const popover = { x: 650, y: 60, width: 200, height: 100, radius: 8 };

test("a Peek's page keeps the card behind it, and the page under the Peek gets the card's hole", () => {
  const peekPage = { x: 110, y: 90, width: 580, height: 350 };
  const basePage = { x: 0, y: 40, width: 900, height: 600 };
  assert.deepEqual(holesFor(peekPage, [card, popover], true), [[650, 60, 200, 100, 8]], "a popover over part of the Peek still cuts it");
  assert.deepEqual(holesFor(basePage, [card, popover], false), [
    [100, 50, 600, 400, 12],
    [650, 60, 200, 100, 8],
  ]);
  assert.deepEqual(holesFor(peekPage, [card], false), [[100, 50, 600, 400, 12]], "an ordinary page under a cover that encloses it is still hidden");
  assert.deepEqual(holesFor(peekPage, [{ x: 0, y: 0, width: 50, height: 50, radius: 0 }], true), [], "a cover elsewhere cuts nothing");
});

test("the intro's page sits above the whole window, so the browser's covers under it cut no holes in it", () => {
  const introPage = { x: 0, y: 0, width: 1300, height: 860 };
  const sidebarField = { x: 20, y: 38, width: 215, height: 42, radius: 10 };
  const newTabSearch = { x: 356, y: 300, width: 815, height: 140, radius: 16 };
  assert.equal(holesFor(introPage, [sidebarField, newTabSearch], false).length, 2, "an ordinary page under them would be cut");
  assert.deepEqual(holesFor(introPage, [sidebarField, newTabSearch], false, true), []);
});

const { coversIn } = await import("../../../../packages/expo-windows/src/engine/covers.ts");
const { coverClip, coverMeasurer, watchClips } = await import("../../../../packages/expo-windows/src/engine/coverClip.ts");

const node = (x, y, width, height) => ({ box: { x, y, width, height }, measureInWindow(callback) {
  setTimeout(() => callback(this.box.x, this.box.y, this.box.width, this.box.height), 0);
} });

test("a surface on the next profile's sidebar page, clipped out beside the sidebar, cuts no hole in the page", async () => {
  const windowId = "clip-window";
  const sidebarPages = node(8, 44, 240, 600);
  const page = { x: 256, y: 8, width: 900, height: 640 };
  const currentRow = node(14, 52, 228, 34);
  const nextProfileRow = node(254, 52, 228, 34);
  const clips = [coverClip(() => sidebarPages)];
  const current = coverMeasurer(windowId, "current-row", 10, () => currentRow, clips);
  const next = coverMeasurer(windowId, "next-row", 10, () => nextProfileRow, clips);
  await Promise.all([current.measure(), next.measure()]);
  assert.deepEqual(coversIn(windowId), [{ x: 14, y: 52, width: 228, height: 34, radius: 10 }], "only the row inside the sidebar is a cover");
  assert.deepEqual(holesFor(page, coversIn(windowId), false), [], "the page beside the sidebar keeps no hole");

  nextProfileRow.box.x = 134;
  await next.measure();
  assert.deepEqual(coversIn(windowId).at(-1), { x: 134, y: 52, width: 114, height: 34, radius: 10 }, "mid-swipe, the part still inside the sidebar stays a cover");

  nextProfileRow.box.x = 254;
  await next.measure();
  assert.equal(coversIn(windowId).length, 1, "swiped back out, its cover goes");

  const menu = node(300, 60, 200, 100);
  const unclipped = coverMeasurer(windowId, "menu", 8, () => menu, []);
  await unclipped.measure();
  assert.deepEqual(holesFor(page, coversIn(windowId), false), [[300, 60, 200, 100, 8]], "a surface under no clip still cuts its hole");
});

test("a measurement that lands after the surface stopped never brings its cover back", async () => {
  const windowId = "late-window";
  const surface = node(0, 0, 50, 50);
  const measurer = coverMeasurer(windowId, "late", 0, () => surface, []);
  const pending = measurer.measure();
  measurer.stop();
  await pending;
  assert.deepEqual(coversIn(windowId), []);
});

test("a clip that grows or moves without its surfaces laying out has them measured again", async () => {
  const windowId = "moving-clip-window";
  const strip = node(0, 0, 400, 40);
  const tab = node(380, 4, 120, 32);
  const clip = coverClip(() => strip);
  const measurer = coverMeasurer(windowId, "tab", 8, () => tab, [clip]);
  const measured = [];
  const unwatch = watchClips([clip], () => measured.push(measurer.measure()));
  await measurer.measure();
  assert.deepEqual(coversIn(windowId), [{ x: 380, y: 4, width: 20, height: 32, radius: 8 }]);
  strip.box.width = 900;
  clip.moved();
  await Promise.all(measured);
  assert.deepEqual(coversIn(windowId), [{ x: 380, y: 4, width: 120, height: 32, radius: 8 }], "the window grew, so the whole tab shows");
  unwatch();
  strip.box.width = 400;
  clip.moved();
  assert.equal(measured.length, 1, "a surface that stopped watching is not measured");
});

test("a surface told not to cover (a Peek hidden with its tab) cuts no hole, and cuts it again once it covers", async () => {
  const windowId = "gated-window";
  const page = { x: 256, y: 8, width: 900, height: 640 };
  const card = node(400, 80, 500, 400);
  const shown = coverMeasurer(windowId, "peek-card", 12, () => card, [], true);
  await shown.measure();
  assert.deepEqual(holesFor(page, coversIn(windowId), false), [[400, 80, 500, 400, 12]]);
  shown.stop();
  const hidden = coverMeasurer(windowId, "peek-card", 12, () => card, [], false);
  await hidden.measure();
  assert.deepEqual(coversIn(windowId), [], "hidden with its tab, its cover goes though it is still laid out");
  hidden.stop();
  const back = coverMeasurer(windowId, "peek-card", 12, () => card, []);
  await back.measure();
  assert.deepEqual(holesFor(page, coversIn(windowId), false), [[400, 80, 500, 400, 12]], "shown again, the hole is back");
  back.stop();
});

test("many motion requests share one in-flight measurement and drain one fresh pass", async () => {
  const callbacks = [];
  const surface = { measureInWindow: (callback) => callbacks.push(callback) };
  const measurer = coverMeasurer("coalesced-window", "surface", 0, () => surface, []);
  const requests = Array.from({ length: 100 }, () => measurer.measure());
  assert.equal(callbacks.length, 1);
  callbacks[0](0, 0, 50, 10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.length, 2);
  assert.equal(coversIn("coalesced-window")[0].height, 10, "a valid active result is published even with a newer request");
  callbacks[1](0, 0, 50, 20);
  await Promise.all(requests);
  assert.equal(coversIn("coalesced-window")[0].height, 20);
  measurer.stop();
});

test("node replacement releases a measurement whose removed native tag never answered", async () => {
  const callbacks = [];
  let current = { measureInWindow: (callback) => callbacks.push(callback) };
  const measurer = coverMeasurer("replaced-window", "surface", 0, () => current, []);
  const old = measurer.measure();
  current = node(5, 5, 30, 30);
  await measurer.measure();
  await old;
  callbacks[0](0, 0, 100, 100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coversIn("replaced-window")[0].width, 30);
  measurer.stop();
});

test("clip replacement invalidates its old measurement without blocking a newer pass", async () => {
  let oldCallback;
  let clipNode = { measureInWindow: (callback) => oldCallback = callback };
  const surface = node(0, 0, 100, 100);
  const measurer = coverMeasurer("replaced-clip-window", "surface", 0, () => surface, [coverClip(() => clipNode)]);
  const old = measurer.measure();
  clipNode = node(0, 0, 20, 20);
  await measurer.measure();
  await old;
  oldCallback(0, 0, 90, 90);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coversIn("replaced-clip-window")[0].width, 20);
  measurer.stop();
});

test("a missing callback times out and stop releases its pending promise", async () => {
  let reply = false;
  const surface = { measureInWindow: (callback) => { if (reply) callback(1, 2, 30, 40); } };
  const measurer = coverMeasurer("timeout-window", "surface", 0, () => surface, []);
  await measurer.measure();
  reply = true;
  await measurer.measure();
  assert.equal(coversIn("timeout-window")[0].height, 40);
  reply = false;
  const pending = measurer.measure();
  measurer.stop();
  await pending;
});

test("the final measurement still publishes at 150 ms after its wait timed out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let callback;
  const surface = { measureInWindow: (reply) => callback = reply };
  const measurer = coverMeasurer("late-idle-window", "surface", 8, () => surface, []);
  const pending = measurer.measure();
  t.mock.timers.tick(100);
  await pending;
  assert.deepEqual(coversIn("late-idle-window"), []);
  t.mock.timers.tick(50);
  callback(4, 8, 80, 40);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coversIn("late-idle-window"), [{ x: 4, y: 8, width: 80, height: 40, radius: 8 }]);
  measurer.stop();
});

test("a timed-out answer cannot overwrite a newer pass on the same native node", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const callbacks = [];
  const surface = { measureInWindow: (reply) => callbacks.push(reply) };
  const measurer = coverMeasurer("late-newer-window", "surface", 0, () => surface, []);
  const old = measurer.measure();
  t.mock.timers.tick(100);
  await old;
  const fresh = measurer.measure();
  callbacks[1](0, 0, 30, 40);
  await fresh;
  callbacks[0](0, 0, 90, 90);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coversIn("late-newer-window")[0].width, 30);
  measurer.stop();
});

test("a timeout drains a queued pass without letting the older answer publish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const callbacks = [];
  const surface = { measureInWindow: (reply) => callbacks.push(reply) };
  const measurer = coverMeasurer("late-dirty-window", "surface", 0, () => surface, []);
  const pending = [measurer.measure(), measurer.measure()];
  t.mock.timers.tick(100);
  assert.equal(callbacks.length, 2);
  callbacks[0](0, 0, 90, 90);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coversIn("late-dirty-window"), []);
  callbacks[1](0, 0, 30, 40);
  await Promise.all(pending);
  assert.equal(coversIn("late-dirty-window")[0].width, 30);
  measurer.stop();
});

test("a late answer after the timeout cannot revive a stopped surface", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let callback;
  const surface = { measureInWindow: (reply) => callback = reply };
  const measurer = coverMeasurer("late-stopped-window", "surface", 0, () => surface, []);
  const pending = measurer.measure();
  t.mock.timers.tick(100);
  await pending;
  measurer.stop();
  callback(0, 0, 90, 90);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coversIn("late-stopped-window"), []);
});

test("late answers validate surface and clip identities even without another request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const replaced of ["surface", "clip"]) {
    let callback;
    let surface = { measureInWindow: (reply) => callback = reply };
    let clip = { measureInWindow: (reply) => reply(0, 0, 100, 100) };
    const windowId = `late-identity-${replaced}`;
    const measurer = coverMeasurer(windowId, "surface", 0, () => surface, [coverClip(() => clip)]);
    const pending = measurer.measure();
    t.mock.timers.tick(100);
    await pending;
    if (replaced === "surface") surface = node(0, 0, 30, 30);
    else clip = node(0, 0, 30, 30);
    callback(0, 0, 90, 90);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(coversIn(windowId), []);
    measurer.stop();
  }
});

test("a stopped non-covering measurer cannot erase the replacement's cover", async () => {
  const windowId = "stopped-owner-window";
  const surface = node(4, 8, 80, 40);
  const hidden = coverMeasurer(windowId, "surface", 8, () => surface, [], false);
  await hidden.measure();
  hidden.stop();
  const shown = coverMeasurer(windowId, "surface", 8, () => surface, []);
  await shown.measure();
  await hidden.measure();
  assert.deepEqual(coversIn(windowId), [{ x: 4, y: 8, width: 80, height: 40, radius: 8 }]);
  shown.stop();
});

test("an unmounted non-covering measurer cannot erase a live cover", async () => {
  const windowId = "unmounted-owner-window";
  const surface = node(4, 8, 80, 40);
  const shown = coverMeasurer(windowId, "surface", 8, () => surface, []);
  await shown.measure();
  const unmounted = coverMeasurer(windowId, "surface", 8, () => null, [], false);
  await unmounted.measure();
  assert.deepEqual(coversIn(windowId), [{ x: 4, y: 8, width: 80, height: 40, radius: 8 }]);
  unmounted.stop();
  shown.stop();
});

test("covers publish during continuous motion when native answers take three frames", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let position = 0;
  const callbacks = [];
  const pending = [];
  const surface = { measureInWindow: (reply) => callbacks.push({ reply, x: position }) };
  const measurer = coverMeasurer("continuous-motion-window", "surface", 0, () => surface, []);
  for (let frame = 1; frame <= 9; frame++) {
    pending.push(measurer.measure());
    position += 16;
    t.mock.timers.tick(16);
    assert.equal(callbacks.length, 1, "one native pass remains in flight across frames");
    if (frame % 3 === 0) {
      const answer = callbacks.shift();
      answer.reply(answer.x, 0, 80, 40);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(coversIn("continuous-motion-window")[0].x, position - 48, "the hole moves before the animation stops");
    }
  }
  const final = callbacks.shift();
  assert.equal(final.x, position);
  final.reply(final.x, 0, 80, 40);
  await Promise.all(pending);
  assert.equal(callbacks.length, 0);
  assert.equal(coversIn("continuous-motion-window")[0].x, 144);
  measurer.stop();
});
