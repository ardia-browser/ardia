import assert from "node:assert/strict";
import { test } from "node:test";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { HISTORY_SCAN } = await import("./socketHistory.ts");
const stub = await import("../../test-native/index.ts");

const { ok } = socketClient(31);

const url = (i) => `https://p${i}.example/`;

function fill(count) {
  const db = stub.chromeHistory("");
  db.clear();
  for (let i = 0; i < count; i++) db.set(url(i), { title: `Page ${i}`, visits: [1_000_000 - i] });
}

function warm(count) {
  const list = Array.from({ length: count }, (_, i) => ({ url: url(i), title: `Page ${i}`, favicon: null, visits: 1, lastVisit: 1_000_000 - i }));
  useBrowser.setState((s) => ({ history: { ...s.history, "": { list, floor: 0, ready: true } } }));
}

const cold = () => useBrowser.setState((s) => ({ history: Object.fromEntries(Object.entries(s.history).filter(([k]) => k !== "")) }));

async function both(count, run) {
  await freshWindow();
  fill(count);
  cold();
  const coldResult = await run();
  warm(count);
  const warmResult = await run();
  assert.deepEqual(warmResult, coldResult, "the warm cache answers what the engine answers");
  cold();
  return coldResult;
}

test("history paging past the scan window says it was cut off, cold and warm", async () => {
  const last = await both(HISTORY_SCAN + 1, () => ok("history.search", { offset: HISTORY_SCAN - 1, limit: 1 }));
  assert.deepEqual(last.items.map((h) => h.url), [url(HISTORY_SCAN - 1)]);
  assert.equal(last.nextOffset, null, "nothing past the scan window can be paged to");
  assert.equal(last.total, null);
  assert.equal(last.truncated, true);

  const beyond = await both(HISTORY_SCAN + 1, () => ok("history.search", { offset: HISTORY_SCAN, limit: 5 }));
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.truncated, true);
});

test("history paging inside the scan window: nextOffset while there's more, the exact total at the end", async () => {
  const exact = await both(HISTORY_SCAN, () => ok("history.search", { offset: HISTORY_SCAN - 1, limit: 1 }));
  assert.equal(exact.nextOffset, null);
  assert.equal(exact.total, HISTORY_SCAN);
  assert.equal(exact.truncated, false);

  const first = await both(50, () => ok("history.search", { limit: 10 }));
  assert.equal(first.nextOffset, 10);
  assert.equal(first.total, null, "only the page and one more were read");
  assert.equal(first.truncated, false);
});

test("filtered history: an exact total only when the whole history was scanned", async () => {
  const cut = await both(HISTORY_SCAN + 1, () => ok("history.search", { query: "page", limit: 1 }));
  assert.equal(cut.total, null, "a count among scanned rows isn't the total");
  assert.equal(cut.truncated, true);
  assert.equal(cut.nextOffset, 1);

  const whole = await both(HISTORY_SCAN, () => ok("history.search", { query: "page", limit: 1 }));
  assert.equal(whole.total, HISTORY_SCAN);
  assert.equal(whole.truncated, false, "exactly the scan window is the whole history");
});

test("the engine is asked for a bounded number of pages", async () => {
  await freshWindow();
  fill(10);
  cold();
  stub.historyQueries.length = 0;
  await ok("history.search", { query: "page" });
  await ok("history.search", { limit: 5 });
  assert.deepEqual(stub.historyQueries.map((q) => q.maxUrls), [HISTORY_SCAN + 1, 6]);
  assert.ok(stub.historyQueries.every((q) => q.maxVisits === 1));
  assert.ok(S());
});
