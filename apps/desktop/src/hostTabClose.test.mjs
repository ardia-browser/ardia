import assert from "node:assert/strict";
import test from "node:test";
import { HostTab } from "./hostTab.ts";
import { startHostTabLifecycle } from "./hostTabLifecycle.ts";
import { forgetSwitchViews, registerSwitchView, tabsSwitchedAhead, watchTabSwitches } from "./tabSwitchAhead.ts";

const RECT = { x: 240, y: 8, width: 1192, height: 884 };
const settle = () => new Promise(setImmediate);

function linuxHost(close = "closes") {
  const bound = new Map();
  const sent = [];
  let nextId = 20;
  const owned = (id, claim) => !!bound.get(id) && bound.get(id).claim === claim;
  const host = {
    bootstrap: { windowId: "main", profileId: "default" },
    call: async () => "null",
    onEvent: () => () => {},
    invoke(method, args) {
      sent.push({ method, args });
      if (method === "tab.create") {
        const held = [...bound].find(([, binding]) => binding.key === args.key);
        if (held && held[1].claim && held[1].claim !== args.previousClaim) return Promise.reject(new Error("This tab already has an active owner"));
        const id = held ? held[0] : ++nextId;
        bound.set(id, { key: args.key, claim: args.claim });
        return Promise.resolve({ browserId: id, chromeTabId: id });
      }
      if (method === "tab.close") {
        if (typeof close === "function") return close(args);
        if (close === "rejects") return Promise.reject(new Error("tab.close failed"));
        if (close === "closes") for (const [id, binding] of bound) if (binding.key === args.key) bound.delete(id);
        return Promise.resolve(null);
      }
      if (method === "tab.release") {
        if (!owned(args.id, args.claim)) return Promise.reject(new Error("No owned live tab"));
        bound.get(args.id).claim = "";
      } else if (method === "tab.presentations") {
        if (!args.tabs.every((tab) => owned(tab.id, tab.claim))) return Promise.reject(new Error("A claimed tab and boolean visibility are required"));
      } else if (method === "tab.viewport") {
        if (!owned(args.id, args.claim)) return Promise.reject(new Error("A live tab and viewport rectangle are required"));
      }
      return Promise.resolve(null);
    },
  };
  return { host, sent, bound };
}

function stage(close) {
  forgetSwitchViews();
  const { host, sent, bound } = linuxHost(close);
  const listeners = new Set();
  const loaded = (id) => ({ id, page: { kind: "loaded", nav: { url: `https://${id}.test/`, seq: 1 } } });
  let state = { tabs: { a: loaded("a"), b: loaded("b") }, windows: { main: { profileId: "default", activeTabIds: { default: "a" } } } };
  const set = (next) => {
    const previous = state;
    state = next;
    for (const listener of [...listeners]) listener(state, previous);
  };
  const store = {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    remove: (key) => { const { [key]: _, ...tabs } = state.tabs; set({ ...state, tabs }); },
    sleep: (key) => set({ ...state, tabs: { ...state.tabs, [key]: { ...state.tabs[key], page: { kind: "asleep" } } } }),
    wake: (key) => set({ ...state, tabs: { ...state.tabs, [key]: loaded(key) } }),
    activate: (id) => set({ ...state, windows: { main: { ...state.windows.main, activeTabIds: { default: id } } } }),
  };
  const errors = [];
  const original = console.error;
  console.error = (...args) => {
    const line = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
    if (line.startsWith("[ardia host]")) errors.push(line);
  };
  const view = async (key) => {
    const tab = new HostTab(host, { key, url: `https://${key}.test/` }, () => {});
    await tab.ready;
    registerSwitchView(key, { tab: () => tab, slot: { key }, regions: { setPage() {} } });
    return tab;
  };
  const stop = () => { console.error = original; forgetSwitchViews(); };
  return { host, sent, bound, store, view, errors, stop };
}

for (const [how, leave] of [["closed", (store) => store.remove("a")], ["put to sleep", (store) => store.sleep("a")]]) {
  test(`a tab ${how} logs no release failure when its view unmounts`, async () => {
    const { host, store, view, errors, stop } = stage();
    try {
      const stopLifecycle = startHostTabLifecycle(host, store);
      const a = await view("a");
      leave(store);
      await settle();
      a.dispose();
      await settle();
      assert.deepEqual(errors, []);
      stopLifecycle();
    } finally {
      stop();
    }
  });
}

test("switching away from a tab that was just closed sends no early switch naming it", async () => {
  const { host, sent, store, view, errors, stop } = stage();
  try {
    const stopLifecycle = startHostTabLifecycle(host, store);
    const stopSwitches = watchTabSwitches(store);
    const a = await view("a");
    const b = await view("b");
    await a.viewport({ rect: RECT, visible: true });
    await b.viewport({ rect: RECT, visible: false });
    store.remove("a");
    await settle();
    sent.length = 0;
    store.activate("b");
    await settle();
    a.dispose();
    await settle();
    assert.deepEqual(errors, []);
    assert.deepEqual(sent.filter((call) => call.method !== "tab.release"), []);
    assert.equal(tabsSwitchedAhead(), 0);
    stopSwitches();
    stopLifecycle();
  } finally {
    stop();
  }
});

test("a key closed by the lifecycle gets a new owner that presents and releases normally", async () => {
  const { host, sent, store, view, errors, stop } = stage();
  try {
    const stopLifecycle = startHostTabLifecycle(host, store);
    const first = await view("a");
    store.sleep("a");
    await settle();
    first.dispose();
    const second = await view("a");
    assert.notEqual(second.claim, first.claim);
    assert.equal(second.presentsNow(), true);
    await second.viewport({ rect: RECT, visible: true });
    assert.equal(second.shownViewport()?.visible, true);
    sent.length = 0;
    second.dispose();
    await settle();
    assert.deepEqual(sent.map((call) => [call.method, call.args.id, call.args.claim]), [["tab.release", second.identity.browserId, second.claim]]);
    assert.deepEqual(errors, []);
    stopLifecycle();
  } finally {
    stop();
  }
});

for (const [close, how, closeErrors] of [
  ["closes", "the host closes its page", []],
  ["defers", "beforeunload keeps its page open", []],
  ["rejects", "tab.close fails", ["[ardia host] tab.close failed"]],
]) {
  test(`a tab put to sleep wakes again under the same key when ${how}`, async () => {
    const { host, sent, store, view, errors, stop } = stage(close);
    try {
      const stopLifecycle = startHostTabLifecycle(host, store);
      const first = await view("a");
      store.sleep("a");
      await settle();
      first.dispose();
      await settle();
      assert.deepEqual(sent.filter((call) => call.method === "tab.release").map((call) => call.args.claim), [first.claim]);
      const second = await view("a");
      assert.equal(second.presentsNow(), true);
      await second.viewport({ rect: RECT, visible: true });
      assert.equal(second.shownViewport()?.visible, true);
      assert.deepEqual(errors, closeErrors);
      stopLifecycle();
    } finally {
      stop();
    }
  });
}

test("a tab woken before its view unmounts keeps presenting when beforeunload kept its page", async () => {
  const { host, sent, store, view, errors, stop } = stage("defers");
  try {
    const stopLifecycle = startHostTabLifecycle(host, store);
    const a = await view("a");
    await a.viewport({ rect: RECT, visible: true });
    store.sleep("a");
    await settle();
    assert.equal(a.presentsNow(), false);
    store.wake("a");
    await settle();
    assert.equal(a.presentsNow(), true);
    sent.length = 0;
    const moved = { ...RECT, width: RECT.width - 100 };
    await a.viewport({ rect: moved, visible: true });
    await a.presentation(true);
    assert.deepEqual(sent.map((call) => call.method), ["tab.viewport", "tab.presentations"]);
    assert.deepEqual(errors, []);
    stopLifecycle();
  } finally {
    stop();
  }
});

test("a resize while a tab is closing reaches the host once beforeunload keeps it and the tab wakes", async () => {
  const { host, sent, store, view, errors, stop } = stage("defers");
  try {
    const stopLifecycle = startHostTabLifecycle(host, store);
    const a = await view("a");
    await a.viewport({ rect: RECT, visible: true });
    store.sleep("a");
    await settle();
    sent.length = 0;
    const resized = { rect: { ...RECT, height: 640 }, visible: true };
    let applied = "pending";
    const held = a.viewport(resized).then((result) => { applied = result; });
    await settle();
    assert.equal(applied, "pending");
    assert.deepEqual(sent, []);
    store.wake("a");
    await held;
    assert.equal(applied, resized);
    assert.deepEqual(sent.filter((call) => call.method === "tab.viewport").map((call) => call.args.rect.height), [640]);
    assert.deepEqual(errors, []);
    stopLifecycle();
  } finally {
    stop();
  }
});

test("a resize held while a tab is closing settles as not applied when its view unmounts", async () => {
  const { host, sent, store, view, stop } = stage("closes");
  try {
    const stopLifecycle = startHostTabLifecycle(host, store);
    const a = await view("a");
    store.sleep("a");
    await settle();
    const held = a.viewport({ rect: RECT, visible: true });
    a.dispose();
    assert.equal(await held, null);
    assert.equal(sent.filter((call) => call.method === "tab.viewport").length, 0);
    stopLifecycle();
  } finally {
    stop();
  }
});

test("a late failure of an earlier close leaves a newer close of the same tab in place", async () => {
  const closes = [];
  const { host, store, view, errors, stop } = stage(() => new Promise((resolve, reject) => closes.push({ resolve, reject })));
  try {
    const stopLifecycle = startHostTabLifecycle(host, store);
    const a = await view("a");
    store.sleep("a");
    await settle();
    store.wake("a");
    await settle();
    assert.equal(a.presentsNow(), true);
    store.sleep("a");
    await settle();
    assert.equal(closes.length, 2);
    closes[0].reject(new Error("tab.close failed"));
    await settle();
    assert.equal(a.presentsNow(), false);
    assert.deepEqual(errors, ["[ardia host] tab.close failed"]);
    closes[1].resolve(null);
    stopLifecycle();
  } finally {
    stop();
  }
});

for (const [how, act, expected] of [
  ["the tab wakes", ({ store }) => store.wake("a"), (resized) => resized],
  ["its view unmounts", ({ a }) => a.dispose(), () => null],
]) {
  test(`a resize the queue holds just before ${how} still settles`, async () => {
    const { host, store, view, stop } = stage("defers");
    try {
      const stopLifecycle = startHostTabLifecycle(host, store);
      const a = await view("a");
      await a.viewport({ rect: RECT, visible: true });
      store.sleep("a");
      await settle();
      const resized = { rect: { ...RECT, height: 640 }, visible: true };
      const held = a.viewport(resized);
      for (let turn = 0; turn < 20 && a.viewportSend; turn++) await Promise.resolve();
      assert.equal(a.viewportSend, undefined);
      act({ store, a });
      const outcome = await Promise.race([held, settle().then(settle).then(() => "still pending")]);
      assert.equal(outcome, expected(resized));
      stopLifecycle();
    } finally {
      stop();
    }
  });
}
