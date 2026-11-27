import assert from "node:assert/strict";
import test from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 4);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Pager } = await import("./shims/web/motion/pager.ts");
const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
const { initialHostSession } = await import("./hostSession.ts");

const S = () => useBrowser.getState();
const ORDER = ["default", "work", "side"];
let keys = 0;

function pager() {
  const states = [];
  const positions = [];
  const area = { pageWidth: () => 200, attached: () => true, onPosition: (p) => positions.push(p), onState: (e) => states.push(e) };
  const named = Pager.named(`w-${++keys}`);
  named.attach(area);
  named.configure({ key: named.key, selected: 0, count: ORDER.length, ack: 0, order: ORDER });
  return { named, area, states, positions };
}

const settled = (named) => new Promise((resolve) => {
  const poll = () => named.snapshot().phase === "idle" ? resolve() : setTimeout(poll, 5);
  poll();
});

test("a swipe pages to the next profile whatever its engine profile", async () => {
  const { named, area } = pager();
  named.input(area, "began", 0, -1, 0);
  named.input(area, "changed", 300, -1, 0.05);
  named.input(area, "ended", 300, -1, 0.3);
  await settled(named);
  assert.equal(named.snapshot().selected, 1);
  assert.equal(named.snapshot().profileId, "work");
});

test("a short swipe springs back to the current profile", async () => {
  const { named, area } = pager();
  named.input(area, "began", 0, -1, 0);
  named.input(area, "changed", 40, -1, 0.2);
  named.input(area, "ended", 40, -1, 0.4);
  await settled(named);
  assert.equal(named.snapshot().selected, 0);
});

const pagerMarks = () => performance.getEntriesByType("mark").filter((m) => m.name.startsWith("ardia-pager-")).map((m) => m.name);

test("a swipe marks pager motion once when it starts and once at rest", async () => {
  performance.clearMarks();
  const { named, area } = pager();
  named.input(area, "began", 0, -1, 0);
  named.input(area, "changed", 300, -1, 0.05);
  assert.deepEqual(pagerMarks(), ["ardia-pager-moving"]);
  named.input(area, "ended", 300, -1, 0.3);
  assert.deepEqual(pagerMarks(), ["ardia-pager-moving"]);
  await settled(named);
  assert.deepEqual(pagerMarks(), ["ardia-pager-moving", "ardia-pager-rest"]);
  const [moving, rest] = performance.getEntriesByType("mark").filter((m) => m.name.startsWith("ardia-pager-"));
  assert.ok(rest.startTime >= moving.startTime);
});

test("a menu switch and an interrupted motion each close their motion with a rest mark", async () => {
  performance.clearMarks();
  const { named, area } = pager();
  assert.equal(named.switchTo(1, ORDER), true);
  await settled(named);
  assert.deepEqual(pagerMarks(), ["ardia-pager-moving", "ardia-pager-rest"]);
  performance.clearMarks();
  named.input(area, "began", 0, -1, 0);
  named.select("default", ORDER);
  assert.deepEqual(pagerMarks(), ["ardia-pager-moving", "ardia-pager-rest"]);
});

test("pager marks stay bounded across many motions and the latest pair is always kept", async () => {
  performance.clearMarks();
  const { named } = pager();
  for (let i = 0; i < 40; i++) {
    assert.equal(named.switchTo(i % 2 ? 0 : 1, ORDER), true);
    await settled(named);
  }
  const moving = performance.getEntriesByName("ardia-pager-moving", "mark");
  const rest = performance.getEntriesByName("ardia-pager-rest", "mark");
  assert.ok(moving.length >= 1 && moving.length <= 16, `${moving.length} moving marks`);
  assert.ok(rest.length >= 1 && rest.length <= 16, `${rest.length} rest marks`);
  assert.ok(rest.at(-1).startTime >= moving.at(-1).startTime);
  assert.equal(named.snapshot().selected, 0);
});

test("menu and keyboard switches page to any profile", async () => {
  const { named } = pager();
  assert.equal(named.switchTo(1, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().selected, 1);
  assert.equal(named.step(1, false, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().selected, 2);
});

test("Linux switches an isolated profile in place, like a profile sharing the window's data", () => {
  S().hydrate(initialHostSession({ bootstrap: { windowId: "main", profileId: "default", startup: false } }, null));
  const work = S().createProfile({ name: "Work" });
  const side = S().createProfile({ name: "Side", shareWith: "default" });
  const before = Object.keys(S().windows).length;
  S().switchProfile("main", work);
  assert.equal(S().windows.main.profileId, work);
  S().switchProfile("main", side);
  assert.equal(S().windows.main.profileId, side);
  assert.equal(Object.keys(S().windows).length, before);
});
