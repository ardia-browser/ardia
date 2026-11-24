import assert from "node:assert/strict";
import { test } from "node:test";
import { shellNativeModules } from "../../test-native/shell.ts";

let duringResolve = () => {};
let resolves = 0;
const refusedPaths = new Set();
const reads = [];

globalThis.acTestNativeModules = {
  ArdiaDialogs: { ...shellNativeModules.ArdiaDialogs, pickFolder: async () => "/scratch/Ardia Shared/Team" },
  ArdiaSharedFolders: {
    location: () => ({ path: "/scratch/Ardia Shared", iCloudAvailable: true, iCloudPath: "/scratch" }),
    resolve: async (path) => refusedPaths.has(path) ? Promise.reject(Object.assign(new Error(`${path} is a system or home folder`), { code: "ERR_SHARED_FOLDER_REFUSED" })) : (++resolves === 2 && duringResolve(), { path, device: 1, inode: path.endsWith("Old") ? 23 : 21 }),
    read: async (path) => (reads.push(path), { exists: true, root: { entries: [], manifest: null, manifestPending: false } }),
    apply: async () => ({ conflicts: [] }),
    create: async (parent, _identity, name) => ({ path: `${parent}/${name}`, device: 1, inode: 22 }),
    watch: () => {},
    addListener: () => ({ remove() {} }),
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { bindFolder, boundFolders, unbindFolder } = await import("./store.ts");
const { addSharedFolder } = await import("./actions.ts");
const { syncFolderNow } = await import("./engine.ts");
const S = () => useBrowser.getState();

test("adding a folder while the window switches profile binds nothing to either profile", async () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://home.example/" });
  const before = S().windows[windowId].profileId;
  const other = S().createProfile({ name: "Other" });
  bindFolder(before, "legacy-key", "/scratch/Ardia Shared/Old");
  duringResolve = () => S().switchProfile(windowId, other);
  await addSharedFolder(windowId);
  assert.equal(resolves, 2, "the switch landed while the existing bindings were checked");
  assert.equal(S().windows[windowId].profileId, other, "the window switched");
  assert.deepEqual(boundFolders().map((b) => b.key), ["legacy-key"], "nothing new was bound");
  assert.equal(Object.values(S().groups).filter((g) => g.pinned).length, 0, "no shared group was made");
  unbindFolder(before, "legacy-key");
});

test("a legacy binding whose folder is now refused is neither synced nor treated as a match", async () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://home.example/" });
  const profileId = S().windows[windowId].profileId;
  const tab = S().newTab(windowId, { url: "https://a.example/", background: true });
  const groupId = S().groupTabs([tab], { pinned: true, name: "Home" });
  const { pinKeyOf } = await import("../browser/model.ts");
  const key = pinKeyOf(S().groups[groupId]);
  refusedPaths.add("/Users/someone");
  bindFolder(profileId, key, "/Users/someone");
  reads.length = 0;
  try {
    await syncFolderNow(profileId, key);
    assert.deepEqual(reads, [], "the refused folder wasn't read");
  } finally {
    unbindFolder(profileId, key);
    refusedPaths.clear();
  }
});

test("adding the same folder twice at once binds it once", async () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://home.example/" });
  duringResolve = () => {};
  await Promise.all([addSharedFolder(windowId), addSharedFolder(windowId)]);
  assert.equal(boundFolders().length, 1, JSON.stringify(boundFolders()));
  const { pinKeyOf } = await import("../browser/model.ts");
  const groups = Object.values(S().groups).filter((g) => g.pinned);
  assert.equal(groups.length, 1, "one shared group");
  unbindFolder(groups[0].profileId, pinKeyOf(groups[0]));
});
