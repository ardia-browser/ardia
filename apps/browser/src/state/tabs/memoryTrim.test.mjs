import assert from "node:assert/strict";
import { mock, test } from "node:test";

let heap = 64_000_000;
let collectionMs = 0;
let collections = 0;
let gcSeconds = 0;
globalThis.HermesInternal = { getInstrumentedStats: () => ({ js_heapSize: heap, js_numGCs: collections, js_gcTime: gcSeconds }) };
globalThis.gc = () => {
  collections += 1;
  gcSeconds += collectionMs / 1000;
  heap -= 1_000_000;
  mock.timers.setTime(Date.now() + collectionMs);
};
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000_000 });

const { useBrowser } = await import("../browser/store.ts");
const { startMemoryTrim } = await import("./memoryTrim.ts");
const { takeMemoryTrimCounts } = await import("../telemetry/memoryTrimCounts.ts");

const S = () => useBrowser.getState();
S().hydrate({});
const w = S().createWindow({ url: "a.com" });
startMemoryTrim();

const trimAfterANewTab = async (ms) => {
  collectionMs = ms;
  collections = 0;
  takeMemoryTrimCounts();
  S().newTab(w, { url: `https://site-${Date.now()}.test` });
  for (let waited = 0; waited < 40_000; waited += 250) mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  return { collections, counts: takeMemoryTrimCounts() };
};

test("fast heap collections keep compacting while the heap shrinks, up to 8", async () => {
  const { collections, counts } = await trimAfterANewTab(5);
  assert.equal(collections, 8);
  assert.equal(counts.memory_trim_slow_collections, 0);
  assert.equal(counts.memory_trim_longest_collection_ms, 5);
  assert.equal(counts.engine_memory_trims, 1);
});

test("the hourly counts carry the heap collections and their time since the last take", async () => {
  const { counts } = await trimAfterANewTab(20);
  assert.equal(counts.js_collections, 8);
  assert.equal(counts.js_collection_ms, 160);
  assert.deepEqual([takeMemoryTrimCounts().js_collections, takeMemoryTrimCounts().js_collection_ms], [0, 0]);
});

test("a heap collection slower than 100 ms ends the compaction, is counted, and later trims leave the heap alone", async () => {
  const slow = await trimAfterANewTab(150);
  assert.equal(slow.collections, 1);
  assert.equal(slow.counts.memory_trim_slow_collections, 1);
  assert.equal(slow.counts.memory_trim_longest_collection_ms, 150);
  assert.equal(slow.counts.engine_memory_trims, 1);
  const later = await trimAfterANewTab(5);
  assert.equal(later.collections, 0);
  assert.equal(later.counts.memory_trim_slow_collections, 0);
  assert.equal(later.counts.engine_memory_trims, 1);
});
