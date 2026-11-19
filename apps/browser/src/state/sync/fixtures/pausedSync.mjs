import assert from "node:assert/strict";

export const stub = { timers: [], unlockAnswer: true, chainFails: false, chainAnswer: "ok", duringRead: null, hold: { unlock: false, read: false } };
let nextTimer = 0;
globalThis.setTimeout = (fn, ms) => {
  const id = ++nextTimer;
  stub.timers.push({ fn, ms, id });
  return id;
};
globalThis.clearTimeout = (id) => void (stub.timers = stub.timers.filter((timer) => timer.id !== id));
globalThis.__DEV__ = false;

export const folder = new Map();
export const calls = { unlock: 0, openLocal: 0, chainStatus: 0, read: 0, enterPhrase: 0, forget: 0, deleteChain: 0, write: 0, chooseFolder: 0 };
const native = {
  newDeviceId: () => "devP",
  deviceName: () => "Test PC",
  createPhrase: async () => true,
  createChain: async () => {},
  unlock: async () => {
    calls.unlock++;
    if (stub.hold.unlock) await new Promise(() => {});
    return stub.unlockAnswer;
  },
  forget: async () => void calls.forget++,
  deleteChain: async () => {
    calls.deleteChain++;
    folder.clear();
  },
  chainStatus: async () => {
    calls.chainStatus++;
    if (stub.chainFails) throw new Error("The sync folder went away");
    return stub.chainAnswer;
  },
  write: async (_folder, scope, payload) => {
    calls.write++;
    const id = `f${folder.size + 1}-${calls.write}`;
    folder.set(id, { scope, payload });
    return id;
  },
  read: async (_folder, scope, known) => {
    calls.read++;
    stub.duringRead?.(scope);
    if (stub.hold.read) await new Promise(() => {});
    const here = [...folder].filter(([, f]) => f.scope === scope);
    const files = here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
    return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
  },
  remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
  sealLocal: async (text) => `sealed:${text}`,
  openLocal: async (sealed) => {
    calls.openLocal++;
    return sealed.startsWith("sealed:") ? sealed.slice(7) : null;
  },
  readPasswords: async () => null,
  chooseFolder: async () => {
    calls.chooseFolder++;
    return "/elsewhere";
  },
  enterPhrase: async () => {
    calls.enterPhrase++;
    stub.unlockAnswer = true;
    return { ok: true };
  },
};
const stock = { ...native };
globalThis.acTestNativeModules = { ArdiaSync: native };
export const syncNative = native;
export const restoreNative = () => Object.assign(native, stock);

export const shell = await import("../../../test-native/index.ts");
const { reloadLaunchConfigForTests } = await import("../../../platform/launchConfig.ts");
const consent = await import("../../telemetry/consentPeriod.ts");
const pauseCounts = await import("../../telemetry/syncPauseCounts.ts");
const store = await import("../../browser/store.ts");
export const quit = await import("../../app/quit.ts");
export const { useBrowser } = store;
export const S = () => useBrowser.getState();
export const { setConsentPeriod } = consent;
export const { takeSyncPauseCounts } = pauseCounts;

setConsentPeriod(true, "sync-pause-test");

export const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
export const docOnDisk = () => JSON.parse(shell.docs.get("sync.json"));
export const syncFileNames = () => [...shell.docs.keys()].filter((name) => name.startsWith("sync-")).sort();
export const journalParts = () => syncFileNames().filter((name) => /^sync-journal-\d+\.nns$/.test(name));
export const sealedFiles = () => Object.fromEntries(syncFileNames().map((name) => [name, shell.docs.get(name)]));
export const remoteFolder = () => JSON.stringify([...folder].sort(([a], [b]) => a.localeCompare(b)));

export const reads = [];
export const writes = [];
shell.docs.get = function (name) {
  reads.push(name);
  return Map.prototype.get.call(this, name);
};
shell.docs.set = function (name, contents) {
  writes.push(name);
  return Map.prototype.set.call(this, name, contents);
};

export function recovered(on) {
  shell.launch.recoveredStart = on;
  reloadLaunchConfigForTests();
}

export function quiet() {
  for (const key in calls) calls[key] = 0;
  restoreNative();
  stub.hold.unlock = stub.hold.read = false;
  stub.unlockAnswer = true;
  stub.chainFails = false;
  stub.chainAnswer = "ok";
  stub.duringRead = null;
  stub.timers = [];
  shell.refusedWrites.on = false;
  shell.refusedWrites.returnsFalse = false;
  quit.setQuitting(false);
  reads.length = 0;
  writes.length = 0;
  takeSyncPauseCounts();
}

let instances = 0;
export const engineInstance = () => import(`../engine.ts?pause${++instances}`);

export async function syncedProfile({ build } = {}) {
  quiet();
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  shell.docs.clear();
  folder.clear();
  recovered(false);
  const first = await engineInstance();
  first.startSync();
  assert.ok("ok" in (await first.turnOnSync("/sync")));
  S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
  await first.syncNow();
  await build?.(first);
  await quit.finishQuitSaves(5_000);
  S().addBookmark({ profileId: "default", url: "https://two.example/", title: "Two" });
  await first.syncNow();
  await settle();
  const disk = new Map(shell.docs);
  const shared = new Map(folder);
  const seqs = docOnDisk().seqs;
  assert.ok(Object.values(seqs).some((seq) => seq > 0), "the profile has written batches, so sync.json carries seqs");
  assert.ok(shell.docs.get("sync-state.nns"), "and a sealed state");
  assert.ok(journalParts().length > 0, "and journal parts");
  await first.stopSync();
  folder.clear();
  for (const [id, file] of shared) folder.set(id, file);
  return { disk, seqs };
}

export function restore(disk) {
  shell.docs.clear();
  for (const [name, contents] of disk) Map.prototype.set.call(shell.docs, name, contents);
}

export const retire = (engine) => engine.stopSync();

export async function pausedStart(disk, { recoveredStart = true, keyMissing = false, before, startOptions } = {}) {
  restore(disk);
  recovered(recoveredStart);
  quiet();
  stub.unlockAnswer = !keyMissing;
  before?.();
  const engine = await engineInstance();
  engine.startSync(startOptions);
  await settle();
  return engine;
}

export async function timersRun() {
  const due = stub.timers;
  stub.timers = [];
  for (const { fn } of due) fn();
  await settle();
}
