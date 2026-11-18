import assert from "node:assert/strict";
import test from "node:test";

const hostListeners = [];
globalThis.HTMLElement = class {};
globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", overflowX: "visible" });
globalThis.window = {
  addEventListener: () => {},
  __ardiaHost: { onEvent: (listener) => (hostListeners.push(listener), () => {}) },
};

const card = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
const page = Object.assign(new HTMLElement(), { parentElement: null, scrollWidth: 0, clientWidth: 0 });
const container = { contains: (element) => element === page || element === node, parentElement: null };
const node = {
  isConnected: true,
  parentElement: container,
  getClientRects: () => [card],
  getBoundingClientRect: () => card,
};
page.parentElement = container;
globalThis.document = { elementFromPoint: () => page };

const { addSwipeTarget, onPageSwipe } = await import("./shims/web/motion/swipe.ts");

function target(seen, { back = true } = {}) {
  return {
    node: () => node,
    canSwipeBack: () => back,
    canSwipeForward: () => false,
    tracksUnavailableDirections: () => false,
    allowsVerticalMotion: () => false,
    isPager: () => false,
    pager: () => null,
    onSwipe: (event) => seen.push(event),
  };
}

test("a horizontal swipe the page leaves unconsumed drives the shell's swipe overlay through began, changed and ended", () => {
  const seen = [];
  const remove = addSwipeTarget(target(seen));
  const host = (payload) => hostListeners.forEach((listener) => listener("ArdiaShell", "onPageSwipe", payload));
  assert.equal(hostListeners.length, 1);
  host({ phase: "began", dx: 6, dy: 0, x: 400, y: 300, tabId: "t1" });
  host({ phase: "changed", dx: 20, dy: 1, tabId: "t1" });
  host({ phase: "ended", dx: 0, dy: 0, tabId: "t1" });
  assert.deepEqual(seen.map((event) => event.phase), ["began", "changed", "ended"]);
  assert.equal(seen[0].direction, "back");
  assert.equal(seen[1].distance, 26);
  remove();
});

test("a page swipe toward an unavailable direction, a vertical one, or a malformed event is never tracked", () => {
  const seen = [];
  const remove = addSwipeTarget(target(seen, { back: false }));
  onPageSwipe({ phase: "began", dx: 10, dy: 0, x: 400, y: 300 }, 1);
  onPageSwipe({ phase: "ended", dx: 0, dy: 0 }, 1.01);
  onPageSwipe({ phase: "began", dx: -10, dy: 0, x: 400, y: 300 }, 2);
  onPageSwipe({ phase: "ended", dx: 0, dy: 0 }, 2.01);
  remove();
  const vertical = [];
  const removeVertical = addSwipeTarget(target(vertical));
  onPageSwipe({ phase: "began", dx: 1, dy: 30, x: 400, y: 300 }, 3);
  onPageSwipe({ phase: "changed", dx: 8, dy: 0 }, 3.01);
  onPageSwipe({ phase: "ended", dx: 0, dy: 0 }, 3.02);
  onPageSwipe({ phase: "began", dx: 10, dy: 0 }, 4);
  onPageSwipe({ phase: "began", dx: Number.NaN, dy: 0, x: 1, y: 1 }, 4);
  onPageSwipe({ phase: "skip", dx: 10, dy: 0, x: 1, y: 1 }, 4);
  removeVertical();
  assert.deepEqual(seen, []);
  assert.deepEqual(vertical, []);
});

test("a cancelled page swipe reports cancelled", () => {
  const seen = [];
  const remove = addSwipeTarget(target(seen));
  onPageSwipe({ phase: "began", dx: 12, dy: 0, x: 400, y: 300 }, 5);
  onPageSwipe({ phase: "cancelled", dx: 0, dy: 0 }, 5.02);
  remove();
  assert.deepEqual(seen.map((event) => event.phase), ["began", "cancelled"]);
});
