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
const { bindFolder } = await import("../sharedFolders/store.ts");
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

test("shared folders over the socket: list reads the sidebar's shared folders; the writes wait for the follow-up", async () => {
  const { tab, windowId } = await setup();
  assert.deepEqual(await ok("sharedFolders.list"), []);
  const group = S().groupTabs([tab], { pinned: true, name: "Team" });
  const profileId = S().groups[group].profileId;
  bindFolder(profileId, pinKeyOf(S().groups[group]), "/scratch/Ardia Shared/Team", { device: 1, inode: 7 });
  const rows = await ok("sharedFolders.list");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "/scratch/Ardia Shared/Team");
  assert.equal(rows[0].url, "file:///scratch/Ardia%20Shared/Team/");
  assert.deepEqual(rows[0].groups, [group]);
  assert.equal(rows[0].name, "Team");
  for (const method of ["sharedFolders.share", "sharedFolders.add", "sharedFolders.sync", "sharedFolders.stop"]) assert.equal(await code(method, { group, path: "/scratch/x", window: windowId }), "unknown_method", method);
  assert.equal(created.length, 0, "nothing on disk was made");
});
