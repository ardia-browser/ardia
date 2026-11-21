import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folders = new Map();
const OURS = "ours";
let ids = 0;
let writeFailsAfter = Infinity;
const pendingIn = new Map();
const readOnly = new Set();
const unreadable = new Set();
let afterWrite = () => {};

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
  deviceName: () => "Test Computer",
  createPhrase: async () => true,
  unlock: async () => true,
  forget: async () => {},
  folderInfo: async (path) => ({ path, defaultPath: "/home/someone/Ardia Sync", iCloudAvailable: true, inICloud: false, exists: folders.has(path), writable: !readOnly.has(path), hasSyncData: (chainOf(path)?.size ?? 0) > 0 }),
  chooseFolder: async () => null,
  chainStatus: async (folder) => (!folders.has(folder) ? "unavailable" : chainOf(folder).has(OURS) ? "ok" : "missing"),
  createChain: async (folder) => {
    if (chainOf(folder)?.has(OURS)) throw new Error("the chain already exists");
    plant(folder, OURS);
  },
  deleteChain: async (folder) => void chainOf(folder)?.delete(OURS),
  write: async (folder, scope, payload) => {
    if (writeFailsAfter-- <= 0) throw new Error("disk full");
    const id = `f${++ids}`;
    scopeOf(folder, OURS, scope).set(id, payload);
    afterWrite(folder, scope);
    return id;
  },
  read: async (folder, scope, known) => {
    if (!chainOf(folder)?.has(OURS) || unreadable.has(folder)) throw new Error(`no chain in ${folder}`);
    const here = [...(chainOf(folder).get(OURS).get(scope) ?? [])];
    const pending = pendingIn.get(`${folder}|${scope}`) ?? [];
    return { files: here.filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload })), pending, damaged: [], present: here.map(([id]) => id) };
  },
  remove: async (folder, scope, list) => list.forEach((id) => scopeOf(folder, OURS, scope).delete(id)),
  sealLocal: async (text) => `sealed:${text}`,
  openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
  readPasswords: async () => null,
};
globalThis.acTestNativeModules = { ArdiaSync: native };

const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { moveChain, syncFolderAt, folderMoveMessage, folderScopes } = await import("./folderMove.ts");
const S = () => useBrowser.getState();
const reset = () => {
  folders.clear();
  pendingIn.clear();
  readOnly.clear();
  unreadable.clear();
  afterWrite = () => {};
  writeFailsAfter = Infinity;
  shell.docs.clear();
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
};
const payloads = (folder, scope) => [...(chainOf(folder).get(OURS).get(scope)?.values() ?? [])].sort();
const info = (path) => native.folderInfo(path);

test("a picked folder becomes an Ardia Sync folder inside it, unless it already is one or already holds sync data", async () => {
  reset();
  assert.equal(await syncFolderAt("/home/someone/Nextcloud", info), "/home/someone/Nextcloud/Ardia Sync");
  assert.equal(await syncFolderAt("/home/someone/Nextcloud/", info), "/home/someone/Nextcloud/Ardia Sync");
  assert.equal(await syncFolderAt("/media/usb/Ardia Sync", info), "/media/usb/Ardia Sync");
  assert.equal(await syncFolderAt("/", info), "/Ardia Sync");
  plant("/home/someone/Dropbox/Browser", "theirs");
  assert.equal(await syncFolderAt("/home/someone/Dropbox/Browser", info), "/home/someone/Dropbox/Browser", "a folder with sync data in it is used as it is");
  plant("/home/someone/Sync/Ardia Sync", OURS);
  assert.equal(await syncFolderAt("/home/someone/Sync", info), "/home/someone/Sync/Ardia Sync", "picking the folder that holds an existing Ardia Sync folder finds it");
});

test("moving copies every file of the chain to the new folder, byte for byte, and leaves the old folder as it was", async () => {
  reset();
  plant("/old", OURS);
  plant("/old", "someone else");
  await native.write("/old", "app", '{"kind":"log","seq":1}');
  await native.write("/old", "app", '{"kind":"snapshot"}');
  await native.write("/old", "p:abc", '{"kind":"log","seq":4}');
  const before = structuredClone([...folders.get("/old")].map(([chain, scopes]) => [chain, [...scopes].map(([s, files]) => [s, [...files]])]));

  assert.deepEqual(await moveChain(native, "/old", "/new/Ardia Sync", ["app", "p:abc", "p:never-written"]), { ok: "moved" });
  assert.deepEqual(payloads("/new/Ardia Sync", "app"), payloads("/old", "app"));
  assert.deepEqual(payloads("/new/Ardia Sync", "p:abc"), payloads("/old", "p:abc"));
  assert.ok(!folders.get("/new/Ardia Sync").has("someone else"), "another phrase's chain isn't copied");
  assert.deepEqual([...folders.get("/old")].map(([chain, scopes]) => [chain, [...scopes].map(([s, files]) => [s, [...files]])]), before, "the old folder is untouched, so devices still using it keep working");
});

test("pointing at a folder that already holds this chain only re-points, and a folder holding another phrase's data is refused", async () => {
  reset();
  plant("/old", OURS);
  plant("/copied-by-hand", OURS);
  await native.write("/copied-by-hand", "app", '{"seq":1}');
  plant("/someone-elses", "theirs");
  assert.deepEqual(await moveChain(native, "/old", "/copied-by-hand", ["app"]), { ok: "joined" });
  assert.deepEqual(await moveChain(native, "/old", "/someone-elses", ["app"]), { error: "otherData" });
  assert.ok(!chainOf("/someone-elses").has(OURS), "nothing is written next to another phrase's chain");
  assert.deepEqual(await moveChain(native, "/old", "/old/", ["app"]), { ok: "same" });
  assert.deepEqual(await moveChain(native, "/old", "/old/inner/Ardia Sync", ["app"]), { error: "nested" });
  assert.deepEqual(await moveChain(native, "/home/Ardia Sync", "/home", ["app"]), { error: "nested" });
});

test("a move waits for files still downloading, and refuses when the current folder can't be read", async () => {
  reset();
  plant("/old", OURS);
  pendingIn.set("/old|app", ["late"]);
  assert.deepEqual(await moveChain(native, "/old", "/new", ["app"]), { error: "arriving" });
  assert.equal(folders.has("/new"), false, "nothing is created when the move is refused");
  assert.deepEqual(await moveChain(native, "/gone", "/new", ["app"]), { error: "unreadable" });
});

test("a copy that fails halfway removes what it wrote and keeps the old folder in use", async () => {
  reset();
  plant("/old", OURS);
  for (let n = 0; n < 4; n++) await native.write("/old", "app", `{"seq":${n}}`);
  writeFailsAfter = 2;
  const result = await moveChain(native, "/old", "/new", ["app"]);
  assert.equal(result.error, "failed");
  assert.match(result.message, /disk full/);
  assert.deepEqual(payloads("/new", "app"), [], "every file the copy wrote is removed");
  assert.ok(chainOf("/new").has(OURS), "the chain is kept: deleting it could take a file another device wrote after any check");
  assert.equal(payloads("/old", "app").length, 4);
  writeFailsAfter = Infinity;
  assert.deepEqual(await moveChain(native, "/old", "/new", ["app"]), { ok: "moved" }, "an empty chain left by a failed copy is copied into, not joined");
  assert.deepEqual(payloads("/new", "app"), payloads("/old", "app"));
});

test("the engine moves the folder while sync is on: later batches land in the new folder and the cycle keeps syncing", async () => {
  reset();
  const engine = await import("./engine.ts?move");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/home/someone/Ardia Sync", "picked")));
  S().addBookmark({ profileId: "default", url: "https://before.example/", title: "Before" });
  await engine.syncNow();
  const oldApp = payloads("/home/someone/Ardia Sync", "app");
  assert.ok(oldApp.length > 0);

  const result = await engine.moveSyncFolder("/home/someone/Nextcloud/Ardia Sync");
  assert.deepEqual(result, { ok: "moved" });
  assert.equal(engine.useSync.getState().folder, "/home/someone/Nextcloud/Ardia Sync");
  assert.deepEqual(payloads("/home/someone/Nextcloud/Ardia Sync", "app"), oldApp);

  S().addBookmark({ profileId: "default", url: "https://after.example/", title: "After" });
  await engine.syncNow();
  assert.equal(engine.useSync.getState().status, "updated", "the new folder holds the chain, so the cycle doesn't read it as reset");
  const titles = (folder) =>
    [...chainOf(folder).get(OURS).values()].flatMap((files) => [...files.values()]).flatMap((payload) => JSON.parse(payload).ops ?? []).map((op) => op.v?.t);
  assert.ok(titles("/home/someone/Nextcloud/Ardia Sync").includes("After"));
  assert.ok(titles("/home/someone/Nextcloud/Ardia Sync").includes("Before"));
  assert.ok(!titles("/home/someone/Ardia Sync").includes("After"), "the old folder gets nothing new");

  assert.deepEqual(await engine.moveSyncFolder("/home/someone/Nextcloud"), { error: "nested" });
  plant("/elsewhere", "theirs");
  assert.deepEqual(await engine.moveSyncFolder("/elsewhere"), { error: "otherData" });
  assert.equal(engine.useSync.getState().folder, "/home/someone/Nextcloud/Ardia Sync", "a refused move keeps the folder");

  const { folders: counts } = engine.takeSnapshotWrites();
  assert.deepEqual(counts, { picked: 1, kept: 0, moved: 1, joined: 0, refused: 2 });
});

test("a move is refused while sync is off, and setting the folder while on is ignored", async () => {
  reset();
  const engine = await import("./engine.ts?off");
  engine.startSync();
  assert.deepEqual(await engine.moveSyncFolder("/new"), { error: "busy" });
  engine.setSyncFolder("/chosen/Ardia Sync");
  assert.equal(engine.useSync.getState().folder, "/chosen/Ardia Sync");
  assert.ok("ok" in (await engine.turnOnSync("/chosen/Ardia Sync")));
  engine.setSyncFolder("/other");
  assert.equal(engine.useSync.getState().folder, "/chosen/Ardia Sync");
});

test("every profile the folder knows about moves with it, not just the ones synced here", () => {
  const doc = {
    scopes: { app: { records: { "prof:aaa": { v: {} }, "prof:bbb": { v: null }, "pta:aaa": { v: {} } } }, "p:ccc": { records: {} } },
    profiles: { default: { syncId: "ddd", enabled: false } },
  };
  assert.deepEqual(folderScopes(doc).sort(), ["app", "p:aaa", "p:bbb", "p:ccc", "p:ddd"]);
});

test("each move outcome has a message that says where sync is now", () => {
  assert.match(folderMoveMessage({ ok: "moved" }, "~/Nextcloud/Ardia Sync", "~/Ardia Sync"), /Sync now uses ~\/Nextcloud\/Ardia Sync\. The old folder at ~\/Ardia Sync stays/);
  assert.match(folderMoveMessage({ error: "otherData" }, "x", "y"), /different recovery phrase/);
  assert.match(folderMoveMessage({ error: "failed", message: "disk full" }, "x", "~/Ardia Sync"), /disk full\. Sync still uses ~\/Ardia Sync/);
});

test("a profile another device added since the last cycle moves too: the move reads the profiles from the old folder's app scope", async () => {
  reset();
  plant("/old", OURS);
  const record = { h: "1:0:dev", v: {}, o: ["dev", 1] };
  await native.write("/old", "app", JSON.stringify({ v: 1, kind: "snapshot", device: "dev", at: 1, vv: { dev: 1 }, seen: {}, records: { "prof:bbb": record } }));
  await native.write("/old", "app", JSON.stringify({ v: 1, kind: "log", device: "dev", seq: 2, at: 2, ops: [{ k: "prof:ccc", h: "2:0:dev", v: {} }] }));
  await native.write("/old", "p:bbb", '{"kind":"log","seq":1}');
  await native.write("/old", "p:ccc", '{"kind":"log","seq":1}');
  assert.deepEqual(await moveChain(native, "/old", "/new", ["app"]), { ok: "moved" });
  assert.deepEqual(payloads("/new", "p:bbb"), payloads("/old", "p:bbb"), "a profile only a snapshot names is copied");
  assert.deepEqual(payloads("/new", "p:ccc"), payloads("/old", "p:ccc"), "a profile only a log names is copied");
});

test("a folder that holds this chain but can't be written is refused instead of joined", async () => {
  reset();
  plant("/old", OURS);
  plant("/read-only", OURS);
  readOnly.add("/read-only");
  assert.deepEqual(await moveChain(native, "/old", "/read-only", ["app"]), { error: "notWritable" });
  plant("/read-only-theirs", "theirs");
  readOnly.add("/read-only-theirs");
  assert.deepEqual(await moveChain(native, "/old", "/read-only-theirs", ["app"]), { error: "otherData" }, "another phrase's data is named first, whatever the folder's permissions");
});

test("a failed copy removes only the files it wrote: a file another device wrote meanwhile, and the chain, stay", async () => {
  reset();
  plant("/old", OURS);
  for (let n = 0; n < 4; n++) await native.write("/old", "app", `{"seq":${n}}`);
  writeFailsAfter = 2;
  let planted = false;
  afterWrite = (folder, scope) => {
    if (folder !== "/new" || planted) return;
    planted = true;
    scopeOf("/new", OURS, scope).set("other-device", '{"seq":"theirs"}');
  };
  assert.equal((await moveChain(native, "/old", "/new", ["app"])).error, "failed");
  assert.ok(chainOf("/new").has(OURS), "the chain stays while another device's file is in it");
  assert.deepEqual(payloads("/new", "app"), ['{"seq":"theirs"}']);
});

test("turning Sync off during a move waits for the move, then turns Sync off", async () => {
  reset();
  const engine = await import("./engine.ts?stop");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/home/someone/Ardia Sync", "picked")));
  S().addBookmark({ profileId: "default", url: "https://before.example/", title: "Before" });
  await engine.syncNow();
  const moving = engine.moveSyncFolder("/home/someone/Nextcloud/Ardia Sync");
  await engine.stopSync();
  assert.deepEqual(await moving, { ok: "moved" });
  assert.equal(engine.useSync.getState().enabled, false, "the stop isn't dropped because a move was running");
});

test("a failed copy keeps the chain when another device wrote a profile the move never copied", async () => {
  reset();
  plant("/old", OURS);
  for (let n = 0; n < 4; n++) await native.write("/old", "app", `{"seq":${n}}`);
  writeFailsAfter = 2;
  let planted = false;
  afterWrite = (folder) => {
    if (folder !== "/new" || planted) return;
    planted = true;
    scopeOf("/new", OURS, "p:zzz").set("other-profile", '{"seq":"theirs"}');
    scopeOf("/new", OURS, "app").set("other-app", JSON.stringify({ v: 1, kind: "log", device: "other", seq: 1, at: 1, ops: [{ k: "prof:zzz", h: "1:0:other", v: {} }] }));
  };
  assert.equal((await moveChain(native, "/old", "/new", ["app"])).error, "failed");
  assert.ok(chainOf("/new").has(OURS), "the chain stays while a profile another device wrote is in it");
  assert.deepEqual(payloads("/new", "p:zzz"), ['{"seq":"theirs"}']);
});

test("Sync Now during a move waits for the move, then runs its cycle in the new folder", async () => {
  reset();
  const engine = await import("./engine.ts?syncnow");
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/home/someone/Ardia Sync", "picked")));
  await engine.syncNow();
  const moving = engine.moveSyncFolder("/home/someone/Nextcloud/Ardia Sync");
  S().addBookmark({ profileId: "default", url: "https://during.example/", title: "During" });
  assert.equal(await engine.syncNow(), true);
  assert.deepEqual(await moving, { ok: "moved" });
  const titles = [...chainOf("/home/someone/Nextcloud/Ardia Sync").get(OURS).values()].flatMap((files) => [...files.values()]).flatMap((payload) => JSON.parse(payload).ops ?? []).map((op) => op.v?.t);
  assert.ok(titles.includes("During"), "the cycle Sync Now asked for ran after the move, in the new folder");
});

test("a chain that holds only part of the old folder's files is completed, not joined", async () => {
  reset();
  plant("/old", OURS);
  for (let n = 0; n < 4; n++) await native.write("/old", "app", `{"seq":${n}}`);
  plant("/partial", OURS);
  await native.write("/partial", "app", '{"seq":0}');
  await native.write("/partial", "app", '{"seq":1}');
  assert.deepEqual(await moveChain(native, "/old", "/partial", ["app"]), { ok: "moved" });
  assert.deepEqual(payloads("/partial", "app"), payloads("/old", "app"), "only the missing files are written, so nothing is doubled");
  assert.deepEqual(await moveChain(native, "/old", "/partial", ["app"]), { ok: "joined" }, "a complete chain is pointed at");
});

test("a retry whose read of the new folder fails is a failed move, not a join", async () => {
  reset();
  plant("/old", OURS);
  for (let n = 0; n < 4; n++) await native.write("/old", "app", `{"seq":${n}}`);
  writeFailsAfter = 2;
  assert.equal((await moveChain(native, "/old", "/new", ["app"])).error, "failed");
  writeFailsAfter = Infinity;
  unreadable.add("/new");
  const retry = await moveChain(native, "/old", "/new", ["app"]);
  assert.equal(retry.error, "failed", "Sync keeps the old folder");
});

test("when the old folder is gone, a folder with this chain's files is pointed at, and an empty one is refused", async () => {
  reset();
  plant("/moved-by-hand", OURS);
  await native.write("/moved-by-hand", "app", '{"seq":1}');
  plant("/empty", OURS);
  assert.deepEqual(await moveChain(native, "/gone", "/moved-by-hand", ["app"]), { ok: "joined" });
  assert.deepEqual(await moveChain(native, "/gone", "/empty", ["app"]), { error: "unreadable" });
});
