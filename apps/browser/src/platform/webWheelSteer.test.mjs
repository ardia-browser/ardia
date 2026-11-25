import assert from "node:assert/strict";
import { test } from "node:test";
import { attachWebWheelArea, glideWebScroll, STANDARD_WHEEL_TUNING, steerWebScroll, WheelSteer } from "./webWheelSteer.ts";

const blocked = { lo: 130, hi: 130, forward: false, back: false };
const forwardOnly = { lo: 130, hi: 130, forward: true, back: false };
const tall = { lo: 100, hi: 260, forward: true, back: true };

test("blocked edges produce zero scroll movement and never snap back", () => {
  const steer = new WheelSteer();
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(steer.read({ dy: -20, precise: true }, 130, blocked, i * 16), { kind: "none" });
    assert.deepEqual(steer.read({ dy: 20, precise: true }, 130, blocked, i * 16 + 8), { kind: "none" });
  }
  assert.deepEqual(steer.read({ dy: -1, precise: false }, 130, blocked, 500), { kind: "none" });
});

test("allowed edge follows with rubber band then commits past threshold", () => {
  const steer = new WheelSteer();
  const pull = steer.read({ dy: -15, precise: true }, 130, forwardOnly, 0);
  assert.deepEqual(pull, { kind: "place", y: 130 + 15 * STANDARD_WHEEL_TUNING.follow });
  const move = steer.read({ dy: -20, precise: true }, 136, forwardOnly, 16);
  assert.deepEqual(move, { kind: "move", direction: 1 });
  assert.deepEqual(steer.read({ dy: -20, precise: true }, 136, forwardOnly, 32), { kind: "none" });
});

test("partial pull without commit settles back on end", () => {
  const steer = new WheelSteer();
  assert.equal(steer.read({ dy: -10, precise: true }, 130, forwardOnly, 0).kind, "place");
  assert.deepEqual(steer.read({ dy: 0, phase: "ended", precise: true }, 134, forwardOnly, 16), { kind: "settle" });
});

test("tall question scrolls inside range and rests at edge before advancing", () => {
  const steer = new WheelSteer();
  assert.deepEqual(steer.read({ dy: -40, precise: true }, 100, tall, 0), { kind: "place", y: 140 });
  assert.deepEqual(steer.read({ dy: -200, precise: true }, 140, tall, 16), { kind: "place", y: 260 });
  assert.deepEqual(steer.read({ dy: -40, precise: true }, 260, tall, 32), { kind: "none" });
  assert.deepEqual(steer.read({ dy: -40, precise: true }, 260, tall, 32 + STANDARD_WHEEL_TUNING.edgeRestMs), { kind: "move", direction: 1 });
});

test("mouse wheel notches ease inside tall question and respect glide hold", () => {
  const steer = new WheelSteer();
  assert.deepEqual(steer.read({ dy: -1, precise: false }, 100, tall, 0), { kind: "ease", y: 140 });
  const move = steer.read({ dy: -1, precise: false }, 130, forwardOnly, 1000);
  assert.deepEqual(move, { kind: "move", direction: 1 });
  steer.glideStarted(600, 1010);
  assert.deepEqual(steer.read({ dy: -1, precise: false }, 130, forwardOnly, 1200), { kind: "none" });
  assert.deepEqual(steer.read({ dy: -40, precise: true }, 130, forwardOnly, 1220), { kind: "none" });
  assert.deepEqual(steer.read({ dy: -1, precise: false }, 130, forwardOnly, 1500), { kind: "move", direction: 1 });
});

function fakeDom() {
  class FakeElement {
    scrollTop = 0;
    parentElement = null;
    listeners = new Map();
    addEventListener(type, fn) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
    }
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === this) return true;
      return false;
    }
    dispatch(type, event) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    }
  }
  const prevElement = globalThis.HTMLElement;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  let rafId = 0;
  const rafs = new Map();
  globalThis.HTMLElement = FakeElement;
  globalThis.requestAnimationFrame = (cb) => {
    const id = ++rafId;
    rafs.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafs.delete(id);
  };
  return {
    FakeElement,
    rafs,
    restore() {
      globalThis.HTMLElement = prevElement;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCancel;
    },
  };
}

test("DOM WheelArea supports touch scrolling, ignores ctrl-wheel zoom, respects reduced motion, retargets glides on resize, and reattaches cleanly", () => {
  const dom = fakeDom();
  try {
    const host = new dom.FakeElement();
    const scroller = new dom.FakeElement();
    scroller.parentElement = host;
    const steps = [];
    let detach = attachWebWheelArea(host, () => (d) => steps.push(d));

    assert.equal(steerWebScroll(scroller, 100, 260, 0, true, true), true);
    assert.equal(scroller.scrollTop, 100);

    let prevented = false;
    host.dispatch("wheel", { deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: true, metaKey: false, preventDefault: () => (prevented = true) });
    assert.equal(prevented, false);
    assert.equal(scroller.scrollTop, 100);

    host.dispatch("wheel", { deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
    assert.equal(dom.rafs.size, 0);
    assert.equal(scroller.scrollTop, 140);

    let touchPrevented = false;
    host.dispatch("touchstart", { target: scroller, touches: [{ identifier: 1, clientX: 50, clientY: 200 }] });
    host.dispatch("touchmove", { touches: [{ identifier: 1, clientX: 50, clientY: 140 }], cancelable: true, preventDefault: () => (touchPrevented = true) });
    assert.equal(touchPrevented, true);
    assert.equal(scroller.scrollTop, 200);
    host.dispatch("touchend", { changedTouches: [{ identifier: 1 }] });

    assert.equal(steerWebScroll(scroller, 130, 130, 0, true, false), true);
    assert.equal(scroller.scrollTop, 130);
    host.dispatch("touchstart", { target: scroller, touches: [{ identifier: 2, clientX: 50, clientY: 200 }] });
    host.dispatch("touchmove", { touches: [{ identifier: 2, clientX: 50, clientY: 185 }], cancelable: true, preventDefault: () => {} });
    assert.equal(scroller.scrollTop, 136);
    host.dispatch("touchstart", { target: scroller, touches: [{ identifier: 2, clientX: 50, clientY: 185 }, { identifier: 3, clientX: 90, clientY: 185 }] });
    assert.equal(scroller.scrollTop, 130);

    assert.equal(steerWebScroll(scroller, 100, 500, 420, true, true), true);
    scroller.scrollTop = 250;
    assert.equal(glideWebScroll(scroller, 500, 420), true);
    host.dispatch("wheel", { deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault: () => {} });
    assert.equal(scroller.scrollTop, 240);

    scroller.scrollTop = 130;
    assert.equal(glideWebScroll(scroller, 520, 420), true);
    assert.equal(steerWebScroll(scroller, 520, 680, 420, true, true), true);
    assert.equal(dom.rafs.size, 1);
    const glideRafId = [...dom.rafs.keys()][0];
    host.dispatch("wheel", { deltaX: 0, deltaY: 10, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault: () => {} });
    assert.equal(scroller.scrollTop, 130);
    assert.deepEqual([...dom.rafs.keys()], [glideRafId]);
    host.dispatch("touchstart", { target: scroller, touches: [{ identifier: 4, clientX: 50, clientY: 200 }] });
    host.dispatch("touchmove", { touches: [{ identifier: 4, clientX: 50, clientY: 170 }], cancelable: true, preventDefault: () => {} });
    host.dispatch("touchend", { changedTouches: [{ identifier: 4 }] });
    assert.equal(scroller.scrollTop, 130);
    assert.deepEqual([...dom.rafs.keys()], [glideRafId]);
    host.dispatch("touchstart", { target: scroller, touches: [{ identifier: 5, clientX: 50, clientY: 200 }] });
    host.dispatch("touchmove", { touches: [{ identifier: 5, clientX: 50, clientY: 170 }], cancelable: true, preventDefault: () => {} });
    host.dispatch("touchstart", { target: scroller, touches: [{ identifier: 5, clientX: 50, clientY: 170 }, { identifier: 6, clientX: 90, clientY: 170 }] });
    assert.equal(scroller.scrollTop, 130);
    assert.deepEqual([...dom.rafs.keys()], [glideRafId]);
    scroller.scrollTop = 540;
    host.dispatch("wheel", { deltaX: 0, deltaY: 10, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault: () => {} });
    assert.equal(scroller.scrollTop, 550);
    assert.equal(dom.rafs.size, 0);

    assert.equal(steerWebScroll(scroller, 200, 200, 420, true, true), true);
    assert.equal(glideWebScroll(scroller, 286, 420), true);
    assert.equal(dom.rafs.size, 1);
    assert.equal(steerWebScroll(scroller, 520, 520, 0, true, true), true);
    assert.equal(dom.rafs.size, 0);
    assert.equal(scroller.scrollTop, 520);

    detach();
    detach = attachWebWheelArea(host, () => (d) => steps.push(d));
    assert.equal(steerWebScroll(scroller, 100, 260, 0, true, true), true);
    assert.equal(scroller.scrollTop, 260);
    host.dispatch("wheel", { deltaX: 0, deltaY: -40, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault: () => {} });
    assert.equal(scroller.scrollTop, 220);
    detach();
  } finally {
    dom.restore();
  }
});
