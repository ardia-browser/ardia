import assert from "node:assert/strict";
import test from "node:test";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
import { createSessionWriter, initialHostSession, snapshotHostSession, startHostPersistence } from "./hostSession.ts";
import { cloneSessionValue, mergeSession } from "./hostSessionMerge.ts";

const tick = () => new Promise(setImmediate);
const hostFor = (windowId) => ({ bootstrap: { windowId, profileId: "default", startup: false } });

function sharedSession() {
  const initial = initialHostSession(hostFor("b"), initialHostSession(hostFor("a"), null));
  const aKey = initial.windows.a.tabIds[0];
  const bKey = initial.windows.b.tabIds[0];
  initial.tabs[aKey] = { ...initial.tabs[aKey], url: "A0", title: "A" };
  initial.tabs[bKey] = { ...initial.tabs[bKey], url: "B0", title: "B" };
  useBrowser.getState().hydrate(initial);
  return { initial: cloneSessionValue(snapshotHostSession(useBrowser.getState())), aKey, bKey };
}

function stateStore(session, windowId) {
  useBrowser.getState().hydrate(session);
  let state = { ...useBrowser.getState(), ui: { ...useBrowser.getState().ui, focusedWindowId: windowId, focusOrder: [windowId] } };
  state.tabs = Object.fromEntries(Object.entries(state.tabs).map(([key, tab]) => [key, { ...tab, lastActiveAt: session.tabs[key].lastActiveAt }]));
  const listeners = new Set();
  return {
    getState: () => state,
    setState: (patch) => { const previous = state; state = { ...state, ...patch }; for (const listener of listeners) listener(state, previous); },
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
  };
}

function sharedFileHost(initial) {
  let file = cloneSessionValue(initial);
  const listeners = new Map();
  const jobs = [];
  const service = {
    get file() { return file; },
    jobs,
    async runNext() {
      const job = jobs.shift();
      const previous = file;
      file = mergeSession(job.pair.base, job.pair.session, file);
      job.resolve(cloneSessionValue(file));
      await tick();
      for (const [windowId, listener] of listeners) {
        listener("ArdiaHost", "session", cloneSessionValue({ base: windowId === job.windowId ? job.pair.session : previous, session: file, sourceWindowId: job.windowId }));
      }
      await tick();
      await tick();
    },
    async settle() {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 20 && jobs.length; i++) await service.runNext();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
    client: (windowId) => ({
      bootstrap: { windowId, profileId: "default", startup: false, session: cloneSessionValue(initial) },
      onEvent: (listener) => (listeners.set(windowId, listener), () => listeners.delete(windowId)),
      onBeforeClose: () => () => {},
      invoke(method, pair) {
        if (method === "session.read") return Promise.resolve(cloneSessionValue(file));
        return new Promise((resolve) => jobs.push({ windowId, pair: cloneSessionValue(pair), resolve }));
      },
    }),
  };
  return service;
}

async function withBrowserEvents(run) {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

async function hideAndShow() {
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  document.hidden = false;
  await tick();
  await tick();
}

async function closeAfterPeerUpdate(flushClose) {
  const { initial, aKey, bKey } = sharedSession();
  const host = sharedFileHost(initial);
  const a = stateStore(initial, "a");
  const b = stateStore(initial, "b");
  const stops = [startHostPersistence(host.client("a"), a, initial), startHostPersistence(host.client("b"), b, initial)];
  try {
    await hideAndShow();
    while (host.jobs.length) await host.runNext();
    let s = b.getState();
    b.setState({ tabs: { ...s.tabs, [bKey]: { ...s.tabs[bKey], url: "B1" } } });
    await hideAndShow();
    s = a.getState();
    a.setState({
      tabs: { ...s.tabs, T: { ...s.tabs[aKey], id: "T", url: "T-url", createdAt: s.tabs[aKey].createdAt + 1 } },
      windows: { ...s.windows, a: { ...s.windows.a, tabIds: [...s.windows.a.tabIds, "T"] } },
    });
    await hideAndShow();
    assert.deepEqual(host.jobs.map((job) => job.windowId), ["b", "a"]);
    await host.runNext();
    assert.equal(a.getState().tabs[bKey].url, "B1");
    s = a.getState();
    const { T: _, ...rest } = s.tabs;
    a.setState({ tabs: rest, windows: { ...s.windows, a: { ...s.windows.a, tabIds: s.windows.a.tabIds.filter((id) => id !== "T") } } });
    if (flushClose) await hideAndShow();
    else await tick();
    await host.settle();
    assert.equal(a.getState().tabs.T, undefined);
    assert.equal(host.file.tabs.T, undefined);
    assert.equal(host.file.tabs[bKey].url, "B1");
  } finally {
    for (const stop of stops) stop();
  }
}

test("a tab closed while its creating save is in flight stays closed after a peer update, when the close is left to the timer", () => withBrowserEvents(() => closeAfterPeerUpdate(false)));

test("a tab closed while its creating save is in flight stays closed after a peer update, when the close is flushed behind that save", () => withBrowserEvents(() => closeAfterPeerUpdate(true)));

const row = (id) => ({ id, windowId: "w", profileId: "p", url: `https://${id}.test/` });

function deferredHost() {
  const jobs = [];
  return { jobs, invoke: (_method, pair) => new Promise((resolve) => jobs.push({ pair: cloneSessionValue(pair), resolve })) };
}

test("a save queued behind an in-flight one is rebased when the reply shows a peer write it never saw", async () => {
  const host = deferredHost();
  const B0 = { tabs: { x: row("x") } };
  const writer = createSessionWriter(host, B0);
  const S1 = { tabs: { x: row("x"), T: row("T") } };
  writer.queue(S1);
  void writer.flush();
  await tick();
  assert.equal(host.jobs.length, 1);
  const peer = { tabs: { x: row("x"), y: row("y") } };
  writer.acceptCanonical(peer);
  writer.reconcile({ tabs: { x: row("x"), y: row("y"), T: row("T") } }, true);
  writer.queue({ tabs: { x: row("x"), y: row("y") } });
  const drained = writer.drain();
  let file = mergeSession(B0, S1, peer);
  host.jobs.shift().resolve(cloneSessionValue(file));
  for (let i = 0; i < 6 && !host.jobs.length; i++) await tick();
  assert.equal(host.jobs.length, 1);
  const { pair, resolve } = host.jobs.shift();
  file = mergeSession(pair.base, pair.session, file);
  resolve(cloneSessionValue(file));
  await drained;
  assert.equal(host.jobs.length, 0);
  assert.deepEqual(Object.keys(file.tabs).sort(), ["x", "y"]);
});

test("a save queued behind an in-flight one is rebased on the reply when nothing reconciles it", async () => {
  const host = deferredHost();
  const B0 = { tabs: { x: row("x") } };
  const writer = createSessionWriter(host, B0);
  const S1 = { tabs: { x: row("x"), T: row("T") } };
  writer.queue(S1);
  void writer.flush();
  await tick();
  writer.queue({ tabs: { x: row("x") } });
  const drained = writer.drain();
  let file = mergeSession(B0, S1, B0);
  host.jobs.shift().resolve(cloneSessionValue(file));
  for (let i = 0; i < 6 && !host.jobs.length; i++) await tick();
  const { pair, resolve } = host.jobs.shift();
  file = mergeSession(pair.base, pair.session, file);
  resolve(cloneSessionValue(file));
  await drained;
  assert.equal(file.tabs.T, undefined);
});

test("the final save sent while another is in flight is based on that save, so a tab closed just before quitting stays closed", async () => {
  const host = deferredHost();
  const B0 = { tabs: { x: row("x") } };
  const writer = createSessionWriter(host, B0);
  writer.queue({ tabs: { x: row("x"), T: row("T") } });
  void writer.flush();
  await tick();
  writer.queue({ tabs: { x: row("x"), z: row("z") } });
  void writer.flushFinal();
  assert.equal(host.jobs.length, 2);
  let file = cloneSessionValue(B0);
  for (const job of host.jobs) {
    file = mergeSession(job.pair.base, job.pair.session, file);
    job.resolve(cloneSessionValue(file));
  }
  assert.deepEqual(Object.keys(file.tabs).sort(), ["x", "z"]);
});
