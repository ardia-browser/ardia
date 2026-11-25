import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./bench-app.js", import.meta.url), "utf8");

function fakeApp({ favicons = true, closes = true } = {}) {
  let next = 0;
  const state = {
    ui: { focusOrder: ["w"] },
    windows: { w: { profileId: "p", activeTabIds: { p: "t0" }, tabIds: ["t0"] } },
    tabs: { t0: { url: "http://h/start", title: "Start", profileId: "p" } },
    newTab(w, { url }) {
      const id = `n${next++}`;
      state.tabs = { ...state.tabs, [id]: { url, title: "Page", profileId: "p" } };
      return id;
    },
    closeTab(id) {
      if (!closes) return;
      const { [id]: _, ...rest } = state.tabs;
      state.tabs = rest;
    },
  };
  globalThis.acPerf = { now: () => Date.now(), batch: (fn) => fn(), reset() {}, read: () => ({ writes: {}, timers: {} }), marks: {} };
  const ac = {
    store: { getState: () => state, subscribe: () => () => {} },
    tabLive: { liveOf: () => ({ isLoading: false }) },
    favicons: { resolveFavicon: () => (favicons ? { uri: "data:," } : null) },
  };
  new Function("ac", source)(ac);
  return globalThis.acBench;
}

const options = { count: 2, origin: "http://h", showTimeoutMs: 100, closeTimeoutMs: 100 };

test("openClose measures when the last tab shows and every closed tab is gone", { timeout: 30_000 }, async () => {
  const result = await fakeApp().run("openClose", options);
  assert.equal(result.open.length, 2);
  assert.equal(result.close.length, 2);
  assert.ok(result.openStats && result.closeStats);
});

test("openClose fails instead of returning counts when the last tab never shows its favicon", { timeout: 30_000 }, async () => {
  await assert.rejects(fakeApp({ favicons: false }).run("openClose", options), /didn't show its title and favicon/);
});

test("openClose fails instead of returning counts when closed tabs are still open at its deadline", { timeout: 30_000 }, async () => {
  await assert.rejects(fakeApp({ closes: false }).run("openClose", options), /2 closed tabs were still open/);
});
