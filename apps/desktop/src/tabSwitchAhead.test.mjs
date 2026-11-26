import assert from "node:assert/strict";
import test from "node:test";
import { HostTab, showInPlaceOf } from "./hostTab.ts";
import { reserveTab } from "./hostTabQueue.ts";
import { forgetSwitchViews, registerSwitchView, tabsSwitchedAhead, watchTabSwitches } from "./tabSwitchAhead.ts";
import { createInputRegions } from "./inputRegions.ts";
import { createStageController, createWebAnimator, PEEK_MOVING_ATTRIBUTE } from "./peekStageMotion.ts";

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

test("an early switch keeps each page's card radii in the page holes, there and back again", async () => {
  const { store, sent } = stage();
  const host = { bootstrap: { windowId: "main", profileId: "default" }, call: async () => "null", invoke: (method) => (sent.push({ method }), Promise.resolve(method === "tab.create" ? { browserId: 40 + sent.length, chromeTabId: 40 + sent.length } : null)), onEvent: () => () => {} };
  const areas = [];
  const microtasks = [];
  const registry = createInputRegions({
    send: null,
    viewport: () => ({ width: 1440, height: 900 }),
    rectOf: (element) => element.rect,
    receivesPointer: () => true,
    watch: () => () => {},
    animating: () => false,
    conceal: () => {},
    microtask: (run) => microtasks.push(run),
    frame: (run) => microtasks.push(run),
    frameTime: () => 0,
    timeout: () => 0,
    clearTimeout: () => {},
    pagesChanged: (pages) => areas.push(pages),
    report: (error) => { throw error; },
  });
  const settle = () => { while (microtasks.length) microtasks.shift()(); };
  const cardA = { upperLeft: 0, upperRight: 0, lowerRight: 0, lowerLeft: 0 };
  const cardB = { upperLeft: 0, upperRight: 0, lowerRight: 10, lowerLeft: 10 };
  const getterA = () => cardA;
  const getterB = () => cardB;
  const slotA = { isConnected: true, rect: RECT };
  const slotB = { isConnected: true, rect: RECT };
  const a = new HostTab(host, { key: "a", url: "https://a.test/" }, () => {});
  const b = new HostTab(host, { key: "b", url: "https://b.test/" }, () => {});
  await a.ready;
  await b.ready;
  registerSwitchView("a", { tab: () => a, slot: slotA, regions: registry });
  registerSwitchView("b", { tab: () => b, slot: slotB, regions: registry });
  await a.viewport({ rect: RECT, visible: true, radii: cardA });
  await b.viewport({ rect: RECT, visible: false });
  registry.setPage(slotA, true, undefined, getterA);
  registry.setPage(slotB, false, undefined, getterB);
  settle();
  assert.deepEqual(areas.at(-1).map((page) => [page.slot === slotA ? "a" : "b", page.cardRadii]), [["a", cardA]]);
  const stop = watchTabSwitches(store);
  store.activate("b");
  settle();
  assert.equal(tabsSwitchedAhead(), 1);
  assert.deepEqual(areas.at(-1).map((page) => [page.slot === slotA ? "a" : "b", page.cardRadii]), [["b", cardB]]);
  await b.viewport({ rect: RECT, visible: true, radii: cardA });
  await a.viewport({ rect: RECT, visible: false });
  store.activate("a");
  settle();
  assert.equal(tabsSwitchedAhead(), 2);
  assert.deepEqual(areas.at(-1).map((page) => [page.slot === slotA ? "a" : "b", page.cardRadii]), [["a", cardA]]);
  stop();
});

test("an early switch sends the hidden page's viewport without radii, as the page itself would", async () => {
  const { sent, store, view } = stage();
  const a = await view("a");
  const b = await view("b");
  const radii = { upperLeft: 0, upperRight: 0, lowerRight: 10, lowerLeft: 10 };
  await a.viewport({ rect: RECT, visible: true, radii });
  await b.viewport({ rect: RECT, visible: false });
  const stop = watchTabSwitches(store);
  sent.length = 0;
  store.activate("b");
  const viewports = sent.filter((call) => call.method === "tab.viewport").map((call) => call.args);
  assert.deepEqual(viewports.map((args) => [args.id, args.visible, args.radii ?? null]), [[b.identity.browserId, true, radii], [a.identity.browserId, false, null]]);
  sent.length = 0;
  await a.viewport({ rect: RECT, visible: false });
  assert.equal(sent.filter((call) => call.method === "tab.viewport").length, 0);
  stop();
});

async function viewportTelemetry() {
  globalThis.__DEV__ = false;
  await import("../../browser/src/test-native/index.ts");
  const client = await import("../../browser/src/state/telemetry/client.ts");
  const placement = await import("../../browser/src/state/telemetry/windowPlacementCounts.ts");
  client.loadChoice();
  client.setSharing(true, "onboarding");
  placement.takeWindowPlacementCounts();
  return { client, placement, rejected: () => placement.takeWindowPlacementCounts().linux_page_viewports_rejected };
}

function refusingHost(answer) {
  const viewports = [];
  let nextId = 70;
  const host = {
    bootstrap: { windowId: "main", profileId: "default" },
    call: async () => "null",
    invoke: (method, args) => {
      if (method === "tab.create") { nextId++; return Promise.resolve({ browserId: nextId, chromeTabId: nextId }); }
      if (method === "tab.viewport") { viewports.push(args); return answer(args); }
      return Promise.resolve(null);
    },
    onEvent: () => () => {},
  };
  return { host, viewports };
}

const settled = (promise) => promise.then(() => "ok", () => "refused");

test("a refused page viewport is counted once per send: five queued visible reports make one send and one count", async () => {
  const t = await viewportTelemetry();
  try {
    const { host, viewports } = refusingHost(() => Promise.reject(new Error("refused")));
    const tab = new HostTab(host, { key: "held", url: "https://held.test/" }, () => {});
    await tab.ready;
    const hold = reserveTab(host, "held");
    const sends = [1, 2, 3, 4, 5].map((n) => tab.viewport({ rect: { ...RECT, width: RECT.width - n }, visible: true }));
    hold.finish();
    assert.deepEqual(await Promise.all(sends.map(settled)), ["refused", "refused", "refused", "refused", "refused"]);
    assert.equal(viewports.length, 1);
    assert.equal(t.rejected(), 1);
  } finally {
    t.client.setSharing(false, "settings");
  }
});

test("a refused send whose latest report hid the page is not counted", async () => {
  const t = await viewportTelemetry();
  try {
    const { host, viewports } = refusingHost(() => Promise.reject(new Error("refused")));
    const tab = new HostTab(host, { key: "hidden", url: "https://hidden.test/" }, () => {});
    await tab.ready;
    const hold = reserveTab(host, "hidden");
    const shown = tab.viewport({ rect: RECT, visible: true });
    const hidden = tab.viewport({ rect: RECT, visible: false });
    hold.finish();
    await Promise.all([settled(shown), settled(hidden)]);
    assert.deepEqual(viewports.map((args) => args.visible), [false]);
    assert.equal(t.rejected(), 0);
  } finally {
    t.client.setSharing(false, "settings");
  }
});

test("an early tab switch counts a refused shown viewport, not the hidden one", async () => {
  const t = await viewportTelemetry();
  try {
    const { host } = refusingHost(() => Promise.reject(new Error("refused")));
    const from = new HostTab(host, { key: "from", url: "https://from.test/" }, () => {});
    const to = new HostTab(host, { key: "to", url: "https://to.test/" }, () => {});
    await from.ready;
    await to.ready;
    from.lastViewport = JSON.stringify({ rect: RECT, visible: true });
    from.presentsNow = () => true;
    to.presentsNow = () => true;
    assert.equal(showInPlaceOf(from, to), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(t.rejected(), 1);
  } finally {
    t.client.setSharing(false, "settings");
  }
});

test("a viewport sent while sharing is off is not counted when it is refused after sharing turns on", async () => {
  const t = await viewportTelemetry();
  try {
    let refuse;
    const { host, viewports } = refusingHost(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const tab = new HostTab(host, { key: "consent", url: "https://consent.test/" }, () => {});
    await tab.ready;
    t.client.setSharing(false, "settings");
    const send = settled(tab.viewport({ rect: RECT, visible: true }));
    for (let i = 0; i < 20 && !viewports.length; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(viewports.length, 1);
    t.client.setSharing(true, "settings");
    refuse(new Error("refused"));
    assert.equal(await send, "refused");
    assert.equal(t.rejected(), 0);
  } finally {
    t.client.setSharing(false, "settings");
  }
});

test("a viewport send is counted by the consent in force when the host was handed it, whatever microtask sharing turns on in", async () => {
  const t = await viewportTelemetry();
  try {
    for (let depth = 0; depth < 8; depth++) {
      t.client.setSharing(false, "settings");
      t.rejected();
      let sharingAtInvoke = null;
      const { host } = refusingHost(() => Promise.reject(new Error("refused")));
      const invoke = host.invoke;
      host.invoke = (method, args) => {
        if (method === "tab.viewport") sharingAtInvoke = t.client.isSharing();
        return invoke(method, args);
      };
      const key = `depth-${depth}`;
      const tab = new HostTab(host, { key, url: `https://${key}.test/` }, () => {});
      await tab.ready;
      const hold = reserveTab(host, key);
      const send = settled(tab.viewport({ rect: RECT, visible: true }));
      hold.finish();
      let step = Promise.resolve();
      for (let i = 0; i < depth; i++) step = step.then(() => {});
      await step.then(() => t.client.setSharing(true, "settings"));
      assert.equal(await send, "refused");
      assert.notEqual(sharingAtInvoke, null, `depth ${depth}: the host was never handed the viewport`);
      assert.equal(t.rejected(), sharingAtInvoke ? 1 : 0, `depth ${depth}: sharing ${sharingAtInvoke ? "on" : "off"} when the host was handed the viewport`);
    }
  } finally {
    t.client.setSharing(false, "settings");
  }
});

test("a Peek being expanded to a tab is not switched in early: it publishes its own viewport once the stage settles", async () => {
  const { sent, store, view, regions } = stage();
  const a = await view("a");
  const b = await view("b");
  await a.viewport({ rect: RECT, visible: true });
  await b.viewport({ rect: { x: 400, y: 100, width: 600, height: 500 }, visible: false });
  const attributes = new Map();
  const root = { setAttribute: (name, value) => attributes.set(name, value), removeAttribute: (name) => attributes.delete(name) };
  const slot = { key: "b", closest: (selector) => (selector === `[${PEEK_MOVING_ATTRIBUTE}]` && attributes.has(PEEK_MOVING_ATTRIBUTE) ? root : null) };
  registerSwitchView("b", { tab: () => b, slot, regions: { setPage: (node, visible) => regions.set(node.key, visible) } });
  const finishes = [];
  const animated = { animate: () => { let resolve; const finished = new Promise((done) => (resolve = done)); finishes.push(resolve); return { finished, cancel() {} }; }, setAttribute() {}, removeAttribute() {} };
  let settledBounds = 0;
  const geometry = { width: 1200, height: 900, card: { x: 300, y: 100, width: 600, height: 600 }, source: { x: 0, y: 0, width: 10, height: 10 }, fullscreen: false };
  const controller = createStageController(createWebAnimator(() => root, () => animated, () => animated, () => settledBounds++), { state() {}, done: () => store.activate("b") }, () => ({ geometry, reduceMotion: false }));
  const stop = watchTabSwitches(store);
  controller.begin(1);
  for (const finish of finishes.splice(0)) finish();
  await new Promise((resolve) => setImmediate(resolve));
  sent.length = 0;
  controller.promote(1);
  assert.ok(attributes.has(PEEK_MOVING_ATTRIBUTE));
  for (const finish of finishes.splice(0)) finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [], "the promoted page is not shown in the source tab's rect while the stage still moves");
  assert.equal(attributes.has(PEEK_MOVING_ATTRIBUTE), false);
  assert.equal(settledBounds, 2);
  stop();
});

test("an early switch hands the shown page's rect to the regions as the switched-in page's acknowledged rect", async () => {
  const { store, view } = stage();
  const a = await view("a");
  const b = await view("b");
  await a.viewport({ rect: RECT, visible: true });
  await b.viewport({ rect: { ...RECT, x: 0 }, visible: false });
  const acknowledged = [];
  registerSwitchView("b", { tab: () => b, slot: { key: "b" }, regions: { setPage() {}, pageViewport: (slot, rect) => acknowledged.push([slot.key, rect]) } });
  const stop = watchTabSwitches(store);
  store.activate("b");
  assert.deepEqual(acknowledged, [], "nothing is recorded before the host accepts the switched-in viewport");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(acknowledged, [["b", RECT]]);
  stop();
});

test("an early switch whose switched-in viewport the host refuses records no rect for that page", async () => {
  const { host, store, view } = stage();
  const a = await view("a");
  const b = await view("b");
  await a.viewport({ rect: RECT, visible: true });
  await b.viewport({ rect: { ...RECT, x: 0 }, visible: false });
  const areas = [];
  const regions = createInputRegions({
    send: null,
    viewport: () => ({ width: 1600, height: 1000 }),
    rectOf: (element) => element.rect,
    receivesPointer: () => true,
    watch: () => () => {},
    animating: () => false,
    conceal() {},
    microtask: (run) => queueMicrotask(run),
    frame: () => {},
    frameTime: () => 0,
    timeout: () => 0,
    clearTimeout() {},
    pagesChanged: (pages) => areas.push(pages.map((page) => page.rect)),
  });
  const domRect = { x: 5, y: 6, width: 70, height: 80 };
  const slot = { key: "b", isConnected: true, rect: domRect, children: [] };
  registerSwitchView("b", { tab: () => b, slot, regions });
  const invoke = host.invoke;
  host.invoke = (method, args) => (method === "tab.viewport" && args.id === b.identity.browserId && args.visible ? Promise.reject(new Error("refused")) : invoke(method, args));
  const stop = watchTabSwitches(store);
  store.activate("b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tabsSwitchedAhead(), 1);
  assert.equal(b.shownViewport(), undefined, "the refused show is forgotten by the tab");
  regions.flushNow();
  assert.deepEqual(areas.at(-1), [domRect], "the regions never adopted the refused rect");
  stop();
});
