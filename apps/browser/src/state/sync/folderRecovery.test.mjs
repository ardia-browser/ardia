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
let beforeWrite = null;
let beforeRead = null;
let onFolderInfo = null;
let desktopWriteErrors = false;
let beforeChainStatus = null;

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
  folderInfo: async (path) => (onFolderInfo?.(path), {
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
    beforeChainStatus?.(folder);
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
  createChainInNewFolder: async (folder) => {
    onCreateChain?.(folder);
    if (createChainError) throw createChainError;
    if (folders.has(folder)) throw Object.assign(new Error("A folder is already there"), { code: "ERR_SYNC_FOLDER_EXISTS" });
    plant(folder, OURS);
  },
  deleteChain: async (folder) => void chainOf(folder)?.delete(OURS),
  write: async (folder, scope, payload) => {
    beforeWrite?.(folder);
    if (desktopWriteErrors && !folders.has(folder)) throw Object.assign(new Error(`Couldn't write to ${folder}: No such file or directory`), { code: "ERR_SYNC_FOLDER" });
    if (writeFindsChainGone || !chainOf(folder)?.has(OURS)) throw Object.assign(new Error("This device's data is gone from the sync folder"), { code: "ERR_SYNC_CHAIN_MISSING" });
    if (writeFailsAfter-- <= 0) throw new Error("disk full");
    const id = `f${++ids}`;
    scopeOf(folder, OURS, scope).set(id, payload);
    return id;
  },
  read: async (folder, scope, known) => {
    beforeRead?.(folder, scope, known);
    if (!chainOf(folder)?.has(OURS)) return { files: [], pending: [], damaged: [], present: [] };
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
  beforeWrite = null;
  beforeRead = null;
  onFolderInfo = null;
  desktopWriteErrors = false;
  beforeChainStatus = null;
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
  assert.equal(
    folderRecreateMessage({ error: "failed", message: "You don’t have permission to save the file “x” in the folder “Ardia Sync”." }, "~/Sync"),
    "Couldn’t recreate the sync folder at ~/Sync: You don’t have permission to save the file “x” in the folder “Ardia Sync”.",
  );
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

const brokenFolder = async (name) => {
  const engine = await import(`./engine.ts?${name}`);
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://kept.example/", title: "Kept" });
  await engine.syncNow();
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "offline");
  return engine;
};

test("pairing stays off after a recreation until a cycle has uploaded this device's data, also when nothing was saved to reseed", async () => {
  reset();
  const engine = await import("./engine.ts?first-upload-fails");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  S().addBookmark({ profileId: "default", url: "https://first.example/", title: "First" });
  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "offline");

  writeFailsAfter = 0;
  assert.deepEqual(await engine.recreateSyncFolder(), { ok: "recreated" });
  const failed = engine.useSync.getState();
  assert.equal(failed.status, "stalled");
  assert.equal(failed.reseeding, true, "the new folder holds none of this device's data yet, so pairing stays off");
  assert.equal(JSON.parse(shell.docs.get("sync.json")).reseedCycleOwed, true, "what is owed survives a relaunch");

  writeFailsAfter = Infinity;
  await engine.syncNow();
  const done = engine.useSync.getState();
  assert.equal(done.status, "updated");
  assert.equal(done.reseeding, false);
  assert.equal(JSON.parse(shell.docs.get("sync.json")).reseedCycleOwed, undefined);
  assert.ok([...chainOf(SYNC_FOLDER).get(OURS).values()].some((files) => files.size > 0), "the first upload landed");
});

test("a folder that comes back after the last check is never written into: the native create refuses it", async () => {
  reset();
  const engine = await brokenFolder("returns-at-create");
  onCreateChain = (folder) => plant(folder, "other-chain");
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "exists" });
  assert.equal(chainOf(SYNC_FOLDER).has(OURS), false, "no chain of this phrase next to the one that came back");
  assert.equal(JSON.parse(shell.docs.get("sync.json")).reseedScopes, undefined, "nothing is owed to a folder that wasn't created");
});

test("a whole folder removed right before a write shows the folder as unavailable, with Recreate, not the waiting state", async () => {
  reset();
  const engine = await import("./engine.ts?folder-gone-at-write");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  S().addBookmark({ profileId: "default", url: "https://late.example/", title: "Late" });
  beforeWrite = (folder) => {
    beforeWrite = null;
    folders.delete(folder);
  };
  await engine.syncNow();
  const state = engine.useSync.getState();
  assert.equal(state.status, "offline");
  assert.equal(state.dataMissing, false);
  assert.match(state.error ?? "", /sync folder is missing/i);
});

test("a chain removed during a cycle that writes nothing waits for its data instead of reporting Updated", async () => {
  reset();
  const engine = await import("./engine.ts?chain-gone-at-read");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  await engine.syncNow();
  let writes = 0;
  beforeWrite = () => writes++;
  let chain = null;
  beforeRead = (folder) => {
    beforeRead = null;
    chain = chainOf(folder).get(OURS);
    chainOf(folder).delete(OURS);
  };
  await engine.syncNow();
  assert.equal(writes, 0, "the cycle had nothing to write");
  const waiting = engine.useSync.getState();
  assert.equal(waiting.status, "stalled");
  assert.equal(waiting.dataMissing, true, "pairing stays off while the chain is gone");

  chainOf(SYNC_FOLDER).set(OURS, chain);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(engine.useSync.getState().dataMissing, false);
});

test("a quit that starts during the last folder check creates nothing", async () => {
  reset();
  const { setQuitting } = await import("../app/quit.ts");
  const engine = await brokenFolder("quit-at-last-probe");
  let probes = 0;
  onFolderInfo = () => {
    if (++probes === 2) setQuitting(true);
  };
  try {
    assert.deepEqual(await engine.recreateSyncFolder(), { error: "busy" });
    assert.equal(probes, 2);
    assert.equal(folders.has(SYNC_FOLDER), false, "no folder or chain is created once quitting");
    assert.equal(JSON.parse(shell.docs.get("sync.json")).reseedScopes, undefined);
  } finally {
    setQuitting(false);
  }
});

test("pairing stays off until the writes queued while the folder was gone have landed, not just the snapshots", async () => {
  reset();
  const { Clock, emptyScope, pull } = await import("@ardia/sync");
  const engine = await brokenFolder("pending-write-fails");
  const scope = `p:${JSON.parse(shell.docs.get("sync.json")).profiles.default.syncId}`;
  S().addBookmark({ profileId: "default", url: "https://offline.example/", title: "Made Offline" });
  let writes = 0;
  beforeWrite = () => {
    if (++writes > 2) throw new Error("disk full");
  };
  assert.deepEqual(await engine.recreateSyncFolder(), { ok: "recreated" });
  assert.ok(writes > 2, "both snapshots landed and a later write failed");
  const failed = engine.useSync.getState();
  assert.equal(failed.status, "stalled");
  assert.equal(failed.reseeding, true, "pairing stays off while a queued write is still owed");

  beforeWrite = null;
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(engine.useSync.getState().reseeding, false);
  const phone = emptyScope();
  await pull(phone, { write: () => {}, read: (s, known) => native.read(SYNC_FOLDER, s, known), remove: () => {} }, scope, new Clock("iphone"), Date.now());
  assert.ok(Object.values(phone.records).some((r) => r.v?.t === "Made Offline"), "the offline edit reached the new folder before pairing opened");
});

test("Recreate never takes over a folder that is there, empty or not, whether it was there at the status check or appeared after it", async () => {
  reset();
  const engine = await brokenFolder("vacant-folder");
  folders.set(SYNC_FOLDER, new Map());
  await engine.syncNow();
  assert.equal(engine.useSync.getState().dataMissing, true, "an empty folder that is there is the waiting state: its files may still be downloading");
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "exists" });
  assert.equal(chainOf(SYNC_FOLDER).size, 0);

  folders.delete(SYNC_FOLDER);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "offline");
  afterChainStatus = (folder) => {
    afterChainStatus = null;
    folders.set(folder, new Map());
  };
  assert.deepEqual(await engine.recreateSyncFolder(), { error: "exists" }, "an empty folder that appears while Recreate runs is left alone too");
  assert.equal(chainOf(SYNC_FOLDER).size, 0);
});

test("a chain removed before the read of a scope with no known files waits for its data instead of reporting Updated, and an empty read with a healthy chain still passes", async () => {
  reset();
  const engine = await import("./engine.ts?chain-gone-before-empty-scope");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  await engine.syncNow();
  for (const type of ["bookmarks", "history", "tabs", "pinned", "passwords", "extensions", "settings"]) engine.setTypeSynced(type, false);
  let emptyScopeRead = false;
  beforeRead = (folder, scope, known) => {
    if (!known.length) emptyScopeRead = true;
  };
  S().createProfile({ name: "Work" });
  await engine.syncNow();
  assert.ok(emptyScopeRead, "a scope with no known files is read in each cycle");
  assert.equal(engine.useSync.getState().status, "updated", "an empty scope with its chain there is a normal cycle");

  let chain = null;
  S().createProfile({ name: "Home" });
  beforeRead = (folder, scope, known) => {
    if (known.length) return;
    beforeRead = null;
    chain = chainOf(folder).get(OURS);
    chainOf(folder).delete(OURS);
  };
  await engine.syncNow();
  assert.ok(chain, "the chain went before that scope's read");
  const waiting = engine.useSync.getState();
  assert.equal(waiting.status, "stalled");
  assert.equal(waiting.dataMissing, true);
  chainOf(SYNC_FOLDER).set(OURS, chain);
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "updated");
});

test("a Linux or Windows write that fails because the whole folder went shows the folder as unavailable, with Recreate", async () => {
  reset();
  desktopWriteErrors = true;
  const engine = await import("./engine.ts?desktop-folder-gone-at-write");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  S().addBookmark({ profileId: "default", url: "https://late.example/", title: "Late" });
  beforeWrite = (folder) => {
    beforeWrite = null;
    folders.delete(folder);
  };
  await engine.syncNow();
  const state = engine.useSync.getState();
  assert.equal(state.status, "offline");
  assert.equal(state.dataMissing, false);
  assert.match(state.error ?? "", /sync folder is missing/i);
});

test("a folder that is back by the time a failed write is checked retries the cycle instead of reporting its data missing", async () => {
  reset();
  const telemetry = await import("../telemetry/client.ts");
  const engine = await import("./engine.ts?folder-back-at-recheck");
  telemetry.loadChoice();
  telemetry.setSharing(true, "settings");
  try {
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
    await engine.syncNow();
    engine.takeSnapshotWrites();
    S().addBookmark({ profileId: "default", url: "https://blip.example/", title: "Blip" });
    let held = null;
    beforeWrite = (folder) => {
      beforeWrite = null;
      held = chainOf(folder);
      folders.delete(folder);
      beforeChainStatus = (back) => {
        beforeChainStatus = null;
        folders.set(back, held);
      };
    };
    await engine.syncNow();
    assert.ok(held, "the folder was gone at the write");
    const after = engine.useSync.getState();
    assert.equal(after.dataMissing, false, "a reconnect that is already over is not the waiting state");
    assert.notEqual(after.status, "stalled");
    assert.equal(engine.takeSnapshotWrites().chainMissing, 0, "no missing stretch is recorded");
    await engine.syncNow();
    assert.equal(engine.useSync.getState().status, "updated");
  } finally {
    telemetry.setSharing(false, "settings");
  }
});

for (const desktop of [false, true]) {
  test(`a folder lost during Recreate's first upload shows the folder as unavailable, not a generic stall (${desktop ? "Linux and Windows" : "Mac"} errors)`, async () => {
    reset();
    desktopWriteErrors = desktop;
    const engine = await brokenFolder(`lost-during-reseed-${desktop}`);
    beforeWrite = (folder) => {
      beforeWrite = null;
      folders.delete(folder);
    };
    assert.equal((await engine.recreateSyncFolder()).error, "uploadFailed");
    const state = engine.useSync.getState();
    assert.equal(state.status, "offline");
    assert.match(state.error ?? "", /sync folder is missing/i);
  });
}

test("a loss first seen while sharing was off is never counted after sharing turns on, even when its verdict waits a cycle", async () => {
  reset();
  const telemetry = await import("../telemetry/client.ts");
  const engine = await import("./engine.ts?loss-consent-carried");
  telemetry.loadChoice();
  telemetry.setSharing(false, "settings");
  try {
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
    await engine.syncNow();
    engine.takeSnapshotWrites();
    writeFindsChainGone = true;
    S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
    await engine.syncNow();
    assert.equal(engine.useSync.getState().dataMissing, false, "the first look defers its verdict");
    telemetry.setSharing(true, "settings");
    await engine.syncNow();
    assert.equal(engine.useSync.getState().dataMissing, true, "the second look reports the data missing");
    assert.equal(engine.takeSnapshotWrites().chainMissing, 0, "counted under the consent of the cycle that first saw it");
  } finally {
    writeFindsChainGone = false;
    telemetry.setSharing(false, "settings");
  }
});

test("a loss first seen while sharing was off is not counted when the next cycle's opening check finds the data gone after sharing turned on", async () => {
  reset();
  const telemetry = await import("../telemetry/client.ts");
  const engine = await import("./engine.ts?loss-consent-preflight");
  telemetry.loadChoice();
  telemetry.setSharing(false, "settings");
  try {
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
    await engine.syncNow();
    engine.takeSnapshotWrites();
    writeFindsChainGone = true;
    S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
    await engine.syncNow();
    assert.equal(engine.useSync.getState().dataMissing, false, "the first look defers its verdict");
    writeFindsChainGone = false;
    chainOf(SYNC_FOLDER).delete(OURS);
    telemetry.setSharing(true, "settings");
    await engine.syncNow();
    assert.equal(engine.useSync.getState().dataMissing, true, "the opening check reports the data missing");
    assert.equal(engine.takeSnapshotWrites().chainMissing, 0, "a loss first seen with sharing off is never counted");
  } finally {
    writeFindsChainGone = false;
    telemetry.setSharing(false, "settings");
  }
});

const outageEngine = async (name, sharing) => {
  const telemetry = await import("../telemetry/client.ts");
  telemetry.loadChoice();
  telemetry.setSharing(sharing, "settings");
  const engine = await import(`./engine.ts?${name}`);
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync(SYNC_FOLDER)));
  await engine.syncNow();
  engine.takeSnapshotWrites();
  return { telemetry, engine };
};

test("an outage first seen with sharing off is never counted, however long it lasts after sharing turns on", async () => {
  reset();
  const { telemetry, engine } = await outageEngine("outage-off-at-first-sight", false);
  try {
    chainOf(SYNC_FOLDER).delete(OURS);
    await engine.syncNow();
    telemetry.setSharing(true, "settings");
    for (let i = 0; i < 3; i++) await engine.syncNow();
    assert.equal(engine.useSync.getState().dataMissing, true);
    assert.equal(engine.takeSnapshotWrites().chainMissing, 0);
  } finally {
    telemetry.setSharing(false, "settings");
  }
});

test("an outage first seen in one consent period is never counted in a later one, however many cycles it lasts", async () => {
  reset();
  const { telemetry, engine } = await outageEngine("outage-period-changes", true);
  try {
    writeFindsChainGone = true;
    S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
    await engine.syncNow();
    telemetry.setSharing(false, "settings");
    telemetry.setSharing(true, "settings");
    for (let i = 0; i < 4; i++) await engine.syncNow();
    assert.equal(engine.useSync.getState().dataMissing, true);
    assert.equal(engine.takeSnapshotWrites().chainMissing, 0);
  } finally {
    writeFindsChainGone = false;
    telemetry.setSharing(false, "settings");
  }
});

test("a relaunch before the verdict keeps the consent the outage was first seen under", async () => {
  reset();
  const { telemetry } = await outageEngine("outage-relaunch-before", false);
  try {
    writeFindsChainGone = true;
    S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
    const first = await import("./engine.ts?outage-relaunch-before");
    await first.syncNow();
    assert.equal(first.useSync.getState().dataMissing, false, "the first look defers its verdict");
    telemetry.setSharing(true, "settings");
    const relaunched = await import("./engine.ts?outage-relaunch-before-2");
    relaunched.startSync();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 2; i++) await relaunched.syncNow();
    assert.equal(relaunched.useSync.getState().dataMissing, true);
    assert.equal(relaunched.takeSnapshotWrites().chainMissing, 0);
  } finally {
    writeFindsChainGone = false;
    telemetry.setSharing(false, "settings");
  }
});

test("a relaunch after an outage was counted never counts it again", async () => {
  reset();
  const { telemetry, engine } = await outageEngine("outage-relaunch-after", true);
  try {
    chainOf(SYNC_FOLDER).delete(OURS);
    await engine.syncNow();
    assert.equal(engine.takeSnapshotWrites().chainMissing, 1, "counted before the relaunch");
    assert.equal(JSON.parse(shell.docs.get("sync.json")).chainOutage?.counted, true, "the count is saved with the outage");
    const relaunched = await import("./engine.ts?outage-relaunch-after-2");
    relaunched.startSync();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 2; i++) await relaunched.syncNow();
    assert.equal(relaunched.useSync.getState().dataMissing, true);
    assert.equal(relaunched.takeSnapshotWrites().chainMissing, 0);
  } finally {
    telemetry.setSharing(false, "settings");
  }
});
