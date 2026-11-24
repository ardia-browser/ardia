import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { replyLine } = await import("./controlSocket.ts");
const { parseRequest } = await import("./automationMethods.ts");
const { LINE_BYTE_LIMIT, DROPPED_MARKER_ROOM, CLIPPED_STRING_CHARS, fittedEvent } = await import("./socketWire.ts");
const { listedParams, methodSpec, UnlistedParamError } = await import("./socketCatalog.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

const { fire, call, ok } = socketClient(71);
const other = socketClient(72);
const bytes = (line) => Buffer.byteLength(line, "utf8") + 1;
const cold = () => useBrowser.setState((s) => ({ history: Object.fromEntries(Object.entries(s.history).filter(([k]) => k !== "")) }));

function visited(rows) {
  const db = stub.chromeHistory("");
  db.clear();
  rows.forEach((url, i) => db.set(url, { title: `Page ${i}`, visits: [1_000_000 - i] }));
  return db;
}

test("a clipped history URL is never a deletion key: rows carry ids, and remove takes them", async () => {
  await freshWindow();
  cold();
  const long = `https://x.example/?q=${"a".repeat(CLIPPED_STRING_CHARS + 100)}`;
  const prefix = long.slice(0, CLIPPED_STRING_CHARS);
  const db = visited([long, prefix]);
  const found = await ok("history.search", {});
  const clippedRow = found.items.find((h) => h.clipped?.includes("url"));
  const prefixRow = found.items.find((h) => !h.clipped);
  assert.equal(clippedRow.url, prefix, "the long URL is cut to exactly the other page's URL");
  assert.equal(typeof clippedRow.id, "string");
  assert.notEqual(clippedRow.id, prefixRow.id);

  const byUrl = await call("history.remove", { urls: [clippedRow.url] });
  assert.equal(byUrl.error?.code, "bad_request", "a URL that might be clipped isn't taken as a key");
  assert.ok(db.has(prefix) && db.has(long), "nothing was deleted");

  await ok("history.remove", { ids: [clippedRow.id] });
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(!db.has(long), "the clipped row's own page went");
  assert.ok(db.has(prefix), "the page whose URL equals the clipped text stayed");

  assert.equal((await call("history.remove", { urls: [prefixRow.url] })).error?.code, "bad_request", "a URL as long as the clip is ambiguous too");
  await ok("history.remove", { ids: [prefixRow.id] });
  db.set("https://short.example/", { title: "Short", visits: [5] });
  await ok("history.remove", { urls: ["https://short.example/"] });
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(!db.has(prefix) && !db.has("https://short.example/"), "ids and short URLs both work as keys");
  assert.equal((await call("history.remove", { ids: ["h-nope"] })).error?.code, "bad_request");
  assert.equal((await call("history.remove", {})).error?.code, "bad_request");
});

test("history ids are the same cold and warm", async () => {
  await freshWindow();
  cold();
  visited(["https://one.example/", "https://two.example/"]);
  const coldIds = (await ok("history.search", {})).items.map((h) => h.id);
  const list = ["https://one.example/", "https://two.example/"].map((url, i) => ({ url, title: `Page ${i}`, favicon: null, visits: 1, lastVisit: 1_000_000 - i }));
  useBrowser.setState((s) => ({ history: { ...s.history, "": { list, floor: 0, ready: true } } }));
  const warmIds = (await ok("history.search", {})).items.map((h) => h.id);
  assert.deepEqual(warmIds, coldIds);
  cold();
});

test("cold history counts only the pages the warm cache keeps (http, https and file)", async () => {
  await freshWindow();
  cold();
  const rows = Array.from({ length: 12 }, (_, i) => (i % 2 ? `chrome://page${i}/` : `https://p${i}.example/`));
  visited(rows);
  const coldPage = await ok("history.search", { offset: 2, limit: 2 });
  const web = rows.map((url, i) => ({ url, title: `Page ${i}`, favicon: null, visits: 1, lastVisit: 1_000_000 - i })).filter((h) => !h.url.startsWith("chrome:"));
  useBrowser.setState((s) => ({ history: { ...s.history, "": { list: web, floor: -Infinity, ready: true } } }));
  const warmPage = await ok("history.search", { offset: 2, limit: 2 });
  assert.deepEqual(coldPage, warmPage);
  assert.deepEqual(coldPage.items.map((h) => h.url), ["https://p4.example/", "https://p6.example/"]);
  cold();
  const whole = await ok("history.search", { limit: 100 });
  assert.equal(whole.total, 6, "the exact total counts web pages only");
});

test("request ids are bounded: strings up to 256 UTF-8 bytes, refused past that with id null", async () => {
  await freshWindow();
  assert.equal(parseRequest(JSON.stringify({ id: "é".repeat(128), method: "hello" })).id, "é".repeat(128));
  const long = parseRequest(JSON.stringify({ id: "é".repeat(129), method: "hello" }));
  assert.equal(long.id, null);
  assert.equal(long.error.code, "bad_request");
  const before = stub.controlSocket.replies.length;
  const huge = "i".repeat(1_048_559 - 40);
  stub.emitControlRequest({ connection: 71, generation: stub.controlSocket.generation, line: JSON.stringify({ id: huge, method: "live.list" }) });
  for (let i = 0; i < 20 && stub.controlSocket.replies.length === before; i++) await tick();
  const reply = stub.controlSocket.replies[before].line;
  assert.ok(bytes(reply) < 1024, `${bytes(reply)} bytes`);
  assert.equal(JSON.parse(reply).id, null);
  assert.equal(JSON.parse(reply).error.code, "bad_request");
});

test("an event at the edge leaves room for the largest dropped marker", () => {
  const event = fittedEvent("tab.navigated", 1, { url: "y".repeat(1_048_574 - 60) }, null);
  const marker = `{"dropped":${Number.MAX_SAFE_INTEGER},`.length - 1;
  assert.ok(marker <= DROPPED_MARKER_ROOM);
  assert.ok(bytes(event) + marker <= LINE_BYTE_LIMIT, `${bytes(event)} + ${marker}`);
});

test("an oversized partial apply keeps ok, applied and the failure's index, code and message", () => {
  const results = Array.from({ length: 40 }, (_, i) => ({ op: "tab.rename", tabs: [`t${i}`], title: "t".repeat(40_000) }));
  const error = { index: 40, code: "no_window", message: `Operation 40 (tab.close): ${"m".repeat(20_000)}`, changed: { tabs: ["t1", "t2"] } };
  const line = replyLine(5, { result: { ok: false, applied: 40, results, error, tabs: [], groups: [], windows: [] } }, "apply");
  assert.ok(bytes(line) <= LINE_BYTE_LIMIT);
  const { result } = JSON.parse(line);
  assert.equal(result.ok, false, "a failed batch never reads as ok");
  assert.equal(result.oversized, true);
  assert.equal(result.applied, 40);
  assert.equal(result.error.index, 40);
  assert.equal(result.error.code, "no_window");
  assert.ok(result.error.message.startsWith("Operation 40 (tab.close): mmm"));
  assert.ok(result.error.message.length <= 4096);
  assert.deepEqual(result.error.changed, { tabs: ["t1", "t2"] });
});

test("a declared nested object reached through its property descriptor is guarded too", () => {
  const guarded = listedParams(methodSpec("subscribe"), { events: [], idle: { tab: [60], bogus: 1 } });
  const { value } = Object.getOwnPropertyDescriptor(guarded, "idle");
  assert.deepEqual(value.tab, [60]);
  assert.throws(() => value.bogus, UnlistedParamError);
});

test("a native call that never settles fails its op after 10 s and doesn't stall other clients' batches", async () => {
  const { windowId } = await freshWindow();
  const stuck = S().newTab(windowId, { url: "https://stuck.example/", background: true });
  const fine = S().newTab(windowId, { url: "https://fine.example/", background: true });
  webviews.set(stuck, { discard: () => new Promise(() => {}) });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sleeping = fire("apply", { ops: [{ op: "tab.sleep", tabs: [stuck] }, { op: "tab.rename", tab: fine, title: "After" }] });
    const second = other.fire("apply", { ops: [{ op: "tab.rename", tab: fine, title: "Second" }] });
    for (let i = 0; i < 20; i++) await tick();
    mock.timers.tick(10_000);
    const reply = await sleeping;
    assert.equal(reply.result.ok, false);
    assert.equal(reply.result.applied, 0);
    assert.equal(reply.result.error.code, "failed");
    assert.match(reply.result.error.message, /10 s/);
    assert.notEqual(S().tabs[fine].customTitle, "After", "the batch stopped at the stuck op");
    const next = await second;
    assert.equal(next.result.ok, true, "the next client's batch ran");
    assert.equal(S().tabs[fine].customTitle, "Second");
  } finally {
    mock.timers.reset();
    webviews.delete(stuck);
  }
});

test("apply re-checks control after each native wait inside an op", async () => {
  const { windowId } = await freshWindow();
  const a = S().newTab(windowId, { url: "https://a1.example/", background: true });
  const b = S().newTab(windowId, { url: "https://b1.example/", background: true });
  const discarded = [];
  const waiting = [];
  webviews.set(a, { discard: () => new Promise((resolve) => waiting.push(() => (discarded.push(a), resolve("discarded")))) });
  webviews.set(b, { discard: () => (discarded.push(b), Promise.resolve("discarded")) });
  try {
    const sleeping = fire("apply", { ops: [{ op: "tab.sleep", tabs: [a, b] }] });
    for (let i = 0; i < 50 && !waiting.length; i++) await tick();
    S().updateSettings({ cliControl: false });
    waiting[0]();
    const reply = await sleeping;
    assert.equal(reply.result?.ok ?? false, false);
    assert.deepEqual(discarded, [a], "the second tab wasn't put to sleep after control went off");
  } finally {
    webviews.delete(a);
    webviews.delete(b);
  }
});
