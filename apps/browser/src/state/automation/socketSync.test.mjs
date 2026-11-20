import assert from "node:assert/strict";
import { after, test } from "node:test";

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
