import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
const { S, socketClient, freshWindow, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile } = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { isTabBusy } = await import("./tabCalls.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

const a = socketClient(101);
const b = socketClient(102);
const cold = () => useBrowser.setState({ history: {} });
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

function visited(engine, rows) {
  const db = stub.chromeHistory(engine);
  db.clear();
  rows.forEach((url, i) => db.set(url, { title: `Page ${i}`, visits: [10_000_000 - i] }));
  return db;
}

test("history ids are this connection's handles: another connection's or a closed one's are unknown", async () => {
  await freshWindow();
  cold();
  const db = visited("", ["https://h.example/"]);
  const [row] = (await a.ok("history.search", {})).items;
  assert.match(row.id, /^h/);
  assert.doesNotMatch(row.id, /10000000|\./, "no timestamp or hash in the handle");
  const other = await b.call("history.remove", { ids: [row.id] });
  assert.equal(other.error?.code, "bad_request");
  assert.match(other.error.message, /unknown history id; search again/);
  stub.emitControlClose(101);
  await settle();
  assert.equal((await a.call("history.remove", { ids: [row.id] })).error?.code, "bad_request", "the handle went with its connection");
  assert.ok(db.has("https://h.example/"));
});

test("history.remove removes the page, every visit to it, including ones after the search", async () => {
  await freshWindow();
  cold();
  const url = "https://again.example/";
  const db = visited("", [url]);
  const [row] = (await a.ok("history.search", {})).items;
  db.set(url, { title: "Again", visits: [10_000_000, 20_000_000] });
  await a.ok("history.remove", { ids: [row.id] });
  await settle();
  assert.ok(!db.has(url));
});

test("history.remove deletes from the profile it read, even if the default changes during the read", async () => {
  await freshWindow();
  cold();
  const work = S().createProfile({ name: "Work" });
  const workEngine = engineProfile(S(), work);
  const mine = visited("", ["https://mine.example/"]);
  const theirs = visited(workEngine, ["https://mine.example/"]);
  const iterate = mine[Symbol.iterator];
  mine[Symbol.iterator] = function () {
    S().setDefaultProfile(work);
    delete mine[Symbol.iterator];
    return iterate.call(this);
  };
  const [row] = (await a.ok("history.search", {})).items;
  assert.equal(S().settings.defaultProfileId, work, "the default switched during the read");
  await a.ok("history.remove", { ids: [row.id] });
  await settle();
  assert.ok(!mine.has("https://mine.example/"), "removed where it was read");
  assert.ok(theirs.has("https://mine.example/"), "the new default's history is untouched");
});

test("a cold read stops at its raw-row budget and says scanLimit, apart from the page window", async () => {
  await freshWindow();
  cold();
  visited("", [...Array.from({ length: 250_000 }, (_, i) => `chrome://x${i}/`), "https://late.example/"]);
  stub.historyQueries.length = 0;
  const cut = await a.ok("history.search", { limit: 5 });
  assert.deepEqual(cut.items, []);
  assert.equal(cut.truncated, true);
  assert.equal(cut.reason, "scanLimit");
  assert.equal(cut.total, null);
  assert.ok(stub.historyQueries.every((q) => q.maxUrls <= 200_001), "every engine call is bounded");
  visited("", Array.from({ length: 20_001 }, (_, i) => `https://p${i}.example/`));
  const window = await a.ok("history.search", { offset: 19_999, limit: 5 });
  assert.equal(window.reason, "window");
  stub.chromeHistory("").clear();
});

function stuckTab(windowId, url) {
  const id = S().newTab(windowId, { url, background: true });
  let finish;
  webviews.set(id, { discard: () => new Promise((resolve) => (finish = resolve)) });
  return { id, finish: (outcome) => finish(outcome) };
}

async function timeOut(client, tabId) {
  const sleeping = client.fire("apply", { ops: [{ op: "tab.sleep", tabs: [tabId] }] });
  for (let i = 0; i < 20; i++) await tick();
  mock.timers.tick(10_000);
  return sleeping;
}

test("a late result belongs to the connection whose op timed out", async () => {
  const { windowId, tab } = await freshWindow();
  const probe = { ops: [{ op: "tab.rename", tab, title: null }] };
  const stuck = stuckTab(windowId, "https://late-a.example/");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await timeOut(a, stuck.id);
    stuck.finish("discarded");
    await settle();
    assert.equal((await b.ok("apply", probe)).late, undefined, "B doesn't get A's result");
    assert.deepEqual((await a.ok("apply", probe)).late, { [stuck.id]: "asleep" });
  } finally {
    mock.timers.reset();
    webviews.delete(stuck.id);
  }
});

test("a tab with a call that never settles is freed when it closes, after 60 s, and when control goes off", async () => {
  const { windowId, tab } = await freshWindow();
  const probe = { ops: [{ op: "tab.rename", tab, title: null }] };
  const closing = stuckTab(windowId, "https://closing.example/");
  const forever = stuckTab(windowId, "https://forever.example/");
  const revoked = stuckTab(windowId, "https://revoked.example/");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await timeOut(a, closing.id);
    S().closeTabs([closing.id]);
    assert.equal(isTabBusy(closing.id), false, "closing the tab frees it");

    await timeOut(a, forever.id);
    assert.equal(isTabBusy(forever.id), true);
    mock.timers.tick(60_000);
    assert.equal(isTabBusy(forever.id), false, "freed after 60 s, outcome unknown");

    await timeOut(a, revoked.id);
    S().updateSettings({ cliControl: false });
    assert.equal(isTabBusy(revoked.id), false, "control off frees it");
    await controlOn();
    revoked.finish("discarded");
    await settle();
    assert.equal((await a.ok("apply", probe)).late, undefined, "a completion from before control went off is dropped");
  } finally {
    mock.timers.reset();
    for (const t of [closing, forever, revoked]) webviews.delete(t.id);
  }
});

test("wake says awake only after a reload; the page fallback says it started loading", async () => {
  const { windowId } = await freshWindow();
  const asleep = S().newTab(windowId, { url: "https://asleep.example/", background: true });
  S().updateTab(asleep, { page: { kind: "asleep" } });
  const result = await a.ok("apply", { ops: [{ op: "tab.wake", tabs: [asleep] }] });
  assert.equal(result.results[0].outcomes[asleep], "loading");
});
