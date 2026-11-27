import { asSecret } from "@ardia/core";
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
const downloading = new Set();
const failing = { writes: 0, stateSeals: false, onWrite: null, onRead: null };
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
      failing.onWrite?.(payload);
      if (failing.writes > 0 && failing.writes--) throw new Error("The sync folder went away mid-write");
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      failing.onRead?.(scope);
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const unknown = here.map(([id]) => id).filter((id) => !known.includes(id));
      const files = here.filter(([id]) => unknown.includes(id) && !downloading.has(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: unknown.filter((id) => downloading.has(id)), damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => {
      if (failing.stateSeals && text.startsWith('{"covers":')) throw new Error("disk full");
      return `sealed:${text}`;
    },
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const S = () => useBrowser.getState();

class Mac {
  constructor() {
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

const ops = () =>
  [...folder.values()]
    .map((f) => JSON.parse(f.payload))
    .flatMap((f) => f.ops ?? Object.entries(f.records ?? {}).map(([k, r]) => ({ k, v: r.v })));
const published = (prefix) => ops().filter((op) => op.k.startsWith(prefix));
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const named = (name) => S().profileOrder.find((id) => S().profiles[id].name === name);
const syncIdOf = (engine, name) => engine.useSync.getState().profiles[named(name)]?.syncId;
const syncDoc = () => JSON.parse(shell.docs.get("sync.json"));

async function turnOn(mac, engine) {
  await mac.with(async () => {
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync("/sync")));
    await engine.syncNow();
    await engine.syncNow();
  });
}

async function join(mac, engine) {
  await mac.with(async () => {
    engine.startSync();
    assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", asSecret("syncPhrase", "words"))));
    await engine.syncNow();
    await engine.syncNow();
  });
}

async function relaunch(mac, tag, browser = mac.browser) {
  mac.browser = browser;
  const engine = await import(`./engine.ts?${tag}`);
  await mac.with(async () => {
    engine.startSync();
    await settle();
    await engine.syncNow();
  });
  return engine;
}

function pin(urls, profileId = "default") {
  const w = Object.values(S().windows).find((win) => win.profileId === profileId)?.id ?? S().createWindow({ profileId });
  const tabs = urls.map((url) => S().newTab(w, { url, background: true, profileId }));
  S().pinTabs(tabs, true);
  return tabs;
}

const pinnedUrls = (profileId = "default") =>
  [...Object.values(S().tabs).filter((t) => t.profileId === profileId && t.pin), ...(S().parkedPins[profileId]?.tabs ?? [])].map((t) => t.url).sort();

const withoutProfile = (mac, id, extra = {}) =>
  mac.with(() => {
    const { [id]: _gone, ...profiles } = S().profiles;
    S().hydrate({ profiles, profileOrder: S().profileOrder.filter((p) => p !== id), syncMark: S().syncMark, ...extra });
    useBrowser.setState({ bookmarksReady: { "": true } });
    return S();
  });

const tombstones = () => published("pin:t:").filter((op) => op.v === null).length;

test("#1577: a checkpoint that started before a profile was added back can't clear the rebase that profile owes", async () => {
  folder.clear();
  downloading.clear();
  const quit = await import("../app/quit.ts");
  const a = new Mac();
  const engine = await import("./engine.ts?obligationA1");
  let work;
  await a.with(() => {
    work = S().createProfile({ name: "Work" });
  });
  await turnOn(a, engine);
  await a.with(async () => {
    pin(["https://one.example/"], work);
    await engine.syncNow();
    await engine.syncNow();
  });
  const workSyncId = await a.with(() => syncIdOf(engine, "Work"));
  const scope = `p:${workSyncId}`;
  await a.with(async () => {
    const { [work]: _gone, ...profiles } = S().profiles;
    S().hydrate({ profiles, profileOrder: S().profileOrder.filter((id) => id !== work), syncMark: S().syncMark });
    useBrowser.setState({ bookmarksReady: { "": true } });
    shell.heldSaves.on = true;
    const saving = quit.finishQuitSaves(5_000);
    await settle();
    assert.ok(shell.heldSaves.queue.length > 0, "the checkpoint is being written");
    assert.equal(engine.addRemoteProfile(workSyncId), work);
    shell.heldSaves.on = false;
    for (const land of shell.heldSaves.queue.splice(0)) land();
    await saving;
    await settle();
    engine.setTypeSynced("history", true);
    assert.ok(JSON.parse(shell.docs.get("sync.json")).rebaseScopes?.[scope], "the older checkpoint leaves the new profile's rebase owed");
  });
  const before = tombstones();
  const restarted = await import("./engine.ts?obligationA2");
  await a.with(async () => {
    S().createWindow({ profileId: work });
    restarted.startSync();
    await settle();
    await restarted.syncNow();
    await restarted.syncNow();
    assert.deepEqual(pinnedUrls(work), ["https://one.example/"], "the restart rebases the profile and brings its pin back");
  });
  assert.equal(tombstones(), before, "and deletes nothing");
});
