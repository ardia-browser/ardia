import assert from "node:assert/strict";
import { test } from "node:test";

const created = [];
const listing = { exists: true, root: { entries: [], manifest: null, manifestPending: false } };
let iCloud = true;
globalThis.acTestNativeModules = {
  ArdiaSharedFolders: {
    location: () => ({ path: "/scratch/Ardia Shared", iCloudAvailable: iCloud, iCloudPath: "/scratch" }),
    read: async () => listing,
    apply: async () => ({ conflicts: [] }),
    create: async (parent, _parentIdentity, name) => (created.push([parent, name]), { path: `${parent}/${name}`, device: 1, inode: `${parent}/${name}`.length }),
    resolve: async (path) => ({ path: path.replace(/\/+$/, ""), device: 1, inode: path.replace(/\/+$/, "").length }),
    discard: async () => true,
    watch: () => {},
    addListener: () => ({ remove() {} }),
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { startPersistence } = await import("../session/persist.ts");
const { sharedFolderOf } = await import("../sharedFolders/store.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 23, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 4000 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 23); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 23);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const code = async (method, params) => (await call(method, params)).error?.code;

let persisting = false;
async function setup() {
  if (!persisting) (startPersistence(), (persisting = true));
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://home.example/" });
  const tab = S().newTab(windowId, { url: "https://one.example/", background: true });
  return { windowId, tab };
}

test("shared folders: share a pinned folder, list it, sync it, stop it; the group stays", async () => {
  const { tab } = await setup();
  const group = S().groupTabs([tab], { pinned: true, name: "Team" });
  const loose = S().groupTabs([S().newTab(S().tabs[tab].windowId, { url: "https://two.example/", background: true })], { pinned: false, name: "Loose" });
  assert.deepEqual(await ok("sharedFolders.list"), []);
  assert.equal(await code("sharedFolders.share", { group: loose }), "bad_request");
  assert.equal(await code("sharedFolders.share", { group: "nope" }), "no_window");
  assert.equal(await code("sharedFolders.share", { group, parent: "relative/path" }), "bad_request");
  const shared = await ok("sharedFolders.share", { group });
  assert.deepEqual(created.at(-1), ["/scratch/Ardia Shared", "Team"]);
  assert.equal(shared.path, "/scratch/Ardia Shared/Team");
  assert.equal(shared.url, "file:///scratch/Ardia%20Shared/Team/");
  assert.deepEqual(shared.groups, [group]);
  assert.equal(shared.name, "Team");
  assert.deepEqual((await ok("sharedFolders.list")).map((f) => f.path), ["/scratch/Ardia Shared/Team"]);
  assert.equal((await ok("sharedFolders.sync", { group })).path, shared.path);
  await ok("sharedFolders.stop", { group });
  assert.equal(sharedFolderOf(S().groups[group].profileId, pinKeyOf(S().groups[group])), undefined);
  assert.ok(S().groups[group], "the group stays in the sidebar");
  assert.equal(await code("sharedFolders.stop", { group }), "bad_request");
});

test("shared folders: with iCloud Drive off, share needs a parent; add brings in a folder someone shared", async () => {
  const { windowId } = await setup();
  const tab = S().newTab(windowId, { url: "https://three.example/", background: true });
  const group = S().groupTabs([tab], { pinned: true, name: "Plans" });
  iCloud = false;
  try {
    assert.equal(await code("sharedFolders.share", { group }), "refused");
    const shared = await ok("sharedFolders.share", { group, parent: "/Users/me/Dropbox" });
    assert.equal(shared.path, "/Users/me/Dropbox/Plans");
  } finally {
    iCloud = true;
  }
  const added = await ok("sharedFolders.add", { path: "/scratch/Ardia Shared/From Sam/", window: windowId });
  assert.equal(added.path, "/scratch/Ardia Shared/From Sam");
  assert.equal(added.groups.length, 1);
  assert.equal(S().groups[added.groups[0]].name, "From Sam");
  assert.ok(S().groups[added.groups[0]].pinned);
  const again = await ok("sharedFolders.add", { path: "/scratch/Ardia Shared/From Sam" });
  assert.deepEqual(again.groups, added.groups, "adding it twice keeps one folder");
  assert.equal(await code("sharedFolders.add", { path: "../escape" }), "bad_request");
});
