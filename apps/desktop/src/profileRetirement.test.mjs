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
  const workRetired = whenProfileGone(useBrowser, work, () => retired.push(work), 10, timers);
  const keptRetired = whenProfileGone(useBrowser, kept, () => retired.push(kept), 10, timers);
  assert.deepEqual(retired, [], "the profile is still in this window's store");
  const { [work]: _gone, ...profiles } = S().profiles;
  useBrowser.setState({ profiles, profileOrder: S().profileOrder.filter((id) => id !== work) });
  await workRetired;
  assert.deepEqual(retired, [work], "the session patch that removes it lets the retirement through, and the call answers only then");
  for (const done of pending.splice(0)) done();
  await assert.rejects(keptRetired, "a wait that runs out answers with a failure, so the sender tries again");
  const { [kept]: _late, ...rest } = S().profiles;
  useBrowser.setState({ profiles: rest });
  assert.deepEqual(retired, [work], "and nothing retires it behind the sender's back");
});

test("a deletion that reaches the authority after its first wait ran out is still retired, through the sender's retry", async () => {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const listeners = new Set();
  const authority = {
    state: { profiles: { ...S().profiles } },
    getState: () => authority.state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    receive(profiles) {
      authority.state = { profiles };
      for (const listener of [...listeners]) listener(authority.state);
    },
  };
  const retries = [];
  const waits = [];
  const senderTimers = { set: (done) => (retries.push(done), retries.length), clear: () => {} };
  const authorityTimers = { set: (done) => (waits.push(done), waits.length), clear: () => {} };
  const retired = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const stop = forwardProfileDeletions(() => false, (id) => whenProfileGone(authority, id, () => retired.push(id), 10, authorityTimers), () => assert.fail("this window doesn't lead"), senderTimers);
  try {
    S().deleteProfile(work);
    await tick();
    assert.equal(waits.length, 1, "the authority still has the profile, so it waits for the deletion to reach it");
    waits.shift()();
    await tick();
    assert.deepEqual(retired, [], "the first wait ran out before the deletion arrived");
    assert.equal(retries.length, 1, "so the sender schedules another try");
    const { [work]: _gone, ...profiles } = authority.state.profiles;
    authority.receive(profiles);
    retries.shift()();
    await tick();
    assert.deepEqual(retired, [work], "the retry finds it gone and retires it");
  } finally {
    stop();
  }
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
  await whenProfileGone(useBrowser, work, () => engine.retireProfile(work));
  await engine.syncNow();
  assert.equal(engine.useSync.getState().profiles[work], undefined, "the forwarded deletion retires it");
});

test("a setting chosen in a window that isn't the sync authority reaches the authority's ledger, as a choice on a Mac does", async () => {
  const { forwardSettingChoices } = await import("./settingChoices.ts");
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  shell.docs.clear();
  const engine = await import("../../browser/src/state/sync/engine.ts?desktop-choices");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();
  let leading = false;
  const sent = [];
  const stop = forwardSettingChoices(
    () => leading,
    async (names) => {
      sent.push(names);
      engine.noteSettingsChosen(names);
    },
    () => assert.fail("recorded through the authority, not here"),
  );
  try {
    S().updateSettings({ pageFrame: 12 });
    assert.deepEqual(sent, [["pageFrame"]], "the choice is forwarded");
    await engine.syncNow();
    leading = true;
    S().updateSettings({ pageFrame: 13 });
    assert.equal(sent.length, 1, "the authority's own choices are left to its engine");
  } finally {
    stop();
  }
  engine.noteSettingsChosen(["sidebarSide"]);
  assert.ok(JSON.parse(shell.docs.get("sync.json")).settingEdits?.sidebarSide, "a forwarded choice is stamped into the authority's ledger, though its own store never saw the choice");
});

test("a setting choice the authority dropped during a handoff is retried, or recorded here once this window leads", async () => {
  const { forwardSettingChoices } = await import("./settingChoices.ts");
  S().hydrate({});
  let leading = false;
  let answering = false;
  const pending = [];
  const timers = { set: (done) => (pending.push(done), pending.length), clear: () => {} };
  const delivered = [];
  const recordedHere = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const stop = forwardSettingChoices(
    () => leading,
    async (names) => {
      if (!answering) throw new Error("the authority went away mid-call");
      delivered.push(names);
    },
    (names) => recordedHere.push(names),
    timers,
  );
  try {
    S().updateSettings({ pageFrame: 10 });
    await tick();
    assert.deepEqual(delivered, []);
    assert.equal(pending.length, 1, "a retry is scheduled");
    answering = true;
    pending.shift()();
    await tick();
    assert.deepEqual(delivered, [["pageFrame"]], "the retry reaches the new authority");
    answering = false;
    S().updateSettings({ sidebarSide: S().settings.sidebarSide === "left" ? "right" : "left" });
    await tick();
    leading = true;
    pending.shift()();
    assert.deepEqual(recordedHere, [["sidebarSide"]], "a window that became the authority records it itself");
  } finally {
    stop();
  }
});
