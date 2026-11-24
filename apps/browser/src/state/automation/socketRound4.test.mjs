import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { parseRequest } = await import("./automationMethods.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

const { fire, call, ok } = socketClient(91);
const cold = () => useBrowser.setState((s) => ({ history: Object.fromEntries(Object.entries(s.history).filter(([k]) => k !== "")) }));

function visited(rows) {
  const db = stub.chromeHistory("");
  db.clear();
  rows.forEach((url, i) => db.set(url, { title: `Page ${i}`, visits: [10_000_000 - i] }));
  return db;
}

test("cold history past the raw-row cap says it's cut off and pages on to the older web pages", async () => {
  await freshWindow();
  cold();
  const web = ["https://w0.example/", "https://w1.example/", "https://w2.example/"];
  visited([...Array.from({ length: 100_000 }, (_, i) => `chrome://x${i}/`), ...web]);
  const first = await ok("history.search", { limit: 2 });
  assert.deepEqual(first.items.map((h) => h.url), web.slice(0, 2));
  assert.equal(first.nextOffset, 2, "the next page resumes the scan");
  const rest = await ok("history.search", { limit: 2, offset: first.nextOffset });
  assert.deepEqual(rest.items.map((h) => h.url), web.slice(2));
  useBrowser.setState((s) => ({ history: { ...s.history, "": { list: [], floor: 5, ready: true } } }));
  const warm = await ok("history.search", { limit: 2 });
  assert.deepEqual(warm.items.map((h) => h.url), web.slice(0, 2), "a warm cache that stops at the cap reads on from the engine");
  cold();
  stub.chromeHistory("").clear();
});

test("ids must be what both sides echo: lone surrogates refused, true, 1.5 and 2^53 too", () => {
  for (const id of ["\ud800", "a\udc00b", true, 1.5, 2 ** 53]) {
    const parsed = parseRequest(JSON.stringify({ id, method: "hello" }));
    assert.equal(parsed.id, null, String(id));
    assert.equal(parsed.error?.code, "bad_request");
  }
  assert.equal(parseRequest(JSON.stringify({ id: "😀", method: "hello" })).id, "😀");
});

test("a timed-out op stays outstanding: its tab is busy until the late answer, which the next batch reports", async () => {
  const { windowId, tab: shown } = await freshWindow();
  const first = S().newTab(windowId, { url: "https://first.example/", background: true });
  const stuck = S().newTab(windowId, { url: "https://stuck.example/", background: true });
  let finish;
  webviews.set(first, { discard: () => Promise.resolve("discarded") });
  webviews.set(stuck, { discard: () => new Promise((resolve) => (finish = resolve)) });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sleeping = fire("apply", { ops: [{ op: "tab.sleep", tabs: [first, shown, stuck] }] });
    for (let i = 0; i < 20; i++) await tick();
    mock.timers.tick(10_000);
    const reply = await sleeping;
    assert.equal(reply.result.error.code, "failed");
    assert.match(reply.result.error.message, /outcome unknown/);
    assert.deepEqual(reply.result.error.changed?.tabs, [first], "only tabs that changed; the shown one is left out");
    const busy = await call("apply", { ops: [{ op: "tab.rename", tab: stuck, title: "x" }] });
    assert.equal(busy.result.error.code, "refused");
    assert.match(busy.result.error.message, /busy/);
    assert.notEqual(S().tabs[stuck].customTitle, "x");
    finish("discarded");
    for (let i = 0; i < 5; i++) await tick();
    const after = await ok("apply", { ops: [{ op: "tab.rename", tab: stuck, title: "y" }] });
    assert.equal(after.ok, true);
    assert.deepEqual(after.late, { [stuck]: "asleep" }, "the late answer is reported once");
    assert.equal((await ok("apply", { ops: [{ op: "tab.rename", tab: stuck, title: "z" }] })).late, undefined);
  } finally {
    mock.timers.reset();
    webviews.delete(first);
    webviews.delete(stuck);
  }
});
