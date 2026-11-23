import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./bench-app.js", import.meta.url), "utf8");

function fakeApp({ windows = [], persistence = {} } = {}) {
  const seen = { resets: 0, flushes: 0, saved: 0, held: 0 };
  let window = 0;
  globalThis.acPerf = {
    now: () => Date.now(),
    batch: (fn) => fn(),
    reset() {
      seen.resets++;
    },
    read: () => windows[Math.min(window++, windows.length - 1)] ?? { writes: {}, timers: {} },
    marks: {},
  };
  const state = { ui: { focusOrder: ["w"] }, windows: { w: { profileId: "p", activeTabIds: { p: "t0" }, tabIds: ["t0"] } }, tabs: {} };
  const ac = {
    store: { getState: () => state, subscribe: () => () => {} },
    tabLive: { liveOf: () => ({ isLoading: false }) },
    persistence: persistence && {
      flushPersistence() {
        seen.flushes++;
        return true;
      },
      holdPersistence() {
        seen.held++;
        return true;
      },
      ...persistence,
    },
  };
  for (const [name, fn] of Object.entries(ac.persistence ?? {})) ac.persistence[name] = fn.bind(null, seen);
  new Function("ac", source)(ac);
  return { bench: globalThis.acBench, seen };
}

const quiet = { writes: {}, timers: {} };
const saving = { writes: { "session.json": 1 }, timers: { "setTimeout:save": 1 } };
const ticking = (n) => ({ writes: {}, timers: { "setTimeout:poll": n } });
const fast = { quietMs: 5, stepMs: 5 };
const saved = { sessionSaved: (s) => (s.saved++, Promise.resolve(true)) };

test("the settle saves the session and waits for the old quiet checks: a window with no write, then one with no new one-shot timer", async () => {
  const { bench, seen } = fakeApp({ windows: [quiet, quiet], persistence: saved });
  const { ms, ...settled } = await bench.settleWindow(fast);
  assert.deepEqual(settled, { flushed: true, writes: true, timers: { settled: true, steady: {} }, held: false });
  assert.equal(seen.saved, 1);
  assert.equal(seen.resets, 2);
  assert.equal(typeof ms, "number");
});

test("the default checks are the old ones: 3 s with no write, then 1 s timer windows", { timeout: 30_000 }, async () => {
  const { bench } = fakeApp({ windows: [quiet, quiet], persistence: saved });
  const started = Date.now();
  await bench.settleWindow();
  assert.ok(Date.now() - started >= 3900);
});

test("a write in the quiet window starts it over", async () => {
  const { bench, seen } = fakeApp({ windows: [saving, saving, quiet, quiet], persistence: saved });
  await bench.settleWindow(fast);
  assert.equal(seen.resets, 4);
});

test("one-shot timers that keep firing the same way count as steady", async () => {
  const { bench } = fakeApp({ windows: [quiet, ticking(3), ticking(2), ticking(2)], persistence: saved });
  const settled = await bench.settleWindow(fast);
  assert.deepEqual(settled.timers, { settled: true, steady: { "setTimeout:poll": 2 } });
});

test("an older bundle without sessionSaved still flushes, synchronously", async () => {
  const { bench, seen } = fakeApp({ windows: [quiet], persistence: {} });
  const settled = await bench.settleWindow(fast);
  assert.equal(settled.flushed, true);
  assert.equal(seen.flushes, 1);
});

test("idle's hold freezes persistence after the settle", async () => {
  const { bench, seen } = fakeApp({ windows: [quiet], persistence: saved });
  const settled = await bench.settleWindow({ hold: true, ...fast });
  assert.equal(settled.held, true);
  assert.equal(seen.held, 1);
});

test("without persistence nothing is flushed", async () => {
  const { bench } = fakeApp({ windows: [quiet], persistence: null });
  assert.equal((await bench.settleWindow(fast)).flushed, false);
});

test("a save that reports it didn't land rejects the sample", async () => {
  const { bench } = fakeApp({ windows: [quiet], persistence: { sessionSaved: () => Promise.resolve(false) } });
  await assert.rejects(bench.settleWindow(fast), /session didn't save/);
});

test("a save that fails rejects the sample", async () => {
  const { bench } = fakeApp({ windows: [quiet], persistence: { sessionSaved: () => Promise.reject(new Error("disk")) } });
  await assert.rejects(bench.settleWindow(fast), /session didn't save/);
});


test("a healthy save that takes longer than 5 s still counts: only the scenario's own deadline bounds it", { timeout: 20_000 }, async () => {
  const { bench } = fakeApp({ windows: [quiet], persistence: { sessionSaved: () => new Promise((r) => setTimeout(() => r(true), 5100)) } });
  assert.equal((await bench.settleWindow(fast)).flushed, true);
});
