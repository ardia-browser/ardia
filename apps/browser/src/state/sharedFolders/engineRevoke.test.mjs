import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { shellNativeModules } from "../../test-native/shell.ts";

const shares = [];
const tokens = [];
const cancels = [];
const cancelHooks = new Map();
let changeListener = null;

const webloc = (url) => `<plist><dict><key>URL</key><string>${url}</string></dict></plist>`;
const events = [];
const files = new Map();
const landed = new Map();
const pending = new Map();
const failing = new Set();
const unstageable = new Set();
let duringRead = async () => {};
let duringSave = () => {};
let duringApply = async () => {};
const nextConflicts = [];
const byPath = new Map();
let listing = { exists: true, root: { entries: [], manifest: null, manifestPending: false } };

function land(name) {
  const contents = pending.get(name);
  if (contents === undefined) return null;
  if (failing.has(name)) return new Error(`saving ${name} failed`);
  pending.delete(name);
  landed.set(name, contents);
  events.push(`landed ${name}`);
  return null;
}

globalThis.acTestNativeModules = {
  ArdiaApp: { ...shellNativeModules.ArdiaApp, share: async (url) => void (shares.push(url), events.push("share")) },
  ArdiaDocuments: {
    readDocument: (name) => pending.get(name) ?? landed.get(name) ?? null,
    writeDocument: (name, contents) => {
      if (unstageable.has(name)) throw new Error(`can't stage ${name}`);
      pending.set(name, contents);
      setTimeout(() => land(name), 5);
    },
    saveDocument: async (name, contents) => void pending.set(name, contents),
    documentSaved: (name) =>
      new Promise((resolve, reject) => duringSave(name) ??
        setTimeout(() => {
          events.push(`awaited ${name}`);
          const error = land(name);
          error ? reject(error) : resolve();
        }, 20),
      ),
    removeDocument: (name) => void (pending.delete(name), landed.delete(name)),
  },
  ArdiaSharedFolders: {
    location: () => ({ path: "/scratch/Ardia Shared", iCloudAvailable: true, iCloudPath: "/scratch" }),
    read: async (path) => {
      events.push(`read ${path}`);
      const now = byPath.get(path) ?? listing;
      await duringRead();
      return now;
    },
    apply: async (path, ops, _identity, token) => {
      events.push(`apply ${path} ${JSON.parse(ops).length}`);
      tokens.push(token);
      const result = await duringApply(token);
      return result ?? { conflicts: nextConflicts.splice(0) };
    },
    cancel: (token) => (cancels.push(token), cancelHooks.get(token)?.()),
    create: async (parent, _parentIdentity, name) => ({ path: `${parent}/${name}`, device: 1, inode: 1 }),
    resolve: async (path) => ({ path, device: 1, inode: [...path].reduce((n, c) => n + c.charCodeAt(0), 0) }),
    watch: () => {},
    addListener: (_name, listener) => ((changeListener = listener), { remove() {} }),
  },
};

const { startPersistence } = await import("../session/persist.ts");
const { useBrowser } = await import("../browser/store.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const { STOP_WAIT_MS, startSharedFolders, stopSyncing, syncFolderNow } = await import("./engine.ts");
const { bindFolder, sharedFolderOf, unbindFolder, useSharedFolders } = await import("./store.ts");
const { shareFolder } = await import("./actions.ts");

const S = () => useBrowser.getState();
const idOf = (path) => ({ device: 1, inode: [...path].reduce((n, c) => n + c.charCodeAt(0), 0) });
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
const flush = () => new Promise(setImmediate);
async function wait(ms) {
  for (let at = 0; at < ms; at += 5) {
    mock.timers.tick(5);
    await flush();
  }
}
async function settled(promise) {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let at = 0; !done; at += 5) {
    assert.ok(at < 60_000, "the round settles within a minute of fake time");
    mock.timers.tick(5);
    await flush();
  }
  return promise;
}

let persisting = false;
function fresh() {
  if (!persisting) (startPersistence(), (persisting = true));
  events.length = 0;
  failing.clear();
  unstageable.clear();
  listing = { exists: true, root: { entries: [], manifest: null, manifestPending: false } };
  duringRead = async () => {};
  duringSave = () => {};
  duringApply = async () => {};
  nextConflicts.length = 0;
  byPath.clear();
}

function setup() {
  fresh();
  const w = S().createWindow({ url: "https://home.example/" });
  const t = S().newTab(w, { url: "https://one.example/", background: true });
  const g = S().groupTabs([t], { pinned: true, name: "Team" });
  const profileId = S().groups[g].profileId;
  const key = pinKeyOf(S().groups[g]);
  bindFolder(profileId, key, "/scratch/Ardia Shared/Team", idOf("/scratch/Ardia Shared/Team"));
  return { profileId, key };
}

function setupAt(path) {
  const { profileId, key } = setup();
  unbindFolder(profileId, key);
  bindFolder(profileId, key, path, idOf(path));
  return { profileId, key, applies: () => events.filter((e) => e.startsWith(`apply ${path} `)) };
}

const remoteLink = (url) => ({ exists: true, root: { entries: [{ kind: "link", file: `${url.split("/")[2]}.webloc`, text: webloc(url) }], manifest: null, manifestPending: false } });
const untilCancelled = (token) => new Promise((resolve) => cancelHooks.set(token, () => resolve({ conflicts: [], cancelled: true })));

startSharedFolders();

test("a write in flight when the socket's guard goes off is cancelled, and its round commits nothing", async () => {
  const { profileId, key } = setupAt("/scratch/Ardia Shared/Cancel Write");
  await wait(900);
  await settled(syncFolderNow(profileId, key));
  const before = sharedFolderOf(profileId, key).base;
  listing = remoteLink("https://cancel-write.example/");
  let on = true;
  duringApply = (token) => ((on = false), untilCancelled(token));
  await settled(syncFolderNow(profileId, key, () => on));
  assert.equal(cancels.at(-1), tokens.at(-1), "the in-flight batch got its cancel");
  assert.equal(sharedFolderOf(profileId, key).base, before, "the base didn't move");
});

test("stop cancels the batch in flight and returns once it has finished", async () => {
  const { profileId, key } = setupAt("/scratch/Ardia Shared/Stop Write");
  await wait(900);
  listing = remoteLink("https://stop-write.example/");
  let entered = false;
  duringApply = (token) => ((entered = true), untilCancelled(token));
  const round = syncFolderNow(profileId, key);
  for (let i = 0; i < 200 && !entered; i++) await wait(5);
  assert.ok(entered, "the write started");
  assert.equal(await settled(stopSyncing(profileId, key)), true);
  assert.equal(cancels.at(-1), tokens.at(-1));
  assert.equal(sharedFolderOf(profileId, key), undefined);
  await settled(round);
});

test("stop answers false when the batch doesn't finish within its wait", async () => {
  const { profileId, key } = setupAt("/scratch/Ardia Shared/Stuck Write");
  await wait(900);
  listing = remoteLink("https://stuck-write.example/");
  let finish;
  let entered = false;
  duringApply = () => ((entered = true), new Promise((resolve) => (finish = resolve)));
  const round = syncFolderNow(profileId, key);
  for (let i = 0; i < 200 && !entered; i++) await wait(5);
  const stopping = stopSyncing(profileId, key);
  let answer;
  stopping.then((v) => (answer = v));
  await wait(STOP_WAIT_MS + 50);
  assert.equal(answer, false);
  finish({ conflicts: [] });
  await settled(round);
});

async function revokedSocketRound(path) {
  const { profileId, key, applies } = setupAt(path);
  await wait(900);
  await settled(syncFolderNow(profileId, key));
  await wait(900);
  listing = remoteLink(`https://${path.split("/").at(-1).toLowerCase().replace(/ /g, "-")}.example/`);
  let on = true;
  duringSave = () => void (on = false);
  const before = applies().length;
  await settled(syncFolderNow(profileId, key, () => on));
  duringSave = () => {};
  assert.equal(applies().length, before, "the revoked round wrote nothing");
  return { profileId, key, applies, before };
}

test("the watcher's round never writes a change a revoked socket round made; the disk side wins", async () => {
  const path = "/scratch/Ardia Shared/Watcher Wins";
  const { profileId, key, applies, before } = await revokedSocketRound(path);
  changeListener?.({ paths: [path] });
  await wait(1000);
  assert.equal(applies().length, before, "the watcher's round wrote nothing");
  assert.ok(sharedFolderOf(profileId, key).base.some((b) => b.kind === "link" && b.url === "https://watcher-wins.example/"), "the disk's link is the new base");
  const g = Object.values(S().groups).find((x) => x.profileId === profileId && x.pinned && !x.parentId && pinKeyOf(x) === key);
  S().addTabsToGroup(g.id, [S().newTab(g.windowId, { url: "https://after.example/", background: true })]);
  await wait(2000);
  assert.ok(applies().length > before, "a later change made by hand syncs as usual");
});

test("the poll's round never writes a change a revoked socket round made; the disk side wins", async () => {
  const { profileId, key, applies, before } = await revokedSocketRound("/scratch/Ardia Shared/Poll Wins");
  await wait(61_000);
  assert.equal(applies().length, before, "the poll's round wrote nothing");
  assert.ok(sharedFolderOf(profileId, key).base.some((b) => b.kind === "link" && b.url === "https://poll-wins.example/"), "the disk's link is the new base");
});
