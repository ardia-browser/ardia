import assert from "node:assert/strict";
import test from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(performance.now()), 4);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Pager } = await import("./shims/web/motion/pager.ts");
const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
const { initialHostSession } = await import("./hostSession.ts");
const { stepAction } = await import("../../../packages/ardiacore/src/pagerModel.ts");

const S = () => useBrowser.getState();
const flush = () => new Promise((resolve) => setImmediate(resolve));
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

test("menu and keyboard switches page to any profile", async () => {
  const { named } = pager();
  assert.equal(named.switchTo(1, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().selected, 1);
  assert.equal(named.step(1, false, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().selected, 2);
});

function libraryPager() {
  const states = [];
  const positions = [];
  const area = { pageWidth: () => 200, attached: () => true, onPosition: (position, leading) => positions.push({ position, leading }), onState: (e) => states.push(e) };
  const named = Pager.named(`w-${++keys}`);
  named.attach(area);
  named.configure({ key: named.key, selected: 0, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: false });
  return { named, area, states, positions };
}

const swipe = async (named, area, distance, direction) => {
  named.input(area, "began", 0, direction, 0);
  named.input(area, "changed", distance, direction, 0.05);
  named.input(area, "ended", distance, direction, 0.3);
  await settled(named);
};

const BACK = 1;
const FORWARD = -1;

test("swiping back from the first profile opens the Library and reports no profile", async () => {
  const { named, area, states } = libraryPager();
  await flush();
  const before = states.length;
  await swipe(named, area, 300, BACK);
  const selected = states.slice(before).find((e) => e.phase === "selected");
  assert.deepEqual([selected.selected, selected.leading, selected.profileId], [-1, true, null]);
  const snapshot = named.snapshot();
  assert.deepEqual([snapshot.selected, snapshot.position, snapshot.leading, snapshot.lead, snapshot.profileId], [-1, -1, true, 1, null]);
});

test("without a Library page a swipe back from the first profile rubber-bands and stays", async () => {
  const { named, area } = pager();
  await swipe(named, area, 300, BACK);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().profileId], [0, false, "default"]);
  assert.equal(named.debug().anchor, null);
});

test("a swipe past the Library rubber-bands its progress and settles back on the Library", async () => {
  const { named, area, positions } = libraryPager();
  await swipe(named, area, 300, BACK);
  const start = positions.length;
  named.input(area, "began", 0, BACK, 1);
  named.input(area, "changed", 800, BACK, 1.05);
  const pulled = positions.at(-1);
  assert.equal(pulled.position, 0);
  assert.ok(pulled.leading > 1.1 && pulled.leading < 1.5, `lead ${pulled.leading}`);
  named.input(area, "ended", 800, BACK, 1.3);
  await settled(named);
  assert.ok(positions.slice(start).every((p) => p.position === 0));
  assert.deepEqual([named.snapshot().leading, named.snapshot().lead], [true, 1]);
});

test("a long swipe forward from the Library pages one step, back to the profile it came from", async () => {
  const { named, area, states } = libraryPager();
  await swipe(named, area, 300, BACK);
  await swipe(named, area, 2000, FORWARD);
  const done = states.at(-1);
  assert.deepEqual([done.phase, done.selected, done.leading, done.profileId], ["settled", 0, false, "default"]);
  assert.deepEqual([named.snapshot().lead, named.debug().anchor], [0, null]);
});

test("lead opens the Library from a later profile and closing returns to it", async () => {
  const { named, states } = libraryPager();
  named.switchTo(2);
  await settled(named);
  assert.equal(named.lead(true), true);
  await flush();
  const opened = states.at(-1);
  assert.deepEqual([opened.phase, opened.selected, opened.leading, opened.profileId], ["selected", -1, true, null]);
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().position, named.snapshot().lead, named.debug().home, named.debug().pagePosition], [-1, 1, 1, 2, 2]);
  assert.equal(named.lead(false), true);
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().profileId, named.debug().anchor], [2, false, "side", null]);
});

test("lead refuses to open where the pager has no Library page", () => {
  const { named } = pager();
  assert.equal(named.lead(true), false);
  assert.equal(named.lead(false), true);
});

test("stepping back from the first profile opens the Library, stepping forward closes it", async () => {
  const { named } = libraryPager();
  assert.equal(named.step(-1, false, ORDER), true);
  await settled(named);
  assert.equal(named.snapshot().leading, true);
  assert.equal(named.step(-1, false, ORDER), true);
  assert.equal(named.snapshot().phase, "idle");
  assert.equal(named.step(1, false, ORDER), true);
  await settled(named);
  assert.deepEqual([named.snapshot().leading, named.snapshot().profileId], [false, "default"]);
});

test("selecting a profile at the Library re-anchors it there, and switching closes onto the new profile", async () => {
  const { named, states } = libraryPager();
  named.lead(true);
  await settled(named);
  assert.equal(named.select("side", ORDER), true);
  await flush();
  const reanchored = states.at(-1);
  assert.deepEqual([reanchored.phase, reanchored.selected, reanchored.leading, reanchored.profileId], ["selected", -1, true, null]);
  assert.deepEqual([named.snapshot().position, named.snapshot().lead, named.debug().anchor, named.debug().home], [1, 1, 2, 2]);
  assert.equal(named.switchTo(1), true);
  await settled(named);
  const done = states.at(-1);
  assert.deepEqual([done.phase, done.selected, done.leading, done.profileId], ["settled", 1, false, "work"]);
  assert.equal(named.debug().anchor, null);
});

test("the library prop opens the Library and turning off the leading page closes it", async () => {
  const { named } = libraryPager();
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: false });
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: true });
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.debug().home], [-1, true, 1]);
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: false, library: false });
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().profileId, named.debug().anchor], [1, false, "work", null]);
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

test("reordering profiles while the Library is open keeps it open over the moved profile", async () => {
  const { named } = libraryPager();
  named.lead(true);
  await settled(named);
  named.configure({ key: named.key, selected: 0, count: 3, ack: 0, order: ["work", "default", "side"], leading: true, library: true });
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().lead, named.debug().anchor, named.debug().home], [-1, true, 1, 1, 1]);
  assert.equal(named.lead(false), true);
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().profileId], [1, "default"]);
});

test("closing the Library without animation lands on its profile at once", async () => {
  const { named, states } = libraryPager();
  named.switchTo(1);
  await settled(named);
  named.lead(true);
  await settled(named);
  assert.equal(named.lead(false, false), true);
  await flush();
  const closed = states.at(-1);
  assert.deepEqual([closed.phase, closed.selected, closed.leading, closed.profileId], ["selected", 1, false, "work"]);
  assert.deepEqual([named.snapshot().phase, named.snapshot().position, named.snapshot().lead, named.debug().anchor], ["idle", 1, 0, null]);
});

test("Previous and Next Profile with the Library open page from the profile the Library opened on", async () => {
  for (const [delta, landing] of [[-1, "default"], [1, "side"]]) {
    const { named } = libraryPager();
    named.switchTo(1);
    await settled(named);
    named.lead(true);
    await settled(named);
    assert.equal(named.step(delta, true, ORDER), true);
    await settled(named);
    assert.deepEqual([named.snapshot().leading, named.snapshot().profileId], [false, landing]);
  }
});

test("a pager configured while the Library is open starts on the Library and says so", async () => {
  const states = [];
  const area = { pageWidth: () => 200, attached: () => true, onPosition: () => {}, onState: (e) => states.push(e) };
  const named = Pager.named(`w-${++keys}`);
  named.attach(area);
  named.configure({ key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: true });
  assert.deepEqual([named.snapshot().selected, named.snapshot().leading, named.snapshot().lead, named.debug().home], [-1, true, 1, 1]);
  await flush();
  assert.deepEqual(states.map((e) => [e.leading, e.selected]), [[true, -1]]);
});

test("turning off the leading page mid-swipe keeps a forward swipe from the first profile going forward", async () => {
  const { named, area } = libraryPager();
  named.input(area, "began", 0, FORWARD, 0);
  named.input(area, "changed", 300, FORWARD, 0.05);
  named.input(area, "ended", 300, FORWARD, 0.3);
  named.configure({ key: named.key, selected: 0, count: ORDER.length, ack: 0, order: ORDER, leading: false, library: false });
  await settled(named);
  assert.deepEqual([named.snapshot().profileId, named.debug().anchor], ["work", null]);
});

test("turning off the leading page at the Library settles home once, however often it is configured", async () => {
  const { named } = libraryPager();
  named.switchTo(1);
  await settled(named);
  named.lead(true);
  await settled(named);
  const cancel = globalThis.cancelAnimationFrame;
  let restarts = 0;
  const off = { key: named.key, selected: 1, count: ORDER.length, ack: 0, order: ORDER, leading: false, library: false };
  named.configure(off);
  globalThis.cancelAnimationFrame = (id) => (restarts++, cancel(id));
  try {
    named.configure(off);
    named.configure(off);
  } finally {
    globalThis.cancelAnimationFrame = cancel;
  }
  await settled(named);
  assert.equal(restarts, 0);
  assert.deepEqual([named.snapshot().leading, named.snapshot().profileId, named.debug().anchor], [false, "work", null]);
});

test("a reorder during a forward swipe from the first profile keeps the profile it is heading to", () => {
  const { named, area } = libraryPager();
  named.input(area, "began", 0, FORWARD, 0);
  named.input(area, "changed", 300, FORWARD, 0.05);
  named.input(area, "ended", 300, FORWARD, 0.3);
  named.configure({ key: named.key, selected: 0, count: 3, ack: 0, order: ["side", "work", "default"], leading: true, library: false });
  assert.equal(named.snapshot().profileId, "work");
});

test("stepAction wraps from the Library's own profile", () => {
  assert.deepEqual(stepAction({ anchor: 1, selected: 0, leading: true, count: 3 }, -1, true), { kind: "switch", index: 0 });
  assert.deepEqual(stepAction({ anchor: 1, selected: 0, leading: true, count: 3 }, 1, true), { kind: "switch", index: 2 });
  assert.deepEqual(stepAction({ anchor: null, selected: 0, leading: true, count: 1 }, 1, true), { kind: "stay" });
});

test("the library prop with a new selection lands on the Library over that profile", () => {
  const { named } = libraryPager();
  named.configure({ key: named.key, selected: 2, count: ORDER.length, ack: 0, order: ORDER, leading: true, library: true });
  assert.deepEqual([named.snapshot().leading, named.debug().home], [true, 2]);
});

test("the library prop with a reorder ends on the Library", async () => {
  const { named } = libraryPager();
  named.configure({ key: named.key, selected: 1, count: 3, ack: 0, order: ["work", "default", "side"], leading: true, library: true });
  await settled(named);
  assert.deepEqual([named.snapshot().leading, named.debug().home], [true, 1]);
});

test("a swipe whose area goes away mid-drag springs back instead of staying in the drag", async () => {
  const { named, area } = pager();
  const other = { pageWidth: () => 200, attached: () => true, onPosition: () => {}, onState: () => {} };
  named.attach(other);
  named.input(area, "began", 0, -1, 0);
  named.input(area, "changed", 120, -1, 0.05);
  assert.equal(named.snapshot().phase, "tracking");
  named.detach(area);
  assert.notEqual(named.snapshot().phase, "tracking");
  await settled(named);
  assert.deepEqual([named.snapshot().selected, named.snapshot().position], [0, 0]);
});
