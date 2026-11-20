import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { useLifecycle } = await import("../tabs/sleepingTabs.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

const dialogs = shellNativeModules.ArdiaDialogs;
const originals = { confirm: dialogs.confirm, dismiss: dialogs.dismissShownOnly, can: dialogs.dismissesShownOnly };
const restore = () => Object.assign(dialogs, { confirm: originals.confirm, dismissShownOnly: originals.dismiss, dismissesShownOnly: originals.can });
after(() => {
  restore();
  S().updateSettings({ cliControl: false });
});

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};

async function windowThatAsks() {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  S().newTab(windowId, { url: "https://b.example/", background: true });
  S().newTab(windowId, { url: "https://c.example/", background: true });
  S().updateSettings({ warnBeforeClosingWindow: true });
  return windowId;
}

test("a client that disconnects while its close question is up takes the question away and frees the guard", async () => {
  const windowId = await windowThatAsks();
  const waiting = [];
  const dismissed = [];
  dialogs.confirm = (options) => new Promise((resolve) => waiting.push({ options, resolve }));
  dialogs.dismissShownOnly = (key) => {
    dismissed.push(key);
    for (const w of waiting.splice(0)) if (!key || w.options.dismissKey === key) w.resolve({ confirmed: false, suppressed: false });
    return Promise.resolve();
  };
  try {
    const a = socketClient(181);
    const b = socketClient(182);
    void a.fire("windows.close", { window: windowId }).catch(() => null);
    for (let i = 0; i < 50 && !waiting.length; i++) await tick();
    assert.equal(waiting.length, 1);
    stub.emitControlClose(181);
    await settle();
    assert.equal(dismissed.length, 1, "the disconnected client's question was taken away");
    const second = b.fire("windows.close", { window: windowId });
    for (let i = 0; i < 50 && !waiting.length; i++) await tick();
    assert.equal(waiting.length, 1, "the second client is asked again: the guard was freed");
    waiting[0].resolve({ confirmed: false, suppressed: false });
    assert.equal((await second).error?.code, "refused");
  } finally {
    restore();
  }
});

test("without native dismissal the guard holds until the question closes, then frees", async () => {
  const windowId = await windowThatAsks();
  const waiting = [];
  dialogs.confirm = () => new Promise((resolve) => waiting.push(resolve));
  dialogs.dismissesShownOnly = false;
  try {
    const a = socketClient(191);
    const b = socketClient(192);
    void a.fire("windows.close", { window: windowId }).catch(() => null);
    for (let i = 0; i < 50 && !waiting.length; i++) await tick();
    stub.emitControlClose(191);
    await settle();
    const held = await b.call("windows.close", { window: windowId });
    assert.match(held.error?.message ?? "", /already closing or asking/, "held while the dialog is still up");
    waiting[0]({ confirmed: true, suppressed: false });
    await settle();
    assert.ok(S().windows[windowId], "a yes after the client left closes nothing");
    const after = b.fire("windows.close", { window: windowId });
    for (let i = 0; i < 50 && waiting.length < 2; i++) await tick();
    assert.equal(waiting.length, 2, "freed once the dialog closed");
    waiting[1](({ confirmed: false, suppressed: false }));
    await after;
  } finally {
    restore();
  }
});

async function wakeOutcome(tabId) {
  const client = socketClient(201);
  const result = await client.ok("apply", { ops: [{ op: "tab.wake", tabs: [tabId] }] });
  return result.results[0].outcomes[tabId];
}

function sleepingTab(windowId, url) {
  const id = S().newTab(windowId, { url, background: true });
  useLifecycle.setState((l) => ({ discarded: { ...l.discarded, [id]: true } }));
  return id;
}

test("wake knows a detached view only when it can check: async checks are awaited, unknown is unverified", async () => {
  const { windowId } = await freshWindow();
  const detached = sleepingTab(windowId, "https://detached.example/");
  const unknown = sleepingTab(windowId, "https://unknown.example/");
  const orphan = sleepingTab(windowId, "https://orphan.example/");
  const flaky = sleepingTab(windowId, "https://flaky.example/");
  let attached = true;
  const reloads = [];
  webviews.set(detached, { isAttached: () => Promise.resolve(false), reload: () => (reloads.push(detached), Promise.resolve()) });
  webviews.set(unknown, { reload: () => Promise.resolve() });
  webviews.set(flaky, { isAttached: () => attached, reload: () => ((attached = false), Promise.reject(new Error("gone"))) });
  try {
    assert.equal(await wakeOutcome(detached), "no_view");
    assert.deepEqual(reloads, [], "a known-detached view isn't reloaded");
    assert.equal(await wakeOutcome(unknown), "reload_unverified");
    assert.equal(await wakeOutcome(orphan), "no_view", "a discarded tab with no registered view");
    assert.equal(await wakeOutcome(flaky), "no_view", "it detached and the reload failed");
  } finally {
    for (const id of [detached, unknown, flaky]) webviews.delete(id);
    useLifecycle.setState({ discarded: {} });
  }
});

test("the history fallback keeps the exact total: 10 web rows and a chrome:// row, limit 5", async () => {
  const client = socketClient(211);
  await freshWindow();
  useBrowser.setState({ history: {} });
  const db = stub.chromeHistory("");
  db.clear();
  db.set("chrome://settings/", { title: "", visits: [100] });
  for (let i = 0; i < 10; i++) db.set(`https://w${i}.example/`, { title: `W${i}`, visits: [50 - i] });
  const page = await client.ok("history.search", { limit: 5 });
  assert.equal(page.items.length, 5);
  assert.equal(page.total, 10);
  assert.equal(page.nextOffset, 5);
  assert.equal(page.truncated, false);
  db.clear();
});

test("handles draw their 20 random bytes from crypto.getRandomValues where it exists", async () => {
  const client = socketClient(221);
  await freshWindow();
  useBrowser.setState({ history: {} });
  const db = stub.chromeHistory("");
  db.clear();
  db.set("https://r.example/", { title: "R", visits: [5] });
  const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const sizes = [];
  globalThis.crypto.getRandomValues = (array) => (sizes.push(array.length), original(array));
  try {
    const [row] = (await client.ok("history.search", {})).items;
    assert.match(row.id, /^h[0-9a-f]{40}$/);
    assert.deepEqual(sizes, [20]);
  } finally {
    globalThis.crypto.getRandomValues = original;
    db.clear();
  }
});
