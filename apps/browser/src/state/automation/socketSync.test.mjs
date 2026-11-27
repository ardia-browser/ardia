import assert from "node:assert/strict";
import { after, test } from "node:test";
import { embedded, HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";

const folder = new Map();
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `dev${++ids}`,
    deviceName: () => "Test Mac",
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

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const sync = await import("../sync/engine.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
after(() => {
  S().updateSettings({ cliControl: false });
  void sync.stopSync();
});
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 41, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 500 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 41); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 41);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}
const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const code = async (method, params) => (await call(method, params)).error?.code;

test("sync writes: refused while sync is off, then the same switches Settings has", async () => {
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  const tab = S().windows[windowId].activeTabIds[S().windows[windowId].profileId];

  assert.equal(await code("sync.now"), "refused");
  assert.equal(await code("sync.setType", { type: "history", on: false }), "refused");
  assert.equal(await code("sync.sendTab", { tab, device: "x" }), "refused");
  assert.equal(await code("sync.addRemoteProfile", { syncId: "x" }), "refused");
  assert.equal(await code("sync.removeRemoteProfile", { syncId: "x" }), "refused");

  sync.startSync();
  assert.ok("ok" in (await sync.turnOnSync("/sync")));
  assert.equal(sync.useSync.getState().status, "starting");
  assert.equal(await code("sync.setType", { type: "history", on: false }), "refused", "no writes before the first pass has loaded what's saved");
  for (let i = 0; i < 500 && sync.useSync.getState().status === "starting"; i++) await tick();
  const now = await ok("sync.now");
  assert.ok(["updated", "updating"].includes(now.status), now.status);

  assert.equal((await ok("sync.setType", { type: "history", on: false })).types.history, false);
  assert.equal(sync.useSync.getState().types.history, false);
  assert.equal((await ok("sync.setType", { type: "history", on: true })).types.history, true);

  await sync.syncNow();
  assert.ok(sync.useSync.getState().profiles.default, "the default profile links on its first sync");
  assert.equal((await ok("sync.setProfile", { profile: "default", on: false })).profiles.default.enabled, false);
  assert.equal(await code("sync.setOpenTabs", { profile: "default", on: true }), "refused", "the profile doesn't sync");
  await ok("sync.setProfile", { profile: "default", on: true });
  await ok("sync.setOpenTabs", { profile: "default", on: true });
  assert.equal(S().profiles.default.syncTabs, true);
  await ok("sync.setOpenTabs", { profile: "default", on: false });
  assert.equal(await code("sync.setProfile", { profile: "nope", on: true }), "no_window");

  assert.deepEqual(await ok("sync.devices"), [], "no other device takes tabs yet");
  assert.equal(await code("sync.sendTab", { tab, device: "dev-elsewhere" }), "no_window");
  const blank = S().newTab(windowId, { url: "about:blank" });
  assert.equal(await code("sync.sendTab", { tab: blank, device: "dev-elsewhere" }), "refused", "only web pages are sent");
});

const dialogs = stub.shellNativeModules.ArdiaDialogs;
const plainConfirm = dialogs.confirm;
function answerConfirm(confirmed) {
  const asked = [];
  dialogs.confirm = async (options) => (asked.push(options), { confirmed, suppressed: false });
  return asked;
}
const publishedLast = (key) =>
  [...folder.values()]
    .map((f) => JSON.parse(f.payload))
    .flatMap((f) => f.ops ?? Object.entries(f.records ?? {}).map(([k, r]) => ({ k, v: r.v })))
    .filter((op) => op.k === key)
    .at(-1);

async function offeredAfterDeleting(...names) {
  for (const name of names) S().deleteProfile(S().profileOrder.find((id) => S().profiles[id].name === name));
  await sync.syncNow();
  await sync.syncNow();
  return names.map((name) => sync.useSync.getState().remoteProfiles.find((p) => p.name === name));
}

test("sync.addRemoteProfile and sync.removeRemoteProfile do what Add and Remove… do in Settings (#4577)", async () => {
  try {
    S().createProfile({ name: "Work" });
    await sync.syncNow();
    await sync.syncNow();
    const [{ syncId }] = await offeredAfterDeleting("Work");
    const offered = () => sync.useSync.getState().remoteProfiles.find((p) => p.syncId === syncId);
    assert.ok((await ok("sync.status")).remoteProfiles.some((p) => p.syncId === syncId), "sync.status lists it with its syncId");

    assert.equal(await code("sync.addRemoteProfile", {}), "bad_request");
    assert.equal(await code("sync.addRemoteProfile", { syncId: "not-a-profile" }), "no_window");
    const untouched = { order: S().profileOrder, remote: sync.useSync.getState().remoteProfiles };
    const hostileAsked = answerConfirm(true);
    for (const { id, value } of HOSTILE_VALUES) {
      for (const shape of typeof value === "string" ? embedded(value, syncId, syncId).filter((v) => v !== syncId) : [value]) {
        for (const method of ["sync.addRemoteProfile", "sync.removeRemoteProfile"]) {
          const got = await code(method, { syncId: shape });
          assert.ok(["no_window", "bad_request"].includes(got), `${method} with ${id}: ${got}`);
        }
      }
    }
    assert.equal(S().profileOrder, untouched.order, "no hostile syncId added a profile");
    assert.deepEqual(sync.useSync.getState().remoteProfiles, untouched.remote, "or removed one");
    assert.equal(hostileAsked.length, 0, "or got as far as the question");
    const added = await ok("sync.addRemoteProfile", { syncId });
    assert.equal(S().profiles[added.profile]?.name, "Work", "it joins the synced profile, not an empty one with the same name");
    assert.equal(added.profiles[added.profile].syncId, syncId);
    assert.equal(offered(), undefined, "it leaves the list");
    assert.equal(await code("sync.addRemoteProfile", { syncId }), "no_window", "it's on this Mac now");
    assert.equal(await code("sync.removeRemoteProfile", { syncId }), "no_window", "a profile on this Mac isn't removed from sync");

    await offeredAfterDeleting("Work");
    const asked = answerConfirm(false);
    const kept = await ok("sync.removeRemoteProfile", { syncId });
    assert.equal(kept.removed, false, "Cancel removes nothing");
    assert.equal(asked[0].onlyIfShown, true, "it asks only where the question can be seen");
    assert.equal(asked[0].title, "Remove “Work” from Sync?", "the same question Settings asks");
    assert.ok(offered(), "still listed after Cancel");

    answerConfirm(true);
    const removed = await ok("sync.removeRemoteProfile", { syncId });
    assert.equal(removed.removed, true);
    assert.equal(removed.remoteProfiles.find((p) => p.syncId === syncId), undefined);
    await sync.syncNow();
    assert.equal(publishedLast(`prof:${syncId}`)?.v, null, "the removal reached the sync folder");
    assert.equal(offered(), undefined, "and stays gone after syncing");
    assert.equal(await code("sync.removeRemoteProfile", { syncId }), "no_window");
  } finally {
    dialogs.confirm = plainConfirm;
  }
});

test("a profile another one shares data with can't be removed, and adding the sharer answers the sharer's id (#4577)", async () => {
  try {
    const owner = S().createProfile({ name: "Owner" });
    S().createProfile({ name: "Child", shareWith: owner });
    await sync.syncNow();
    await sync.syncNow();
    const [child, ownerRow] = await offeredAfterDeleting("Child", "Owner");
    assert.equal(ownerRow.sharedByOthers, true);
    const asked = answerConfirm(true);
    assert.equal(await code("sync.removeRemoteProfile", { syncId: ownerRow.syncId }), "refused", "as Settings disables its Remove…");
    assert.equal(asked.length, 0, "refused before asking");

    const added = await ok("sync.addRemoteProfile", { syncId: child.syncId });
    assert.equal(S().profiles[added.profile]?.name, "Child", "the profile asked for, not the one it shares data with");
    const ownerHere = S().profiles[added.profile].dataId;
    assert.equal(S().profiles[ownerHere]?.name, "Owner", "Owner comes along, as Settings' Add brings it");
    assert.equal(sync.useSync.getState().remoteProfiles.find((p) => p.name === "Owner"), undefined);
  } finally {
    dialogs.confirm = plainConfirm;
  }
});

test("sync.now answers after a pass that started after the call, not the one already running", async () => {
  const native = globalThis.acTestNativeModules.ArdiaSync;
  const plain = native.chainStatus;
  let release;
  let passes = 0;
  native.chainStatus = async () => {
    passes++;
    if (passes === 1) await new Promise((resolve) => (release = resolve));
    return "ok";
  };
  try {
    const running = sync.syncNow();
    for (let i = 0; i < 50 && !release; i++) await tick();
    assert.ok(release, "a pass is running");
    const id = ++nextId;
    const before = stub.controlSocket.replies.length;
    stub.emitControlRequest({ connection: 41, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method: "sync.now" }) });
    for (let i = 0; i < 30; i++) await tick();
    assert.equal(stub.controlSocket.replies.slice(before).filter((r) => r.connection === 41).length, 0, "no reply while only the earlier pass has run");
    release();
    await running;
    for (let i = 0; i < 500 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 41); i++) await tick();
    assert.equal(passes, 2, "the reply came after a second pass ran");
  } finally {
    native.chainStatus = plain;
  }
});

test("sync writes are refused while sync is turning off, so a sent tab is never dropped after an ok", async () => {
  const native = globalThis.acTestNativeModules.ArdiaSync;
  const plain = native.forget;
  let release;
  native.forget = () => new Promise((resolve) => (release = resolve));
  try {
    assert.ok(sync.useSync.getState().enabled);
    const stopping = sync.stopSync();
    for (let i = 0; i < 500 && !release; i++) await tick();
    assert.ok(release, "stopping is under way");
    assert.equal(sync.useSync.getState().enabled, true, "Settings still shows sync on while it winds down");
    assert.equal(await code("sync.setType", { type: "history", on: false }), "refused");
    assert.equal(await code("sync.now"), "refused");
    release();
    await stopping;
  } finally {
    native.forget = plain;
  }
});

async function heldPasses(run) {
  const native = globalThis.acTestNativeModules.ArdiaSync;
  const plain = native.chainStatus;
  const held = { passes: 0, release: null };
  try {
    if (!sync.useSync.getState().enabled) assert.ok("ok" in (await sync.turnOnSync("/sync")));
    for (let i = 0; i < 500 && sync.useSync.getState().status === "starting"; i++) await tick();
    await sync.syncNow();
    native.chainStatus = async () => {
      held.passes++;
      if (held.passes === 1) await new Promise((resolve) => (held.release = resolve));
      return "ok";
    };
    const running = sync.syncNow();
    for (let i = 0; i < 500 && !held.release; i++) await tick();
    assert.ok(held.release, "a pass is running");
    await run(held, running);
  } finally {
    native.chainStatus = plain;
  }
}

test("a sync.now queued behind a running pass starts no normal pass once sync begins turning off", async () => {
  await heldPasses(async (held, running) => {
    const id = ++nextId;
    const before = stub.controlSocket.replies.length;
    stub.emitControlRequest({ connection: 41, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method: "sync.now" }) });
    for (let i = 0; i < 10; i++) await tick();
    const stopping = sync.stopSync();
    held.release();
    await running;
    await stopping;
    for (let i = 0; i < 500 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 41); i++) await tick();
    const reply = JSON.parse(stub.controlSocket.replies.slice(before).find((r) => r.connection === 41).line);
    assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
    assert.equal(held.passes, 2, "the running pass and the retiring pass, no normal pass between them");
  });
});

test("a sync.now queued behind a running pass starts nothing once control turns off", async () => {
  await heldPasses(async (held, running) => {
    stub.emitControlRequest({ connection: 41, generation: stub.controlSocket.generation, line: JSON.stringify({ id: ++nextId, method: "sync.now" }) });
    for (let i = 0; i < 10; i++) await tick();
    S().updateSettings({ cliControl: false });
    held.release();
    await running;
    for (let i = 0; i < 50; i++) await tick();
    assert.equal(held.passes, 1, "only the pass that was already running");
  });
  S().updateSettings({ cliControl: true });
});

test("a sync.now that waited behind a pass reports nothing ran when sync locked meanwhile", async () => {
  await heldPasses(async (held, running) => {
    const queued = sync.syncNow();
    for (let i = 0; i < 10; i++) await tick();
    const keepLocked = sync.useSync.subscribe((st) => st.status !== "locked" && sync.useSync.setState({ status: "locked" }));
    sync.useSync.setState({ status: "locked" });
    held.release();
    await running;
    const ran = await queued;
    keepLocked();
    assert.equal(ran, false);
    assert.equal(held.passes, 1, "no second pass started");
  });
  sync.useSync.setState({ status: "updated" });
});

test("a sync write's readback waits for state that another window applies a moment later, and gives up at its deadline", async () => {
  const { settles } = await import("./socketSync.ts");
  const before = !!sync.useSync.getState().types.history;
  const later = settles(() => sync.useSync.getState().types.history === !before, 500);
  setTimeout(() => sync.useSync.setState((st) => ({ types: { ...st.types, history: !before } })), 30);
  assert.equal(await later, true);
  assert.equal(await settles(() => false, 40), false);
  sync.useSync.setState((st) => ({ types: { ...st.types, history: before } }));
});
