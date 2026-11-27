import { asSecret } from "@ardia/core";
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
const downloading = new Set();
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
      const files = here.filter(([id]) => unknown.includes(id) && !downloading.has(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: unknown.filter((id) => downloading.has(id)), damaged: [], present: here.map(([id]) => id) };
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

test("#1577: a setting changed here and not sent before a crash survives the rebase that follows, and still reaches the other Mac", async () => {
  folder.clear();
  downloading.clear();
  const { SYNCED_SETTINGS } = await import("./settingsAdapter.ts");
  const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
  const name = "pageFrame";
  assert.ok(SYNCED_SETTINGS.includes(name));
  const synced = DEFAULT_SETTINGS[name] + 1;
  const editedHere = DEFAULT_SETTINGS[name] + 2;
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?settingA1");
  await turnOn(a, engineA1);
  await a.with(async () => {
    S().updateSettings({ [name]: synced });
    await engineA1.syncNow();
    await engineA1.syncNow();
    S().updateSettings({ [name]: editedHere });
  });
  assert.ok(a.browser.settingsMeta.chosenAt?.[name], "the session keeps when the choice was made, with the value");
  const crashed = { ...a.browser, syncMark: "a mark sync.json never saw" };
  const engineA2 = await relaunch(a, "settingA2", crashed);
  await a.with(async () => {
    await engineA2.syncNow();
    assert.equal(S().settings[name], editedHere, "the edit made here before the crash is kept through the rebase");
  });
  const engineB = await import("./engine.ts?settingB");
  await join(b, engineB);
  await b.with(async () => {
    await engineB.syncNow();
    assert.equal(S().settings[name], editedHere, "the other Mac gets it");
  });
});

test("#1577: a rebase still takes a setting changed on another Mac when nothing changed it here", async () => {
  folder.clear();
  downloading.clear();
  const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
  const name = "pageFrame";
  const older = DEFAULT_SETTINGS[name] + 1;
  const newer = DEFAULT_SETTINGS[name] + 3;
  const a = new Mac();
  const b = new Mac();
  const engineA1 = await import("./engine.ts?remoteA1");
  await turnOn(a, engineA1);
  await a.with(async () => {
    S().updateSettings({ [name]: older });
    await engineA1.syncNow();
    await engineA1.syncNow();
  });
  const stale = { ...a.browser };
  const engineB = await import("./engine.ts?remoteB");
  await join(b, engineB);
  await b.with(async () => {
    await engineB.syncNow();
    S().updateSettings({ [name]: newer });
    await engineB.syncNow();
  });
  const engineA2 = await relaunch(a, "remoteA2", { ...stale, syncMark: "a mark sync.json never saw" });
  await a.with(async () => {
    await engineA2.syncNow();
    assert.equal(S().settings[name], newer, "the newer setting from the other Mac wins over the restored session's");
  });
});

test("a setting chosen after the synced record was written is kept by a rebase, one chosen before it isn't", async () => {
  const { withSettingEdits } = await import("./settingEdits.ts");
  const { Clock } = await import("@ardia/sync");
  S().hydrate({});
  const records = {};
  const extract = () =>
    withSettingEdits({ prefix: "set:", extract: async () => ({ values: new Map([["set:pageFrame", { v: 10 }]]) }), apply: () => true }).extract(
      () => undefined,
      () => false,
      0,
      (key) => key in records,
      (key) => records[key]?.v,
      (key) => records[key]?.h,
      () => undefined,
    );
  const writtenAt = (ms) => new Clock("other", null, () => ms).tick();
  useBrowser.setState({ settingsMeta: { chosen: ["pageFrame"], inferred: [], chosenAt: { pageFrame: 2_000_000 } } });
  records["set:pageFrame"] = { v: { v: 11 }, h: writtenAt(1_000_000) };
  assert.equal((await extract()).keepLocal("set:pageFrame"), true, "the choice here is newer than the record");
  records["set:pageFrame"] = { v: { v: 11 }, h: writtenAt(3_000_000) };
  assert.equal((await extract()).keepLocal("set:pageFrame"), false, "the record is newer than the choice");
  useBrowser.setState({ settingsMeta: { chosen: [], inferred: [] } });
  assert.equal((await extract()).keepLocal("set:pageFrame"), false, "nothing chosen here, nothing kept");
});
