import { asSecret } from "@ardia/core";
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
const downloading = new Set();
const unreadable = new Set();
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `id${++ids}`,
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    enterPhrase: async () => ({ ok: true }),
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
      const unknown = here.map(([id]) => id).filter((id) => !known.includes(id));
      const files = here.filter(([id]) => unknown.includes(id) && !downloading.has(id) && !unreadable.has(id)).map(([id, f]) => ({ id, payload: f.payload }));
      const damaged = unknown.filter((id) => unreadable.has(id) && !downloading.has(id)).map((id) => ({ id, age: 0 }));
      return { files, pending: unknown.filter((id) => downloading.has(id)), damaged, present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const S = () => useBrowser.getState();

class Mac {
  constructor(name) {
    this.name = name;
    S().hydrate({});
    useBrowser.setState({ bookmarksReady: { "": true } });
    this.browser = S();
    this.docs = new Map();
  }
  async with(fn) {
    useBrowser.setState(this.browser, true);
    shell.docs.clear();
    for (const [k, v] of this.docs) shell.docs.set(k, v);
    try {
      return await fn();
    } finally {
      this.browser = S();
      this.docs = new Map(shell.docs);
    }
  }
}

const published = (prefix) =>
  [...folder.values()]
    .map((f) => JSON.parse(f.payload))
    .flatMap((f) => f.ops ?? Object.entries(f.records ?? {}).map(([k, r]) => ({ k, v: r.v })))
    .filter((op) => op.k.startsWith(prefix));
async function turnOn(mac, engine) {
  await mac.with(async () => {
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync("/sync")));
    await engine.syncNow();
    await engine.syncNow();
  });
}

async function join(mac, engine, before = () => {}) {
  await mac.with(async () => {
    before();
    engine.startSync();
    assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", asSecret("syncPhrase", "words"))));
    await engine.syncNow();
    await engine.syncNow();
  });
}

const liveDevice = (id) => {
  const last = published(`dev:${id}`).at(-1);
  return !!last && last.v !== null;
};
const deviceNames = (engine) => engine.useSync.getState().devices.map((d) => `${d.id}${d.current ? " (this)" : ""}`);

test("a device that's gone can be removed from sync: it leaves the list on every Mac, and a Mac joining later never sees it (#1648)", async () => {
  folder.clear();
  const a = new Mac("A");
  const old = new Mac("Old");
  const c = new Mac("C");
  const engineA = await import("./engine.ts?devA");
  const engineOld = await import("./engine.ts?devOld");
  const engineC = await import("./engine.ts?devC");
  await turnOn(a, engineA);
  await join(old, engineOld);
  const oldId = await old.with(() => engineOld.useSync.getState().devices.find((d) => d.current).id);
  await a.with(async () => {
    await engineA.syncNow();
    assert.ok(deviceNames(engineA).includes(oldId), "the old device is listed");
    assert.equal(engineA.removeSyncedDevice(engineA.useSync.getState().devices.find((d) => d.current).id), false, "this device can't remove itself");
    assert.equal(engineA.removeSyncedDevice(oldId), true);
    assert.ok(!deviceNames(engineA).includes(oldId), "it leaves the list at once");
    await engineA.syncNow();
    await engineA.syncNow();
    assert.ok(!deviceNames(engineA).includes(oldId), "and stays gone after syncing");
    assert.equal(engineA.removeSyncedDevice(oldId), false, "nothing left to remove");
  });
  assert.equal(liveDevice(oldId), false, "its device record is deleted");
  await join(c, engineC);
  await c.with(() => assert.ok(!deviceNames(engineC).includes(oldId), "a Mac that joins later isn't shown it"));
});

test("a removed device that still syncs comes back, and the Mac that removed it lists it again", async () => {
  folder.clear();
  const a = new Mac("A");
  const b = new Mac("B");
  const engineA = await import("./engine.ts?backA");
  const engineB = await import("./engine.ts?backB");
  await turnOn(a, engineA);
  await join(b, engineB);
  const bId = await b.with(() => engineB.useSync.getState().devices.find((d) => d.current).id);
  await a.with(async () => {
    await engineA.syncNow();
    assert.equal(engineA.removeSyncedDevice(bId), true);
    await engineA.syncNow();
    await engineA.syncNow();
  });
  assert.equal(liveDevice(bId), false);
  await b.with(async () => {
    await engineB.syncNow();
    await engineB.syncNow();
  });
  assert.equal(liveDevice(bId), true, "B publishes itself again");
  await a.with(async () => {
    await engineA.syncNow();
    await engineA.syncNow();
    assert.ok(deviceNames(engineA).includes(bId), "A lists B again and doesn't delete it a second time");
  });
  assert.equal(liveDevice(bId), true);
});

test("two Macs with the same name are told apart: only the other one can be removed, and its row says when it last synced and which Ardia and system it ran", async () => {
  folder.clear();
  const a = new Mac("A");
  const old = new Mac("Old");
  const engineA = await import("./engine.ts?nameA");
  const engineOld = await import("./engine.ts?nameOld");
  const { deviceDetail } = await import("./devices.ts");
  const { appInfo } = await import("../../test-native/shell.ts");
  appInfo.osVersion = "27.0";
  await turnOn(a, engineA);
  await join(old, engineOld);
  await a.with(async () => {
    await engineA.syncNow();
    const devices = engineA.useSync.getState().devices;
    assert.equal(devices.length, 2);
    assert.equal(new Set(devices.map((d) => d.name)).size, 1, "both are named alike");
    const [mine, other] = devices;
    assert.equal(mine.current, true, "this Mac comes first and is marked");
    assert.equal(engineA.removeSyncedDevice(mine.id), false, "this Mac can't remove itself");
    assert.ok(other.version && other.os, JSON.stringify(other));
    const at = other.lastSeen;
    assert.equal(typeof at, "number");
    assert.equal(deviceDetail(other, (t) => (t === at ? "3 weeks ago" : "?")), `last synced 3 weeks ago · Ardia ${other.version} · ${other.os}`);
    assert.equal(other.os, "macOS 27.0");
    assert.equal(deviceDetail({ lastSeen: null }, () => "?"), "hasn’t synced yet");
  });
});
