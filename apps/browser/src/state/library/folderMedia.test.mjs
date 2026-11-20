import assert from "node:assert/strict";
import { test } from "node:test";

const folders = new Map([["", "/Users/me/Downloads"]]);
const listings = new Map();
const watching = new Map();
const listed = [];
const folderEvents = new Set();

const system = {
  listFolderMedia: async (folder) => {
    listed.push(folder);
    return listings.get(folder) ?? { status: "missing", files: [] };
  },
  watchFolder: (token, folder) => watching.set(token, folder),
  unwatchFolder: (token) => watching.delete(token),
  addListener: (_name, listener) => {
    folderEvents.add(listener);
    return { remove: () => folderEvents.delete(listener) };
  },
};

const downloads = {
  call: async (verb, profile, json) => {
    if (verb === "settings") return JSON.stringify({ folder: folders.get(profile) ?? "", askWhereToSave: false, managed: false });
    if (verb === "setSettings") {
      folders.set(profile, JSON.parse(json).folder);
      return JSON.stringify({ folder: folders.get(profile), askWhereToSave: false, managed: false });
    }
    throw new Error(`no fake for downloads.${verb}`);
  },
  addListener: () => ({ remove() {} }),
};

globalThis.acTestNativeModules = { ...globalThis.acTestNativeModules, ArdiaSystem: system, ArdiaDownloads: downloads };

const { followFolderMedia, folderListings } = await import("./folderMedia.ts");
const { setDownloadSettings } = await import("../../platform/downloads.ts");
const { folderMediaListing } = await import("../../../../../packages/shell/src/system.tsx");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const photo = (folder, name) => ({ path: `${folder}/${name}`, name, size: 1, added: 1, modified: 1, kind: "image" });
const fireFolderChange = () => {
  for (const [token] of watching) for (const listener of folderEvents) listener({ token });
};

test("a followed folder reports its files, and a refused folder reports why with no files", async () => {
  listings.set("/Users/me/Downloads", { status: "ok", files: [photo("/Users/me/Downloads", "a.png"), { path: "relative", name: "x", kind: "image", added: 1 }] });
  const stop = followFolderMedia([""], () => {});
  await settle();
  assert.deepEqual(
    folderListings([""]).map((l) => [l.folder, l.status, l.files.map((f) => f.name)]),
    [["/Users/me/Downloads", "ok", ["a.png"]]],
  );
  listings.set("/Users/me/Downloads", { status: "denied", files: [] });
  fireFolderChange();
  await settle();
  assert.deepEqual(
    folderListings([""]).map((l) => [l.status, l.files.length]),
    [["denied", 0]],
  );
  stop();
  assert.equal(watching.size, 0);
});

test("changing the download folder while Media shows lists and watches the new folder instead of the old one", async () => {
  listings.set("/Users/me/Downloads", { status: "ok", files: [photo("/Users/me/Downloads", "old.png")] });
  listings.set("/Volumes/Media/Inbox", { status: "ok", files: [photo("/Volumes/Media/Inbox", "new.png")] });
  let changes = 0;
  const stop = followFolderMedia([""], () => changes++);
  await settle();
  assert.deepEqual([...watching.values()], ["/Users/me/Downloads"]);
  const before = changes;
  await setDownloadSettings({ folder: "/Volumes/Media/Inbox" }, "");
  await settle();
  assert.deepEqual([...watching.values()], ["/Volumes/Media/Inbox"]);
  assert.deepEqual(folderListings([""]).map((l) => [l.folder, l.files.map((f) => f.name)]), [["/Volumes/Media/Inbox", ["new.png"]]]);
  assert.ok(changes > before);
  stop();
  folders.set("", "/Users/me/Downloads");
});

test("a listing that fails outright reads as unavailable", async () => {
  const failing = system.listFolderMedia;
  system.listFolderMedia = async () => {
    throw new Error("gone");
  };
  const stop = followFolderMedia([""], () => {});
  await settle();
  assert.deepEqual(folderListings([""]).map((l) => l.status), ["unavailable"]);
  stop();
  system.listFolderMedia = failing;
});

test("a stopped follower ignores folder changes and lists nothing more", async () => {
  const stop = followFolderMedia([""], () => {});
  await settle();
  stop();
  const count = listed.length;
  fireFolderChange();
  await setDownloadSettings({ folder: "/Users/me/Elsewhere" }, "");
  await settle();
  assert.equal(listed.length, count);
  folders.set("", "/Users/me/Downloads");
});

test("folder replies normalize: an engine's bare file list is ok, an unknown reply is unavailable", () => {
  const file = photo("/home/me/Downloads", "a.png");
  assert.deepEqual(folderMediaListing([file]), { status: "ok", files: [file] });
  assert.deepEqual(folderMediaListing({ status: "missing", files: [file] }), { status: "missing", files: [] });
  assert.deepEqual(folderMediaListing({ status: "weird" }), { status: "unavailable", files: [] });
  assert.deepEqual(folderMediaListing(null), { status: "unavailable", files: [] });
});
