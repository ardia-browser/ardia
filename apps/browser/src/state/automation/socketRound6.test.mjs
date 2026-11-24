import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
const { S, socketClient, freshWindow, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { patchPage } = await import("../tabs/pageState.ts");
const { useLifecycle } = await import("../tabs/sleepingTabs.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { isTabBusy } = await import("./tabCalls.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};


test("a search that resumes after its connection closed or control toggled leaves no handles", async () => {
  for (const interrupt of ["disconnect", "toggle"]) {
    await freshWindow();
    useBrowser.setState({ history: {} });
    const client = socketClient(121);
    const db = stub.chromeHistory("");
    db.clear();
    db.set("https://kept.example/", { title: "Kept", visits: [5] });
    db[Symbol.iterator] = function () {
      delete db[Symbol.iterator];
      if (interrupt === "disconnect") stub.emitControlClose(121);
      else {
        S().updateSettings({ cliControl: false });
        S().updateSettings({ cliControl: true });
      }
      return Map.prototype[Symbol.iterator].call(this);
    };
    const reply = await client.call("history.search", {});
    await controlOn();
    const id = reply.result?.items?.[0]?.id;
    if (id) assert.equal((await client.call("history.remove", { ids: [id] })).error?.code, "bad_request", `${interrupt}: no handle table came back`);
    assert.ok(db.has("https://kept.example/"));
  }
});

test("an apply whose wait spans a disconnect or a control toggle registers nothing", async () => {
  for (const interrupt of ["disconnect", "toggle"]) {
    const { windowId, tab } = await freshWindow();
    const client = socketClient(131);
    const stuck = S().newTab(windowId, { url: "https://stuck.example/", background: true });
    let finish;
    webviews.set(stuck, { discard: () => new Promise((resolve) => (finish = resolve)) });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const sleeping = client.fire("apply", { ops: [{ op: "tab.sleep", tabs: [stuck] }] });
      await settle(20);
      if (interrupt === "disconnect") stub.emitControlClose(131);
      else {
        S().updateSettings({ cliControl: false });
        S().updateSettings({ cliControl: true });
      }
      mock.timers.tick(10_000);
      await sleeping.catch(() => null);
      assert.equal(isTabBusy(stuck), false, `${interrupt}: no busy entry`);
      finish("discarded");
      await settle();
      await controlOn();
      const next = await client.ok("apply", { ops: [{ op: "tab.rename", tab, title: null }] });
      assert.equal(next.late, undefined, `${interrupt}: no late result stored`);
    } finally {
      mock.timers.reset();
      webviews.delete(stuck);
    }
  }
});

test("a cold read is one bounded engine call: 200,001 rows asked, exactly 200,000 is complete", async () => {
  const client = socketClient(141);
  await freshWindow();
  useBrowser.setState({ history: {} });
  const db = stub.chromeHistory("");
  db.clear();
  for (let i = 0; i < 199_999; i++) db.set(`chrome://x${i}/`, { title: "", visits: [10_000_000 - i] });
  db.set("https://only.example/", { title: "Only", visits: [1] });
  stub.historyQueries.length = 0;
  const whole = await client.ok("history.search", { limit: 5 });
  assert.deepEqual(whole.items.map((h) => h.url), ["https://only.example/"]);
  assert.equal(whole.truncated, false);
  assert.equal(whole.total, 1);
  assert.ok(stub.historyQueries.length <= 2);
  assert.ok(stub.historyQueries.reduce((n, q) => n + q.maxUrls, 0) <= 200_001 + 6, JSON.stringify(stub.historyQueries.map((q) => q.maxUrls)));
  db.set("https://older.example/", { title: "Older", visits: [0] });
  db.set("chrome://one-more/", { title: "", visits: [0] });
  const cut = await client.ok("history.search", { limit: 5 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.reason, "scanLimit");
  db.clear();
});

test("history handles are 160-bit hex from the secure source", async () => {
  const client = socketClient(151);
  await freshWindow();
  useBrowser.setState({ history: {} });
  const db = stub.chromeHistory("");
  db.clear();
  db.set("https://r.example/", { title: "R", visits: [5] });
  const [row] = (await client.ok("history.search", {})).items;
  assert.match(row.id, /^h[0-9a-f]{40}$/);
  db.clear();
});

test("wake on a sleeping tab whose view is gone says no_view, not awake", async () => {
  const client = socketClient(161);
  const { windowId } = await freshWindow();
  const tabId = S().newTab(windowId, { url: "https://gone.example/", background: true });
  useLifecycle.setState((l) => ({ discarded: { ...l.discarded, [tabId]: true } }));
  webviews.set(tabId, { isAttached: () => false, reload: () => Promise.resolve(undefined) });
  try {
    const result = await client.ok("apply", { ops: [{ op: "tab.wake", tabs: [tabId] }] });
    assert.equal(result.results[0].outcomes[tabId], "no_view");
  } finally {
    webviews.delete(tabId);
    useLifecycle.setState((l) => ({ discarded: { ...l.discarded, [tabId]: false } }));
  }
});

test("tabs.back across engines on a clean page asks nothing and goes back", async () => {
  const client = socketClient(171);
  const { tab } = await freshWindow();
  S().updateTab(tab, { page: { kind: "loaded", navigation: null } });
  patchPage(tab, { engineBack: { engine: "webkit", url: "https://prev.example/" } });
  webviews.set(tab, { evaluate: async () => false, goBack: () => {} });
  const dialogs = shellNativeModules.ArdiaDialogs;
  const confirm = dialogs.confirm;
  let asked = 0;
  dialogs.confirm = (o) => (asked++, confirm(o));
  try {
    assert.equal((await client.ok("tabs.back", { tab })).ok, true);
    assert.equal(asked, 0);
  } finally {
    dialogs.confirm = confirm;
    webviews.delete(tab);
  }
});
