import assert from "node:assert/strict";
import { test } from "node:test";

const setTimeoutHoldingExit = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = setTimeoutHoldingExit(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
globalThis.__DEV__ = false;
const folder = new Map();
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `dev${++ids}`,
    deviceName: () => "Test Computer",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "ok",
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      const here = [...folder].filter(([, f]) => f.scope === scope);
      return { files: here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("../../browser/src/test-native/index.ts");
const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
const { forwardProfileDeletions, whenProfileGone } = await import("./profileRetirement.ts");
const S = () => useBrowser.getState();

test("a profile deleted in a window that isn't the sync authority is forwarded; the authority's own deletions are left to its engine", () => {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const home = S().createProfile({ name: "Home" });
  let leading = false;
  const sent = [];
  const stop = forwardProfileDeletions(() => leading, async (id) => void sent.push(id), () => assert.fail("nothing is retired here while another window leads"));
  try {
    S().deleteProfile(work);
    leading = true;
    S().deleteProfile(home);
  } finally {
    stop();
  }
  assert.deepEqual(sent, [work]);
});

test("a deletion no authority answered is retried until one does, or retired here once this window leads", async () => {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const home = S().createProfile({ name: "Home" });
  let leading = false;
  let answering = false;
  const pending = [];
  const timers = { set: (done) => (pending.push(done), pending.length), clear: () => {} };
  const delivered = [];
  const retiredHere = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const stop = forwardProfileDeletions(
    () => leading,
    async (id) => {
      if (!answering) throw new Error("no authority answered");
      delivered.push(id);
    },
    (id) => retiredHere.push(id),
    timers,
  );
  try {
    S().deleteProfile(work);
    await tick();
    assert.deepEqual(delivered, []);
    assert.equal(pending.length, 1, "a retry is scheduled");
    answering = true;
    pending.shift()();
    await tick();
    assert.deepEqual(delivered, [work], "the retry reaches the authority once it answers");
    answering = false;
    S().deleteProfile(home);
    await tick();
    leading = true;
    pending.shift()();
    assert.deepEqual(retiredHere, [home], "a window that became the authority meanwhile retires it itself");
  } finally {
    stop();
  }
});

test("the authority retires a forwarded profile only once the deletion reaches its store, and gives up on one that never leaves", async () => {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const kept = S().createProfile({ name: "Kept" });
  const retired = [];
  const pending = [];
  const timers = { set: (done) => (pending.push(done), pending.length), clear: () => {} };
  whenProfileGone(useBrowser, work, () => retired.push(work));
  whenProfileGone(useBrowser, kept, () => retired.push(kept), 10, timers);
  assert.deepEqual(retired, [], "the profile is still in this window's store");
  const { [work]: _gone, ...profiles } = S().profiles;
  useBrowser.setState({ profiles, profileOrder: S().profileOrder.filter((id) => id !== work) });
  assert.deepEqual(retired, [work], "the session patch that removes it lets the retirement through");
  for (const done of pending.splice(0)) done();
  const { [kept]: _late, ...rest } = S().profiles;
  useBrowser.setState({ profiles: rest });
  assert.deepEqual(retired, [work], "a profile that didn't leave before the wait ran out is never retired");
});

test("a forwarded deletion takes the profile out of sync on the authority, as a deletion on a Mac does", async () => {
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  shell.docs.clear();
  const work = S().createProfile({ name: "Work" });
  const engine = await import("../../browser/src/state/sync/engine.ts?desktop-retire");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();
  await engine.syncNow();
  assert.ok(engine.useSync.getState().profiles[work], "Work syncs");
  const { [work]: _gone, ...profiles } = S().profiles;
  useBrowser.setState({ profiles, profileOrder: S().profileOrder.filter((id) => id !== work) });
  await engine.syncNow();
  assert.ok(engine.useSync.getState().profiles[work], "a session patch alone leaves the link dormant, as for a profile missing at launch");
  whenProfileGone(useBrowser, work, () => engine.retireProfile(work));
  await engine.syncNow();
  assert.equal(engine.useSync.getState().profiles[work], undefined, "the forwarded deletion retires it");
});
