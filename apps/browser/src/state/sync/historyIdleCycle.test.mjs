import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { historyAdapter, historyExpired } = await import("./historyAdapter.ts");
const { bookmarksAdapter, deviceTabsAdapter } = await import("./adapters.ts");
const { useEditClock } = await import("./editClock.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const DAY = 86_400_000;

function folder() {
  const files = new Map();
  let counter = 0;
  return {
    write: async (_scope, payload) => {
      const id = `f${++counter}`;
      files.set(id, payload);
      return id;
    },
    read: async (_scope, known) => {
      const present = [...files.keys()];
      return { files: present.filter((id) => !known.includes(id)).map((id) => ({ id, payload: files.get(id) })), pending: [], damaged: [], present };
    },
    remove: async (_scope, ids) => ids.forEach((id) => files.delete(id)),
  };
}

function countedList(n, now) {
  const reads = { count: 0 };
  const list = Array.from({ length: n }, (_, i) => {
    const lastVisit = now - Math.floor((i / n) * 60 * DAY);
    return { url: `https://site${i % 97}.example/${i}`, title: `Page ${i}`, favicon: null, visits: 1, lastVisit, visitTimes: [lastVisit] };
  });
  const counted = new Proxy(list, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads.count++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { list: counted, reads };
}

test("an idle sync cycle reads none of the history list and lists no base keys, and the next visit still publishes", async () => {
  const now = Date.now();
  const { list, reads } = countedList(3000, now);
  S().hydrate({});
  const w = S().createWindow({ url: "https://open.example/" });
  for (let i = 0; i < 20; i++) S().newTab(w, { url: `https://open.example/${i}`, background: true });
  for (let i = 0; i < 50; i++) S().addBookmark({ profileId: "default", url: `https://mark.example/${i}`, title: `Mark ${i}` });
  useBrowser.setState({ history: { "": { list, floor: -Infinity, ready: true } }, bookmarksReady: { "": true } });
  const clock = new Clock("A");
  useEditClock(clock);
  stub.current.device = "A";
  const state = emptyScope();
  let listings = 0;
  state.base = new Proxy(state.base, {
    ownKeys(target) {
      listings++;
      return Reflect.ownKeys(target);
    },
  });
  const transport = folder();
  const adapters = () => [bookmarksAdapter("default"), historyAdapter("default"), deviceTabsAdapter("default", "A", () => "A's Mac")];
  const cycle = () => syncScope({ scope: "p", state, transport, adapters: adapters(), clock, device: "A", options: { expired: historyExpired } });
  assert.ok((await cycle()).published >= 3050);
  await cycle();
  const settled = reads.count;
  listings = 0;
  for (let i = 0; i < 4; i++) assert.equal((await cycle()).published, 0);
  assert.equal(reads.count, settled, "idle cycles walked the history list");
  assert.equal(listings, 0, "idle cycles listed every base key");
  const view = S().history[""];
  const at = Date.now();
  useBrowser.setState({ history: { "": { ...view, list: [{ url: "https://fresh.example/", title: "Fresh", favicon: null, visits: 1, lastVisit: at, visitTimes: [at] }, ...list] } } });
  assert.equal((await cycle()).published, 1);
  assert.equal((await cycle()).published, 0);
});

test("a visit the clock brings back inside the 90-day window publishes on the next cycle, as a full extraction would", async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const now = Date.now();
    const inside = { url: "https://inside.example/", title: "Inside", favicon: null, visits: 1, lastVisit: now - DAY, visitTimes: [now - DAY] };
    const edge = now - 90 * DAY - 2 * 60_000;
    const outside = { url: "https://outside.example/", title: "Outside", favicon: null, visits: 1, lastVisit: edge, visitTimes: [edge] };
    S().hydrate({});
    useBrowser.setState({ history: { "": { list: [inside, outside], floor: -Infinity, ready: true } } });
    const clock = new Clock("A");
    useEditClock(clock);
    stub.current.device = "A";
    const state = emptyScope();
    const transport = folder();
    const cycle = () => syncScope({ scope: "p", state, transport, adapters: [historyAdapter("default")], clock, device: "A", options: { expired: historyExpired } });
    assert.equal((await cycle()).published, 1);
    assert.equal((await cycle()).published, 0);
    offset = -4 * 60_000;
    assert.equal((await cycle()).published, 1, "the visit back inside the window wasn't published");
  } finally {
    Date.now = realNow;
  }
});

test("the tokens a scope keeps for skipping hold neither the bookmark tree nor the history list", () => {
  S().hydrate({});
  useBrowser.setState({ history: { "": { list: [], floor: -Infinity, ready: true } }, bookmarksReady: { "": true } });
  const s = S();
  const held = new Set([s.bookmarks, s.bookmarks.nodes, s.history[""], s.history[""].list]);
  for (const token of [bookmarksAdapter("default").extractsOnlyFrom(), historyAdapter("default").extractsOnlyFrom()]) {
    assert.ok(token && typeof token === "object");
    for (const value of Object.values(token)) assert.ok(!held.has(value), "a skip token keeps the store's data alive");
  }
  assert.equal(bookmarksAdapter("default").extractsOnlyFrom(), bookmarksAdapter("default").extractsOnlyFrom());
  assert.equal(historyAdapter("default").extractsOnlyFrom(), historyAdapter("default").extractsOnlyFrom());
});
