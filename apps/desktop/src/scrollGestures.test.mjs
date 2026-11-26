import assert from "node:assert/strict";
import test from "node:test";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const hostListeners = [];
const invoked = [];
const wheelListeners = [];
globalThis.HTMLElement = class {};
globalThis.Element = globalThis.HTMLElement;
globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", overflowX: "visible" });
globalThis.window = {
  addEventListener: (type, listener) => type === "wheel" && wheelListeners.push(listener),
  __ardiaHost: {
    bootstrap: { windowId: "main", profileId: "default", capabilities: ["shell.scrollGestures", "shell.pageSwipeClaim"] },
    invoke: (method, args) => (invoked.push([method, args]), Promise.resolve({ claimed: true })),
    onEvent: (listener) => (hostListeners.push(listener), () => {}),
  },
};

const card = { left: 0, top: 0, right: 240, bottom: 600, width: 240, height: 600 };
const page = Object.assign(new HTMLElement(), { parentElement: null, scrollWidth: 0, clientWidth: 0 });
const container = { contains: (element) => element === page || element === node, parentElement: null };
const node = { isConnected: true, parentElement: container, getClientRects: () => [card], getBoundingClientRect: () => card };
page.parentElement = container;
let hitElement = page;
globalThis.document = { elementFromPoint: () => hitElement };

const { addSwipeTarget, onScrollGesture, onPageSwipe, SCROLL_GESTURE_EVENT, SCROLL_GESTURES_CAPABILITY, PAGE_SWIPE_CLAIM } = await import("./shims/web/motion/swipe.ts");
const { PagerSpring } = await import("./shims/web/motion/pagerSpring.ts");
const { Pager, setPagerClock } = await import("./shims/web/motion/pager.ts");

const WIDTH = 240;
const FRAME = 1 / 60;
const at = { x: 120, y: 300 };
const host = (payload) => hostListeners.forEach((listener) => listener("ArdiaShell", SCROLL_GESTURE_EVENT, { ...at, momentum: "none", dx: 0, dy: 0, ...payload }));
const native = (payload, t) => onScrollGesture({ ...at, momentum: "none", dx: 0, dy: 0, ...payload }, t);

function swipeTarget(seen, { back = true, forward = true, pager = false, nativePager = null, tabId = null } = {}) {
  return {
    tabId: () => tabId,
    node: () => node,
    canSwipeBack: () => back,
    canSwipeForward: () => forward,
    tracksUnavailableDirections: () => pager,
    allowsVerticalMotion: () => false,
    isPager: () => pager,
    pager: () => nativePager,
    onSwipe: (event) => seen.push(event),
  };
}

function wheel({ deltaX = 0, deltaY = 0, timeStamp = 0 }) {
  const event = {
    deltaX,
    deltaY,
    deltaMode: 0,
    wheelDeltaX: -deltaX * 3,
    wheelDeltaY: -deltaY * 3,
    shiftKey: false,
    ctrlKey: false,
    clientX: at.x,
    clientY: at.y,
    timeStamp,
    target: page,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  wheelListeners.forEach((listener) => listener(event));
  return event;
}

function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  return {
    clock: {
      now: () => now,
      request: (step) => (pending.set(++id, step), id),
      cancel: (frame) => pending.delete(frame),
      reduceMotion: () => false,
      watchReduceMotion: () => () => {},
    },
    set(seconds) {
      now = seconds;
    },
    pump(limit = 600) {
      let frames = 0;
      while (pending.size && frames < limit) {
        now += FRAME;
        const steps = [...pending.values()];
        pending.clear();
        for (const step of steps) step(now * 1000);
        frames++;
      }
      return frames;
    },
  };
}

let pagerKeys = 0;
function pagerTarget(t, order) {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const states = [];
  const positions = [];
  const area = { pageWidth: () => WIDTH, attached: () => true, onPosition: (p) => positions.push(p), onState: (e) => states.push(e) };
  const pager = Pager.named(`scroll-gestures-${++pagerKeys}`);
  pager.attach(area);
  pager.configure({ key: pager.key, selected: 0, count: order.length, ack: 0, order });
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen, { pager: true, nativePager: { pager, area } }));
  t.after(() => {
    remove();
    pager.detach(area);
  });
  return { fake, pager, area, states, positions, seen };
}

function fling(t0, total = -720) {
  native({ phase: "mayBegin" }, t0);
  native({ phase: "began", dx: -6 }, t0 + 0.004);
  native({ phase: "changed", dx: total * 0.3 }, t0 + 0.008);
  native({ phase: "changed", dx: total * 0.7 }, t0 + 0.012);
  native({ phase: "ended" }, t0 + 0.014);
}

test("the Mac host's capability and event names are the ones swipe.ts listens for", () => {
  addSwipeTarget(swipeTarget([]))();
  assert.equal(SCROLL_GESTURES_CAPABILITY, "shell.scrollGestures");
  assert.equal(SCROLL_GESTURE_EVENT, "onScrollGesture");
  assert.equal(hostListeners.length, 1);
});

test("native phases drive the swipe overlay and it ends on the event the fingers lift with, with no timer", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  host({ phase: "mayBegin", t: 1 });
  host({ phase: "began", dx: 6, t: 1.01 });
  host({ phase: "changed", dx: 20, dy: 1, t: 1.02 });
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed"]);
  host({ phase: "ended", t: 1.03 });
  remove();
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
  assert.equal(seen[1].distance, 26);
  assert.equal(seen[0].direction, "back");
});

test("DOM wheel events never start, end or guess at a gesture while the host sends phases", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  native({ phase: "mayBegin" }, 4);
  native({ phase: "cancelled" }, 4.001);
  const magnitudes = [40, 36, 30, 22, 15, 9, 5, 2];
  const events = magnitudes.map((m, i) => wheel({ deltaX: -m, timeStamp: 5000 + i * 8 }));
  assert.deepEqual(seen, []);
  assert.ok(events.every((e) => !e.defaultPrevented), "an untracked wheel is the page's");
  native({ phase: "began", dx: 10 }, 6);
  const during = wheel({ deltaX: -10, timeStamp: 6001 });
  native({ phase: "changed", dx: 12 }, 6.01);
  native({ phase: "ended" }, 6.02);
  remove();
  assert.equal(during.defaultPrevented, true, "a tracked gesture's DOM wheel is held off the shell's scrollers");
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
});

test("momentum after a tracked swipe ends is swallowed and never re-engages a drag", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  native({ phase: "began", dx: 10 }, 10);
  native({ phase: "changed", dx: 30 }, 10.01);
  native({ phase: "ended" }, 10.02);
  native({ phase: "none", momentum: "began", dx: 25 }, 10.03);
  const coasting = wheel({ deltaX: -25, timeStamp: 10030 });
  for (let i = 0; i < 20; i++) native({ phase: "none", momentum: "changed", dx: 20 * 0.9 ** i }, 10.04 + i * 0.008);
  native({ phase: "none", momentum: "ended" }, 10.3);
  const after = wheel({ deltaX: -3, timeStamp: 10400 });
  remove();
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
  assert.equal(coasting.defaultPrevented, true);
  assert.equal(after.defaultPrevented, false);
});

test("momentum that starts too late, or follows an untracked gesture, stays the page's", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  native({ phase: "began", dx: 10 }, 20);
  native({ phase: "changed", dx: 30 }, 20.01);
  native({ phase: "ended" }, 20.02);
  native({ phase: "none", momentum: "began", dx: 10 }, 20.5);
  const late = wheel({ deltaX: -10, timeStamp: 20500 });
  native({ phase: "began", dx: 0, dy: 40 }, 21);
  native({ phase: "ended" }, 21.01);
  native({ phase: "none", momentum: "began", dy: 30 }, 21.02);
  const vertical = wheel({ deltaY: 30, timeStamp: 21020 });
  remove();
  assert.equal(late.defaultPrevented, false);
  assert.equal(vertical.defaultPrevented, false);
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
});

test("a mouse wheel click the host reports pages a pager once per click", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen, { pager: true }));
  native({ phase: "wheel", dx: -1 }, 30);
  native({ phase: "wheel", dx: 0, dy: -1 }, 30.1);
  remove();
  assert.deepEqual(seen.map((e) => [e.phase, e.direction]), [["wheel", "forward"]]);
});

test("malformed native scroll gestures are dropped and a valid control still passes", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  const shapes = [
    (v) => ({ phase: v, momentum: "none", dx: 10, dy: 0, x: 1, y: 1 }),
    (v) => ({ phase: "began", momentum: v, dx: 10, dy: 0, x: 1, y: 1 }),
    (v) => ({ phase: "began", momentum: "none", dx: v, dy: 0, x: 1, y: 1 }),
    (v) => ({ phase: "began", momentum: "none", dx: 10, dy: 0, x: v, y: 1 }),
    (v) => ({ phase: "began", momentum: "none", dx: 10, dy: 0, x: 1, y: 1, t: v }),
  ];
  for (const value of HOSTILE_VALUES) {
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1000) continue;
    for (const shape of shapes) {
      onScrollGesture(shape(value), 40);
      onScrollGesture({ phase: "ended", momentum: "none", dx: 0, dy: 0, x: 1, y: 1 }, 40.01);
    }
    onScrollGesture(value, 40);
  }
  native({ phase: "began", dx: 1e9 }, 41);
  native({ phase: "ended" }, 41.01);
  assert.deepEqual(seen, []);
  native({ phase: "began", dx: 10 }, 42);
  native({ phase: "ended" }, 42.01);
  remove();
  assert.deepEqual(seen.map((e) => e.phase), ["began", "ended"]);
});

test("however hard the fling, one gesture moves exactly one profile and its momentum moves none", (t) => {
  const order = ["a", "b", "c", "d"];
  const { fake, pager, states, positions } = pagerTarget(t, order);
  fake.set(100);
  fling(100, -2400);
  assert.equal(pager.snapshot().selected, 1, "landed on start + 1");
  assert.equal(pager.snapshot().phase, "settling");
  native({ phase: "none", momentum: "began", dx: -400 }, 100.02);
  for (let i = 0; i < 40; i++) native({ phase: "none", momentum: "changed", dx: -300 * 0.92 ** i }, 100.03 + i * 0.008);
  native({ phase: "none", momentum: "ended" }, 100.4);
  assert.equal(pager.snapshot().selected, 1, "momentum never advanced a second profile");
  assert.equal(states.filter((s) => s.phase === "began").length, 1, "momentum never re-engaged a drag");
  fake.pump();
  assert.equal(pager.snapshot().phase, "idle");
  assert.equal(positions.at(-1), 1);
  assert.deepEqual(states.filter((s) => s.phase === "selected").map((s) => s.profileId), ["b"]);
});

test("a second fling moves on from where the first was headed, still one profile per gesture", (t) => {
  const order = ["a", "b", "c", "d"];
  const { fake, pager, states } = pagerTarget(t, order);
  fake.set(200);
  fling(200, -2400);
  fake.pump(4);
  fling(200.1, -2400);
  assert.equal(pager.snapshot().selected, 2);
  fake.pump();
  assert.equal(pager.snapshot().position, 2);
  assert.deepEqual(states.filter((s) => s.phase === "selected").map((s) => s.profileId), ["b", "c"]);
});

test("the drag follows the fingers 1:1 at the pager's tracking scale and only rubber-bands past the last profile", (t) => {
  const order = ["a", "b", "c"];
  const { fake, positions } = pagerTarget(t, order);
  fake.set(300);
  native({ phase: "began", dx: -24 }, 300);
  const first = positions.at(-1);
  native({ phase: "changed", dx: -96 }, 300.016);
  assert.equal(positions.at(-1), (120 * 0.5) / WIDTH);
  assert.ok(first > 0);
  native({ phase: "changed", dx: -480 }, 300.032);
  assert.ok(positions.at(-1) > 1, "past the next profile it keeps moving");
  assert.ok(positions.at(-1) < (600 * 0.5) / WIDTH, "and rubber-bands");
  native({ phase: "cancelled" }, 300.04);
  fake.pump();
});

test("the settle continues from the finger's last position and the store's ack lands with no jump", (t) => {
  const order = ["a", "b", "c"];
  const { fake, pager, positions, area } = pagerTarget(t, order);
  fake.set(400);
  native({ phase: "began", dx: -10 }, 400);
  native({ phase: "changed", dx: -200 }, 400.05);
  native({ phase: "changed", dx: -60 }, 400.1);
  const lifted = positions.at(-1);
  native({ phase: "ended" }, 400.11);
  const settleStart = positions.length;
  fake.pump();
  const settle = positions.slice(settleStart);
  assert.ok(Math.abs(settle[0] - lifted) < 0.15, `first settle frame ${settle[0]} jumped from ${lifted}`);
  for (let i = 1; i < settle.length; i++) {
    assert.ok(settle[i] >= settle[i - 1] - 1e-9, `frame ${i} moved backwards`);
    assert.ok(settle[i] - settle[i - 1] < 0.2, `frame ${i} jumped`);
  }
  assert.ok(settle.every((p) => p <= 1 + 1e-9), "the settle overshot");
  assert.equal(settle.at(-1), 1);
  const snapshot = pager.snapshot();
  const before = positions.length;
  pager.configure({ key: pager.key, selected: 1, count: order.length, ack: snapshot.selectionSequence, order });
  assert.ok(positions.slice(before).every((p) => p === 1), "acknowledging the switch moved the page");
  pager.detach(area);
  pager.attach(area);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const pageEvent = (payload, t) => onPageSwipe({ dx: 0, dy: 0, ...payload }, t);

test("a page swipe reaches only the overlay of the tab it began on, never another tab at the same spot", async () => {
  const forA = [];
  const forB = [];
  const removeB = addSwipeTarget(swipeTarget(forB, { tabId: "tab-b" }));
  pageEvent({ phase: "began", dx: 10, x: 120, y: 300, tabId: "tab-a", gesture: 1 }, 50);
  pageEvent({ phase: "changed", dx: 30, tabId: "tab-a", gesture: 1 }, 50.01);
  pageEvent({ phase: "ended", tabId: "tab-a", gesture: 1 }, 50.02);
  assert.deepEqual(forB, [], "tab A's swipe drove tab B's overlay");
  const removeA = addSwipeTarget(swipeTarget(forA, { tabId: "tab-a" }));
  pageEvent({ phase: "began", dx: 10, x: 120, y: 300, tabId: "tab-a", gesture: 2 }, 51);
  pageEvent({ phase: "changed", dx: 30, tabId: "tab-a", gesture: 9 }, 51.01);
  pageEvent({ phase: "changed", dx: 30, tabId: "tab-b", gesture: 2 }, 51.02);
  pageEvent({ phase: "changed", dx: 5, tabId: "tab-a", gesture: 2 }, 51.03);
  pageEvent({ phase: "cancelled", tabId: "tab-a", gesture: 2 }, 51.04);
  removeA();
  removeB();
  await flush();
  assert.deepEqual(forB, []);
  assert.deepEqual(forA.map((e) => [e.phase, e.distance]), [["began", 10], ["changed", 15], ["cancelled", 15]]);
});

test("the shell claims a page swipe only once it tracks one, and gives it back when it lets go", async () => {
  invoked.length = 0;
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen, { tabId: "tab-a" }));
  pageEvent({ phase: "began", dx: 2, x: 120, y: 300, tabId: "tab-a", gesture: 3 }, 60);
  await flush();
  assert.deepEqual(invoked, [], "nothing is claimed before horizontal intent");
  pageEvent({ phase: "changed", dx: 8, tabId: "tab-a", gesture: 3 }, 60.01);
  pageEvent({ phase: "changed", dy: 80, tabId: "tab-a", gesture: 3 }, 60.02);
  pageEvent({ phase: "ended", tabId: "tab-a", gesture: 3 }, 60.03);
  await flush();
  assert.deepEqual(invoked, [
    [PAGE_SWIPE_CLAIM, { gesture: 3, tabId: "tab-a", claimed: true }],
    [PAGE_SWIPE_CLAIM, { gesture: 3, tabId: "tab-a", claimed: false }],
  ]);
  assert.deepEqual(seen.map((e) => e.phase), ["began", "cancelled"]);
  remove();
});

test("a page swipe toward a direction with no history is never claimed, so the page keeps its wheel", async () => {
  invoked.length = 0;
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen, { tabId: "tab-a", back: false }));
  pageEvent({ phase: "began", dx: 12, x: 120, y: 300, tabId: "tab-a", gesture: 4 }, 70);
  pageEvent({ phase: "changed", dx: 30, tabId: "tab-a", gesture: 4 }, 70.01);
  pageEvent({ phase: "ended", tabId: "tab-a", gesture: 4 }, 70.02);
  remove();
  await flush();
  assert.deepEqual(invoked, []);
  assert.deepEqual(seen, []);
});

test("a swipe over the onboarding overlay never reaches the profile pager underneath", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen, { pager: true }));
  hitElement = Object.assign(new HTMLElement(), { parentElement: null });
  try {
    native({ phase: "mayBegin" }, 80);
    native({ phase: "began", dx: -10 }, 80.01);
    native({ phase: "changed", dx: -60 }, 80.02);
    native({ phase: "ended" }, 80.03);
    native({ phase: "wheel", dx: -1 }, 80.1);
  } finally {
    hitElement = page;
    remove();
  }
  assert.deepEqual(seen, []);
});

test("a shell gesture the host cancels after mayBegin lets a held settle finish instead of stranding it", (t) => {
  const { fake, pager } = pagerTarget(t, ["a", "b", "c"]);
  fake.set(90);
  fling(90, -2400);
  fake.pump(3);
  native({ phase: "mayBegin" }, 90.1);
  assert.equal(pager.snapshot().phase, "holding");
  native({ phase: "cancelled" }, 90.11);
  assert.equal(pager.snapshot().phase, "settling");
  fake.pump();
  assert.equal(pager.snapshot().phase, "idle");
  assert.equal(pager.snapshot().position, 1);
});

test("an owned-momentum guard with no momentum behind it expires, so later DOM wheels are the page's again", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  native({ phase: "began", dx: 10 }, 95);
  native({ phase: "changed", dx: 30 }, 95.01);
  native({ phase: "ended" }, 95.02);
  const right = wheel({ deltaX: -3, timeStamp: 95020 });
  const realNow = performance.now.bind(performance);
  const skew = realNow();
  performance.now = () => skew + 130;
  let later;
  try {
    later = wheel({ deltaX: -3, timeStamp: 95200 });
  } finally {
    performance.now = realNow;
    remove();
  }
  assert.equal(right.defaultPrevented, true);
  assert.equal(later.defaultPrevented, false);
});

test("a fast move below halfway, a 390 ms pause and a still lift springs back to where it began", (t) => {
  const { fake, pager } = pagerTarget(t, ["a", "b", "c"]);
  fake.set(500);
  native({ phase: "began", dx: -10 }, 500);
  native({ phase: "changed", dx: -60 }, 500.01);
  native({ phase: "changed", dx: -20 }, 500.02);
  assert.ok(pager.snapshot().position < 0.5);
  native({ phase: "ended" }, 500.41);
  assert.equal(pager.snapshot().selected, 0, "the stale flick velocity advanced the pager");
  fake.pump();
  assert.equal(pager.snapshot().position, 0);
});

test("a short second swipe in the same direction keeps the profile the first one committed", () => {
  const spring = new PagerSpring();
  spring.configure(3, 0, 0, ["a", "b", "c"]);
  spring.drain();
  spring.input("began", 0, -1, WIDTH, 0);
  spring.input("changed", 10, -1, WIDTH, 0);
  spring.input("changed", 90, -1, WIDTH, 0.01);
  spring.input("ended", 90, -1, WIDTH, 0.012);
  assert.equal(spring.selected, 1);
  let now = 0.012;
  while (spring.position < 0.3) spring.stepFrame((now += FRAME));
  const carried = spring.position;
  assert.ok(carried < 0.5);
  spring.input("began", 0, -1, WIDTH, 0.2);
  assert.equal(spring.position, carried, "the second gesture jumped from the carried position");
  spring.input("changed", 10, -1, WIDTH, 0.25);
  spring.input("ended", 10, -1, WIDTH, 0.6);
  assert.equal(spring.selected, 1, "the gentle second nudge snapped back to the first profile");
  for (let i = 0; i < 600 && spring.phase === "settling"; i++) spring.stepFrame((now += FRAME));
  assert.equal(spring.position, 1);
});

test("a slow drag that leaves its committed home past halfway still lands where it was taken", () => {
  const spring = new PagerSpring();
  spring.configure(3, 0, 0, ["a", "b", "c"]);
  spring.drain();
  spring.input("began", 0, -1, WIDTH, 0);
  spring.input("changed", 90, -1, WIDTH, 0.01);
  spring.input("ended", 90, -1, WIDTH, 0.012);
  let now = 0.012;
  while (spring.position < 0.3) spring.stepFrame((now += FRAME));
  spring.input("began", 0, 1, WIDTH, 0.2);
  spring.input("changed", 150, 1, WIDTH, 0.5);
  spring.input("ended", 150, 1, WIDTH, 0.9);
  assert.equal(spring.selected, 0, "a deliberate drag back to the first profile is honoured");
});

function interruptedAt(position) {
  const spring = new PagerSpring();
  spring.configure(3, 0, 0, ["a", "b", "c"]);
  spring.drain();
  spring.input("began", 0, -1, WIDTH, 0);
  spring.input("changed", 10, -1, WIDTH, 0);
  spring.input("changed", 90, -1, WIDTH, 0.01);
  spring.input("ended", 90, -1, WIDTH, 0.012);
  assert.equal(spring.selected, 1);
  let now = 0.012;
  while (spring.position < position) spring.stepFrame((now += FRAME));
  return { spring, at: spring.position, now };
}

test("a tiny reverse nudge on a settle that hasn't crossed halfway keeps the committed profile", () => {
  const { spring, at } = interruptedAt(0.447);
  assert.ok(at >= 0.447 && at < 0.5, `interrupted at ${at}`);
  spring.input("began", 0, 1, WIDTH, 1);
  spring.input("changed", 10, 1, WIDTH, 1.2);
  assert.ok(Math.abs(spring.position - (at - (10 * 0.5) / WIDTH)) < 1e-9);
  spring.input("ended", 10, 1, WIDTH, 1.6);
  assert.equal(spring.selected, 1, "a 0.021-page nudge reversed the switch");
});

test("a deliberate reverse drag on the same unfinished settle goes back to the first profile", () => {
  const { spring } = interruptedAt(0.447);
  spring.input("began", 0, 1, WIDTH, 1);
  spring.input("changed", 140, 1, WIDTH, 1.3);
  spring.input("ended", 140, 1, WIDTH, 1.7);
  assert.equal(spring.selected, 0);
});

test("a quick reverse flick on a settle that hasn't crossed halfway keeps the committed profile", () => {
  const { spring, at } = interruptedAt(0.447);
  assert.ok(Math.abs(at - 0.44724) < 0.001 && at < 0.5, `interrupted at ${at}`);
  spring.input("began", 0, 1, WIDTH, 1);
  spring.input("changed", 4, 1, WIDTH, 1);
  spring.input("changed", 10, 1, WIDTH, 1.01);
  spring.input("ended", 10, 1, WIDTH, 1.01);
  assert.equal(spring.selected, 1, "a 10 px reverse flick undid the switch");
});

test("a short flick from rest still pages, and a long reverse flick on an unfinished settle still goes back", () => {
  const rest = new PagerSpring();
  rest.configure(3, 0, 0, ["a", "b", "c"]);
  rest.drain();
  rest.input("began", 0, -1, WIDTH, 0);
  rest.input("changed", 4, -1, WIDTH, 0);
  rest.input("changed", 10, -1, WIDTH, 0.01);
  rest.input("ended", 10, -1, WIDTH, 0.01);
  assert.equal(rest.selected, 1);
  const { spring } = interruptedAt(0.447);
  spring.input("began", 0, 1, WIDTH, 1);
  spring.input("changed", 60, 1, WIDTH, 1);
  spring.input("changed", 130, 1, WIDTH, 1.01);
  spring.input("ended", 130, 1, WIDTH, 1.01);
  assert.equal(spring.selected, 0);
});

test("a quick reverse flick still keeps the committed profile after the interrupted settle crossed halfway", () => {
  const { spring, at } = interruptedAt(0.62);
  assert.ok(at > 0.5 && at < 0.7, `interrupted at ${at}`);
  spring.input("began", 0, 1, WIDTH, 1);
  spring.input("changed", 4, 1, WIDTH, 1);
  spring.input("changed", 10, 1, WIDTH, 1.01);
  spring.input("ended", 10, 1, WIDTH, 1.01);
  assert.ok(spring.position > 0.5 && spring.position < at);
  assert.equal(spring.selected, 1, "a 10 px reverse flick past halfway undid the switch");
});

test("a reverse flick after mayBegin held the settle still needs its own travel", () => {
  const { spring } = interruptedAt(0.62);
  spring.input("prepare", 0, 0, WIDTH, 1);
  assert.equal(spring.phase, "holding");
  spring.input("began", 0, 1, WIDTH, 1);
  spring.input("changed", 4, 1, WIDTH, 1);
  spring.input("changed", 10, 1, WIDTH, 1.01);
  spring.input("ended", 10, 1, WIDTH, 1.01);
  assert.equal(spring.selected, 1);
  const long = interruptedAt(0.62).spring;
  long.input("prepare", 0, 0, WIDTH, 1);
  long.input("began", 0, 1, WIDTH, 1);
  long.input("changed", 90, 1, WIDTH, 1);
  long.input("changed", 200, 1, WIDTH, 1.01);
  long.input("ended", 200, 1, WIDTH, 1.01);
  assert.equal(long.selected, 0, "a long reverse flick from a held settle goes back");
});

test("a light, quick one-delta trackpad flick from rest switches to the next profile with no distance wall", (t) => {
  const { fake, pager } = pagerTarget(t, ["a", "b", "c"]);
  fake.set(700);
  native({ phase: "began", dx: 0 }, 700);
  native({ phase: "changed", dx: -15 }, 700.012);
  native({ phase: "ended", dx: 0 }, 700.014);
  assert.ok(pager.snapshot().position < 0.1, "the flick barely moved the pager");
  assert.equal(pager.snapshot().selected, 1, "the quick flick computed no velocity and snapped back");
  fake.pump();
  assert.equal(pager.snapshot().position, 1);
});

test("a forward swipe during a settle tail switches on at once with no 120 px wall", () => {
  const { spring, at } = interruptedAt(0.96);
  assert.ok(at >= 0.96 && at < 1, `interrupted at ${at}`);
  spring.input("began", 0, -1, WIDTH, 1);
  spring.input("changed", 4, -1, WIDTH, 1);
  spring.input("changed", 12, -1, WIDTH, 1.01);
  spring.input("ended", 12, -1, WIDTH, 1.01);
  assert.equal(spring.selected, 2, "a forward flick in the settle tail was held back");
  const mid = interruptedAt(0.62).spring;
  mid.input("began", 0, -1, WIDTH, 1);
  mid.input("changed", 4, -1, WIDTH, 1);
  mid.input("changed", 12, -1, WIDTH, 1.01);
  mid.input("ended", 12, -1, WIDTH, 1.01);
  assert.equal(mid.selected, 1, "a forward flick mid-settle completes the switch it is already making");
});

test("mid-settle, an accidental 10 px reverse bump stays put while a deliberate quick reverse flick goes back", () => {
  const bump = interruptedAt(0.447).spring;
  bump.input("began", 0, 1, WIDTH, 1);
  bump.input("changed", 4, 1, WIDTH, 1);
  bump.input("changed", 10, 1, WIDTH, 1.01);
  bump.input("ended", 10, 1, WIDTH, 1.01);
  assert.equal(bump.selected, 1, "a 10 px bump undid the switch");
  const flick = interruptedAt(0.447).spring;
  flick.input("began", 0, 1, WIDTH, 1);
  flick.input("changed", 20, 1, WIDTH, 1);
  flick.input("changed", 40, 1, WIDTH, 1.01);
  flick.input("ended", 40, 1, WIDTH, 1.01);
  assert.equal(flick.selected, 0, "a deliberate 40 px reverse flick did not go back");
});

test("mayBegin, then a began that already carries the flick, then a still lift switches profiles", (t) => {
  const { fake, pager } = pagerTarget(t, ["a", "b", "c"]);
  fake.set(800);
  native({ phase: "mayBegin" }, 800);
  native({ phase: "began", dx: -15 }, 800.4);
  native({ phase: "ended", dx: 0 }, 800.402);
  assert.equal(pager.snapshot().selected, 1, "a began-carried flick computed no velocity and snapped back");
  fake.pump();
  assert.equal(pager.snapshot().position, 1);
});
