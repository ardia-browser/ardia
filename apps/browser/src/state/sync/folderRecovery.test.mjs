import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folders = new Map();
const OURS = "ours";
let ids = 0;
let iCloudAvailable = true;
let inICloud = true;
let writeFailsAfter = Infinity;
let createChainError = null;
let onCreateChain = null;
let afterChainStatus = null;
let writeFindsChainGone = false;

const chainOf = (folder) => folders.get(folder);
const scopeOf = (folder, chain, scope) => {
  const chains = folders.get(folder);
  if (!chains?.has(chain)) throw new Error(`no chain ${chain} in ${folder}`);
  const scopes = chains.get(chain);
  if (!scopes.has(scope)) scopes.set(scope, new Map());
  return scopes.get(scope);
};
const plant = (folder, chain) => {
  if (!folders.has(folder)) folders.set(folder, new Map());
  if (!folders.get(folder).has(chain)) folders.get(folder).set(chain, new Map());
};

const native = {
  newDeviceId: () => `dev${++ids}`,
  deviceName: () => "Test Mac",
  createPhrase: async () => true,
  unlock: async () => true,
  forget: async () => {},
  folderInfo: async (path) => ({
    path,
    defaultPath: "/Users/test/Library/Mobile Documents/com~apple~CloudDocs/Ardia Sync",
    iCloudAvailable,
    inICloud,
    exists: folders.has(path),
    writable: true,
    hasSyncData: (chainOf(path)?.size ?? 0) > 0,
  }),
  chooseFolder: async () => null,
  chainStatus: async (folder) => {
    const status = !folders.has(folder) ? "unavailable" : chainOf(folder).has(OURS) ? "ok" : "missing";
    afterChainStatus?.(folder);
    return status;
  },
  createChain: async (folder) => {
    onCreateChain?.(folder);
    if (createChainError) throw createChainError;
    if (chainOf(folder)?.has(OURS)) throw new Error("the chain already exists");
    plant(folder, OURS);
  },
  deleteChain: async (folder) => void chainOf(folder)?.delete(OURS),
  write: async (folder, scope, payload) => {
    if (writeFindsChainGone) throw Object.assign(new Error("This device's data is gone from the sync folder"), { code: "ERR_SYNC_CHAIN_MISSING" });
    if (writeFailsAfter-- <= 0) throw new Error("disk full");
    const id = `f${++ids}`;
    scopeOf(folder, OURS, scope).set(id, payload);
    return id;
  },
  read: async (folder, scope, known) => {
    if (!chainOf(folder)?.has(OURS)) throw new Error(`no chain in ${folder}`);
    const here = [...(chainOf(folder).get(OURS).get(scope) ?? [])];
    return { files: here.filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload })), pending: [], damaged: [], present: here.map(([id]) => id) };
  },
  remove: async (folder, scope, list) => list.forEach((id) => scopeOf(folder, OURS, scope).delete(id)),
  sealLocal: async (text) => `sealed:${text}`,
  openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
  readPasswords: async () => null,
};
globalThis.acTestNativeModules = { ArdiaSync: native };

const shell = await import("../../test-native/index.ts");
const heldDocSaves = { on: false, queue: [] };
globalThis.acTestNativeModules.ArdiaDocuments = {
  ...shell.shellNativeModules.ArdiaDocuments,
  documentSaved: (name) => (heldDocSaves.on ? new Promise((resolve) => heldDocSaves.queue.push(resolve)) : shell.shellNativeModules.ArdiaDocuments.documentSaved(name)),
};
const { useBrowser } = await import("../browser/store.ts");
const S = () => useBrowser.getState();
const SYNC_FOLDER = "/Users/test/Library/Mobile Documents/com~apple~CloudDocs/Ardia Sync";

const reset = () => {
  folders.clear();
  iCloudAvailable = true;
  inICloud = true;
  writeFailsAfter = Infinity;
  createChainError = null;
  onCreateChain = null;
  afterChainStatus = null;
  writeFindsChainGone = false;
  heldDocSaves.on = false;
  heldDocSaves.queue.length = 0;
  shell.docs.clear();
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
};

test("missing sync folder reports an actionable error instead of silent Offline, and status copy never says bare Offline", async () => {
  reset();
  const { syncStatusLine, unavailableFolderError } = await import("./folderRecovery.ts");
  assert.equal(syncStatusLine("offline", null, 0, () => "2 days ago"), "Sync folder unavailable");
  assert.equal(syncStatusLine("offline", 1000, 0, () => "2 days ago"), "Sync folder unavailable · last synced 2 days ago");
  assert.equal(syncStatusLine("offline", 1000, 2, () => "2 days ago"), "Sync folder unavailable · last synced 2 days ago · waiting for 2 files to download");
  assert.equal(syncStatusLine("updating", 1000, 0, () => "2 days ago", true), "First sync in progress");
  assert.equal(syncStatusLine("offline", 1000, 0, () => "2 days ago", true), "Sync folder unavailable · last synced 2 days ago");
  assert.match(unavailableFolderError({ inICloud: true, iCloudAvailable: false, exists: false }), /iCloud Drive is off/);
  assert.match(unavailableFolderError({ inICloud: true, iCloudAvailable: true, exists: false }), /sync folder is missing/i);
  assert.match(unavailableFolderError(null), /sync folder isn’t available/i);

  const engine = await import("./engine.ts?missing-error");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "updated");

  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "offline");
  assert.match(engine.useSync.getState().error ?? "", /sync folder is missing/i);

  iCloudAvailable = false;
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "offline");
  assert.match(engine.useSync.getState().error ?? "", /iCloud Drive is off/);
});

test("recreateSyncFolder restores the missing chain, uploads snapshots of prior data and offline edits, and survives a relaunch", async () => {
  reset();
  const { Clock, emptyScope, pull } = await import("@ardia/sync");
  const engine = await import("./engine.ts?recreate");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://before.example/", title: "Before" });
  await engine.syncNow();
  const saved = JSON.parse(shell.docs.get("sync.json"));
  const scope = `p:${saved.profiles.default.syncId}`;

  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "offline");

  S().addBookmark({ profileId: "default", url: "https://offline.example/", title: "Made Offline" });
  const result = await engine.recreateSyncFolder();
  assert.deepEqual(result, { ok: "recreated" });
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(engine.useSync.getState().error, null);
  assert.ok(folders.has(SYNC_FOLDER));

  const phoneTransport = {
    write: (s, payload) => native.write(SYNC_FOLDER, s, payload),
    read: (s, known) => native.read(SYNC_FOLDER, s, known),
    remove: (s, list) => native.remove(SYNC_FOLDER, s, list),
  };
  const phoneApp = emptyScope();
  await pull(phoneApp, phoneTransport, "app", new Clock("iphone"), Date.now());
  assert.ok(Object.keys(phoneApp.records).some((k) => k.startsWith("dev:")), "recreated app scope exposes this Mac to iPhone");
  assert.ok(Object.keys(phoneApp.records).some((k) => k.startsWith("prof:")), "recreated app scope exposes profiles to iPhone");

  const phoneProfile = emptyScope();
  await pull(phoneProfile, phoneTransport, scope, new Clock("iphone"), Date.now());
  const bookmarkTitles = Object.values(phoneProfile.records).map((r) => r.v?.t).filter(Boolean).sort();
  assert.deepEqual(bookmarkTitles, ["Before", "Made Offline"], "iPhone receives both pre-disappearance data and edits made while offline");

  const relaunched = await import("./engine.ts?recreate-relaunch");
  relaunched.startSync();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await relaunched.syncNow();
  assert.equal(relaunched.useSync.getState().status, "updated");
  assert.equal(relaunched.useSync.getState().error, null);
});

test("recreateSyncFolder handles iCloud off, already-reappeared folder, existing unchained folder, createChain failure, and partial reseed retry", async () => {
  reset();
  const { Clock, emptyScope, pull } = await import("@ardia/sync");
  const engine = await import("./engine.ts?edge-cases");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://kept.example/", title: "Kept" });
  await engine.syncNow();
  const saved = JSON.parse(shell.docs.get("sync.json"));
  const scope = `p:${saved.profiles.default.syncId}`;

  assert.deepEqual(await engine.recreateSyncFolder(), { ok: "existing" }, "existing healthy folder is not recreated");

  folders.delete(SYNC_FOLDER);
  await engine.syncNow();

  iCloudAvailable = false;
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "cloudDriveOff" });
  assert.equal(folders.has(SYNC_FOLDER), false);
  iCloudAvailable = true;

  plant(SYNC_FOLDER, "other-chain");
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "exists" });
  assert.ok(!chainOf(SYNC_FOLDER).has(OURS), "does not overwrite another chain or reset directory");
  folders.delete(SYNC_FOLDER);

  createChainError = new Error("Read-only file system");
  const failed = await engine.recreateSyncFolder();
  assert.equal(failed.error, "failed");
  assert.match(failed.message, /Read-only file system/);
  assert.equal(engine.useSync.getState().status, "offline");
  createChainError = null;

  writeFailsAfter = 1;
  const partial = await engine.recreateSyncFolder();
  const { folderRecreateMessage } = await import("./folderRecovery.ts");
  assert.equal(partial.error, "uploadFailed");
  assert.equal(folderRecreateMessage(partial, "iCloud Drive > Ardia Sync"), null);
  assert.match(partial.message, /disk full/);
  assert.equal(engine.useSync.getState().status, "stalled");
  assert.ok(JSON.parse(shell.docs.get("sync.json")).reseedScopes?.includes(scope), "unseeded scope stays queued for retry");
  assert.equal(engine.useSync.getState().reseeding, true, "pairing stays off while the new folder still lacks this device's data");

  writeFailsAfter = Infinity;
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(JSON.parse(shell.docs.get("sync.json")).reseedScopes, undefined, "reseed queue clears once complete");
  assert.equal(engine.useSync.getState().reseeding, false);

  const phoneTransport = {
    write: (s, payload) => native.write(SYNC_FOLDER, s, payload),
    read: (s, known) => native.read(SYNC_FOLDER, s, known),
    remove: (s, list) => native.remove(SYNC_FOLDER, s, list),
  };
  const phoneProfile = emptyScope();
  await pull(phoneProfile, phoneTransport, scope, new Clock("iphone"), Date.now());
  assert.ok(Object.values(phoneProfile.records).some((r) => r.v?.t === "Kept"), "retried reseed uploads the profile snapshot");
});

test("recreateSyncFolder works when folder disappeared before the first sync ever succeeded", async () => {
  reset();
  const { Clock, emptyScope, pull } = await import("@ardia/sync");
  const engine = await import("./engine.ts?never-synced");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://first.example/", title: "First" });

  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "offline");

  const result = await engine.recreateSyncFolder();
  assert.deepEqual(result, { ok: "recreated" });
  assert.equal(engine.useSync.getState().status, "updated");

  const saved = JSON.parse(shell.docs.get("sync.json"));
  const scope = `p:${saved.profiles.default.syncId}`;
  const phoneTransport = {
    write: (s, payload) => native.write(SYNC_FOLDER, s, payload),
    read: (s, known) => native.read(SYNC_FOLDER, s, known),
    remove: (s, list) => native.remove(SYNC_FOLDER, s, list),
  };
  const phoneProfile = emptyScope();
  await pull(phoneProfile, phoneTransport, scope, new Clock("iphone"), Date.now());
  assert.ok(Object.values(phoneProfile.records).some((r) => r.v?.t === "First"));
});

test("folder unavailability and recreation telemetry respects consent", async () => {
  reset();
  const telemetry = await import("../telemetry/client.ts");
  const engine = await import("./engine.ts?telemetry");
  telemetry.loadChoice();
  telemetry.setSharing(false, "settings");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  engine.takeSnapshotWrites();

  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  assert.deepEqual(
    {
      u: engine.takeSnapshotWrites().folderUnavailable,
    },
    { u: 0 },
    "counts nothing while sharing is off",
  );

  telemetry.setSharing(true, "settings");
  await engine.recreateSyncFolder();
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  await engine.syncNow();
  assert.deepEqual(await engine.recreateSyncFolder(), { ok: "recreated" });
  const taken = engine.takeSnapshotWrites();
  assert.equal(taken.folderUnavailable, 1, "counts each transition into unavailable once");
  assert.equal(taken.folderRecreated, 2);
  assert.equal(taken.folderRecreateFailed, 0);
  telemetry.setSharing(false, "settings");
});

test("recreateSyncFolder refuses concurrent calls and locked state", async () => {
  reset();
  const engine = await import("./engine.ts?concurrency");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();

  const [first, second] = await Promise.all([engine.recreateSyncFolder(), engine.recreateSyncFolder()]);
  assert.deepEqual(first, { ok: "recreated" });
  assert.deepEqual(second, { error: "busy" });

  engine.useSync.setState({ status: "locked" });
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "locked" });
});

test("recreateSyncFolder waits for the reseed queue to land on disk before creating the chain, and a failed create keeps an earlier queue", async () => {
  reset();
  const engine = await import("./engine.ts?quit-mid-create");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://kept.example/", title: "Kept" });
  await engine.syncNow();
  const scope = `p:${JSON.parse(shell.docs.get("sync.json")).profiles.default.syncId}`;
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();

  let queuedWhenCreated = null;
  onCreateChain = () => (queuedWhenCreated = JSON.parse(shell.docs.get("sync.json")).reseedScopes ?? null);
  heldDocSaves.on = true;
  const recreating = engine.recreateSyncFolder();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(folders.has(SYNC_FOLDER), false, "the chain waits until sync.json's staged write has landed");
  heldDocSaves.on = false;
  heldDocSaves.queue.splice(0).forEach((landed) => landed());
  assert.deepEqual(await recreating, { ok: "recreated" });
  assert.ok(queuedWhenCreated?.includes(scope), "the queue is on disk before the chain is created");

  onCreateChain = null;
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  writeFailsAfter = 0;
  assert.equal((await engine.recreateSyncFolder()).error, "uploadFailed");
  const owed = JSON.parse(shell.docs.get("sync.json")).reseedScopes;
  assert.ok(owed?.length, "a partial upload leaves scopes owed");
  writeFailsAfter = Infinity;

  folders.delete(SYNC_FOLDER);
  createChainError = new Error("Read-only file system");
  assert.equal((await engine.recreateSyncFolder()).error, "failed");
  assert.deepEqual(JSON.parse(shell.docs.get("sync.json")).reseedScopes, owed, "a failed create keeps what an earlier attempt still owes");
});

test("recreateSyncFolder refuses a folder that reappears after the status check", async () => {
  reset();
  const engine = await import("./engine.ts?reappears");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();

  afterChainStatus = (folder) => plant(folder, "other-chain");
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "exists" });
  assert.ok(!chainOf(SYNC_FOLDER).has(OURS), "nothing is written next to the chain that arrived");
});

test("recreateSyncFolder checks again after waiting for the save, and leaves a folder that came back meanwhile alone", async () => {
  reset();
  const engine = await import("./engine.ts?returns-during-save");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://kept.example/", title: "Kept" });
  await engine.syncNow();
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();

  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  heldDocSaves.on = true;
  let answered = false;
  const answer = engine.recreateSyncFolder().then((result) => ((answered = true), result));
  await settle();
  plant(SYNC_FOLDER, "other-chain");
  heldDocSaves.queue.splice(0).forEach((landed) => landed());
  await settle();
  assert.equal(answered, false, "the answer waits until the put-back queue has landed");
  assert.equal(heldDocSaves.queue.length, 1);
  heldDocSaves.on = false;
  heldDocSaves.queue.splice(0).forEach((landed) => landed());
  assert.deepEqual(await answer, { error: "exists" });
  assert.ok(!chainOf(SYNC_FOLDER).has(OURS), "nothing is created next to the chain that came back");
  assert.equal(JSON.parse(shell.docs.get("sync.json")).reseedScopes, undefined, "nothing is left owed to a folder that wasn't created");
});

test("recreateSyncFolder creates nothing once the app is quitting, and puts the earlier queue back", async () => {
  reset();
  const { setQuitting } = await import("../app/quit.ts");
  const engine = await import("./engine.ts?quitting");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://kept.example/", title: "Kept" });
  await engine.syncNow();
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();

  heldDocSaves.on = true;
  const answer = engine.recreateSyncFolder();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  setQuitting(true);
  heldDocSaves.on = false;
  heldDocSaves.queue.splice(0).forEach((landed) => landed());
  try {
    assert.deepEqual(await answer, { error: "busy" });
    assert.equal(folders.has(SYNC_FOLDER), false, "no chain is created while quitting");
    assert.equal(JSON.parse(shell.docs.get("sync.json")).reseedScopes, undefined);
  } finally {
    setQuitting(false);
  }
});

test("a folder that is there but lost this device's data waits without offering Recreate, and pairing stays off until the data is back", async () => {
  reset();
  const engine = await import("./engine.ts?data-missing");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://kept.example/", title: "Kept" });
  await engine.syncNow();
  assert.equal(engine.useSync.getState().dataMissing, false);

  const chain = chainOf(SYNC_FOLDER).get(OURS);
  chainOf(SYNC_FOLDER).delete(OURS);
  await engine.syncNow();
  const waiting = engine.useSync.getState();
  assert.equal(waiting.status, "stalled", "the folder is there, so this is not the folder-unavailable state that offers Recreate");
  assert.equal(waiting.enabled, true, "sync keeps its setup while it waits");
  assert.equal(waiting.dataMissing, true, "pairing is gated while the folder has none of this device's data");
  engine.setTypeSynced("history", false);
  assert.equal(engine.useSync.getState().dataMissing, true, "a settings change while the data is missing keeps pairing off");
  engine.setTypeSynced("history", true);
  assert.equal(engine.useSync.getState().dataMissing, true);
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "exists" }, "recreate never makes a chain in a folder that is there");
  assert.equal(chainOf(SYNC_FOLDER).has(OURS), false);

  chainOf(SYNC_FOLDER).set(OURS, chain);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(engine.useSync.getState().dataMissing, false);
});

test("a retry that sees the chain but finds it gone on write counts no return; a return counts once a cycle completes", async () => {
  reset();
  const telemetry = await import("../telemetry/client.ts");
  const engine = await import("./engine.ts?chain-counts");
  telemetry.loadChoice();
  telemetry.setSharing(true, "settings");
  try {
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
    await engine.syncNow();
    engine.takeSnapshotWrites();

    const chain = chainOf(SYNC_FOLDER).get(OURS);
    chainOf(SYNC_FOLDER).delete(OURS);
    await engine.syncNow();
    chainOf(SYNC_FOLDER).set(OURS, chain);
    writeFindsChainGone = true;
    for (const title of ["One", "Two"]) {
      S().addBookmark({ profileId: "default", url: `https://${title.toLowerCase()}.example/`, title });
      await engine.syncNow();
      assert.equal(engine.useSync.getState().dataMissing, true);
    }
    const retried = engine.takeSnapshotWrites();
    assert.deepEqual({ missing: retried.chainMissing, returned: retried.chainReturned }, { missing: 1, returned: 0 }, "one missing stretch, no return while every write still finds the chain gone");

    writeFindsChainGone = false;
    await engine.syncNow();
    assert.equal(engine.useSync.getState().status, "updated");
    const back = engine.takeSnapshotWrites();
    assert.deepEqual({ missing: back.chainMissing, returned: back.chainReturned }, { missing: 0, returned: 1 });
  } finally {
    telemetry.setSharing(false, "settings");
  }
});
