import assert from "node:assert/strict";
import test from "node:test";
import { HostTab } from "./hostTab.ts";
import { forgetSwitchViews, registerSwitchView, tabsSwitchedAhead, watchTabSwitches } from "./tabSwitchAhead.ts";

const RECT = { x: 240, y: 8, width: 1192, height: 884 };

function stage() {
  forgetSwitchViews();
  const sent = [];
  let nextId = 10;
  const host = {
    bootstrap: { windowId: "main", profileId: "default" },
    call: async () => "null",
    invoke: (method, args) => {
      sent.push({ method, args });
      if (method === "tab.create") { nextId++; return Promise.resolve({ browserId: nextId, chromeTabId: nextId }); }
      return Promise.resolve(null);
    },
    onEvent: () => () => {},
  };
  const listeners = new Set();
  let state = { windows: { main: { profileId: "default", activeTabIds: { default: "a" } } } };
  const store = {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    activate: (id) => {
      const previous = state;
      state = { windows: { main: { ...state.windows.main, activeTabIds: { default: id } } } };
      for (const listener of listeners) listener(state, previous);
    },
  };
  const regions = new Map();
  const view = async (key) => {
    const tab = new HostTab(host, { key, url: `https://${key}.test/` }, () => {});
    await tab.ready;
    const slot = { key };
    registerSwitchView(key, { tab: () => tab, slot, regions: { setPage: (node, visible) => regions.set(node.key, visible) } });
    return tab;
  };
  return { host, sent, store, view, regions };
}

test("activating a tab shows it in the shown tab's place before the shell renders", async () => {
  const { sent, store, view, regions } = stage();
  const a = await view("a");
  const b = await view("b");
  await a.viewport({ rect: RECT, visible: true });
  await b.viewport({ rect: RECT, visible: false });
  const stop = watchTabSwitches(store);
  sent.length = 0;
  store.activate("b");
  assert.deepEqual(sent.map((call) => call.method), ["tab.presentations", "tab.viewport", "tab.viewport"]);
  assert.deepEqual(sent[0].args.tabs.map((tab) => [tab.id, tab.visible]), [[b.identity.browserId, true], [a.identity.browserId, false]]);
  assert.deepEqual({ id: sent[1].args.id, rect: sent[1].args.rect, visible: sent[1].args.visible }, { id: b.identity.browserId, rect: RECT, visible: true });
  assert.deepEqual({ id: sent[2].args.id, visible: sent[2].args.visible }, { id: a.identity.browserId, visible: false });
  assert.deepEqual([...regions], [["b", true], ["a", false]]);
  assert.equal(tabsSwitchedAhead(), 1);
  sent.length = 0;
  await b.viewport({ rect: RECT, visible: true });
  await a.viewport({ rect: RECT, visible: false });
  assert.deepEqual(sent, []);
  stop();
});

test("a split or an unshown source tab waits for the shell's own layout", async () => {
  const { sent, store, view } = stage();
  const a = await view("a");
  const b = await view("b");
  const c = await view("c");
  const stop = watchTabSwitches(store);
  sent.length = 0;
  store.activate("b");
  assert.deepEqual(sent, []);
  await a.viewport({ rect: RECT, visible: true });
  await c.viewport({ rect: { ...RECT, x: 800 }, visible: true });
  sent.length = 0;
  store.activate("a");
  store.activate("b");
  assert.deepEqual(sent, []);
  assert.equal(tabsSwitchedAhead(), 0);
  stop();
});
