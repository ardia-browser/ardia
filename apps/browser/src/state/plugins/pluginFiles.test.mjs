import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { shellNativeModules } from "../../test-native/shell.ts";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";

const dialog = { confirms: [], confirmAnswer: { confirmed: true, suppressed: false }, picks: [], pickAnswer: null, fileAnswer: [], filePicks: 0 };
const shares = [];
let iCloudAvailable = true;

globalThis.acTestNativeModules = {
  ArdiaDialogs: {
    ...shellNativeModules.ArdiaDialogs,
    confirm: async (options) => (dialog.confirms.push(options), await dialog.confirmGate, dialog.confirmAnswer),
    pickFolder: async (current, prompt) => (dialog.picks.push({ current, prompt }), dialog.pickAnswer),
    pickFiles: async () => (dialog.filePicks++, dialog.fileAnswer),
    pickFilesIdentified: async () => {
      dialog.filePicks++;
      const answers = dialog.fileAnswer.map((url) => {
        const path = decodeURIComponent(url.replace(/^file:\/\//, ""));
        const dir = path.slice(0, path.lastIndexOf("/")) || "/";
        const file = stub.pluginFiles.identityOf(dir, path.slice(dir.length + 1));
        const parent = stub.pluginFiles.identities[dir] ?? stub.pluginFiles.folders[dir];
        return file && parent ? { url, ...file, parentDevice: parent.device, parentInode: parent.inode } : { url };
      });
      await dialog.afterPanel?.();
      return answers;
    },
  },
  ArdiaApp: { ...shellNativeModules.ArdiaApp, share: async (url, title, windowId) => void shares.push({ url, title, windowId }) },
  ArdiaSharedFolders: {
    location: () => ({ path: "/icloud/Ardia Shared", iCloudAvailable, iCloudPath: "/icloud" }),
    resolve: async (path) => ({ path, device: 1, inode: 1 }),
    read: async () => ({ exists: true, root: { entries: [], manifest: null, manifestPending: false } }),
    apply: async () => ({ conflicts: [] }),
    watch: () => {},
    addListener: () => ({ remove() {} }),
  },
};

const stub = await import("../../test-native/index.ts");
const { requireNativeModule } = await import("../../test-native/expo.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated } = await import("./activation.ts");
const { settledStops, restartProcess } = await import("./process.ts");
const { consentLines } = await import("./consent.ts");
const { parsePluginRecords, pluginRecordsJson } = await import("./savedState.ts");
const { pathProblem, base64Problem, FILES_LIMITS, fileWatchCount, pickedFileCount } = await import("./channelFiles.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-files-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const files = stub.pluginFiles;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
let nextId = 0;

const NOTES = { manifest: 2, name: "notes", title: "Notes", main: "dist/index.js", permissions: { storage: true, files: true, folders: true, appleNotes: true } };
const APP = { manifest: 2, name: "appy", title: "Appy", main: "dist/index.js", permissions: { app: true } };
const DATA_ONLY = { manifest: 2, name: "scratch", title: "Scratch", main: "dist/index.js", permissions: { files: true } };
const NOTHING = { manifest: 2, name: "bare", title: "Bare", main: "dist/index.js", permissions: {} };
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const name of Object.keys(P().records)) lifecycle.updateRecord(name, () => null, consentToken());
  for (const key of ["starts", "stops", "replies", "events"]) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: JSON.stringify(doc) }));
  await lifecycle.rescanPlugins(consentToken());
  for (const doc of docs) {
    assert.deepEqual(P().listings[doc.name].problems, [], doc.name);
    assert.ok(lifecycle.requestPluginConsent(doc.name));
    assert.ok(lifecycle.enablePlugin(doc.name, P().consent.hash));
  }
  await settle();
}

function send(name, method, params, run) {
  const id = ++nextId;
  stub.emitPluginLine({ name, run, line: JSON.stringify({ id, method, params }) });
  return id;
}

const replyTo = (id) => host.replies.map((r) => JSON.parse(r.line)).find((r) => r.id === id);

async function ask(name, method, params, run) {
  const id = ++nextId;
  const before = host.replies.length;
  stub.emitPluginLine({ name, run, line: JSON.stringify({ id, method, params }) });
  await settle();
  const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.ok(reply, `a reply to ${method}`);
  return reply;
}

async function activated(name) {
  const waiting = ensurePluginActivated(name, "test");
  await settle();
  const run = P().processes[name].run;
  assert.deepEqual((await ask(name, "ready", {}, run)).result, { ok: true });
  assert.equal(await waiting, run);
  return run;
}

const stubEmitGone = (id) => files.emitGone(id);

const changeEvents = (name) => host.events.filter((e) => e.name === name).map((e) => JSON.parse(e.line)).filter((e) => e.event === "files.changed");

beforeEach(() => {
  files.reset();
  takePluginCounts();
  dialog.confirms.length = 0;
  dialog.picks.length = 0;
  dialog.confirmAnswer = { confirmed: true, suppressed: false };
  dialog.pickAnswer = null;
  dialog.fileAnswer = [];
  dialog.filePicks = 0;
  dialog.confirmGate = null;
  parentAt(10);
  files.folders["/Users/me/Dropbox"] = { exists: true, realPath: "/Users/me/Dropbox", location: "other", protected: false, device: 1, inode: 40 };
  files.identities["/Users/me/Dropbox"] = { device: 1, inode: 40 };
  shares.length = 0;
  iCloudAvailable = true;
});

test("the path guard takes relative / paths and refuses everything that could leave the root or fool a reader", () => {
  for (const ok of ["a", "a/b.txt", "docs/ws/dev-1.log", "é/ü", "x".repeat(255), `${"a/".repeat(300)}b`.slice(0, 1023)]) assert.equal(pathProblem(ok), null, ok);
  for (const bad of ["", "/a", "a/", "a//b", ".", "..", "a/../b", "./a", "a/.", "a\u0000b", "a\nb", "a‮b", "a⁦b", "\ud800", "x".repeat(256), "a/".repeat(600) + "b", ".x.ardia-0123", 3, null, {}]) assert.notEqual(pathProblem(bad), null, JSON.stringify(bad));
  assert.equal(pathProblem("", true), null, "list's dir may be the root");
  assert.equal(pathProblem("é".repeat(128)), "each part of path is at most 255 bytes.", "segments count UTF-8 bytes, not characters");
  assert.equal(base64Problem("AAE="), null);
  assert.equal(base64Problem(""), null);
  for (const bad of ["AAE", "A=AE", "AA E=", "AAE==", "****", "AAE=AAE=", 5]) assert.notEqual(base64Problem(bad), null, String(bad));
});

test("files calls need the files permission; a folder root needs folders and a live grant", async () => {
  await enable(NOTES, DATA_ONLY, NOTHING);
  const bare = await activated("bare");
  assert.equal((await ask("bare", "files.read", { path: "a" }, bare)).error.code, "refused");
  assert.equal((await ask("bare", "folders.list", {}, bare)).error.code, "refused");
  const scratch = await activated("scratch");
  assert.deepEqual((await ask("scratch", "files.read", { path: "a" }, scratch)).result, { found: false });
  assert.equal((await ask("scratch", "files.read", { path: "a", root: "f0123456789" }, scratch)).error.code, "refused", "folders isn't granted");
  assert.equal((await ask("scratch", "folders.list", {}, scratch)).error.code, "refused");
  const notes = await activated("notes");
  assert.equal((await ask("notes", "files.read", { path: "a", root: "f0123456789" }, notes)).error.code, "refused", "an unknown grant");
  assert.equal((await ask("notes", "files.read", { path: "a", root: "../etc" }, notes)).error.code, "refused");
  assert.equal((await ask("notes", "files.read", { path: "a", root: 3 }, notes)).error.code, "bad_request");
  assert.equal(files.calls.length, 1, "only the allowed read reached the host");
  assert.ok(takePluginCounts().plugin_file_refusals >= 4);
});

test("read, write, append, list and remove map to the host and back, in the plugin's data root", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  assert.deepEqual((await ask("notes", "files.write", { path: "ws/workspace.json", data: b64("{}"), exclusive: true }, run)).result.size, 2);
  assert.equal(files.text("notes", null, "ws/workspace.json"), "{}");
  assert.equal((await ask("notes", "files.write", { path: "ws/workspace.json", data: b64("{}"), exclusive: true }, run)).error.code, "exists");
  await ask("notes", "files.append", { path: "ws/a.log", data: b64("abc") }, run);
  const appended = await ask("notes", "files.append", { path: "ws/a.log", data: b64("def") }, run);
  assert.equal(appended.result.size, 6);
  const read = (await ask("notes", "files.read", { path: "ws/a.log", offset: 2, length: 3 }, run)).result;
  assert.equal(Buffer.from(read.data, "base64").toString(), "cde");
  assert.equal(read.size, 6);
  assert.equal(typeof read.mtimeMs, "number");
  assert.deepEqual(files.calls.at(-1), { op: "read", plugin: "notes", root: null, ticket: files.calls.at(-1).ticket, path: "ws/a.log", offset: 2, length: 3 });
  assert.equal(Buffer.from((await ask("notes", "files.read", { path: "ws/a.log", offset: 99 }, run)).result.data, "base64").length, 0, "past the end answers no bytes");
  const listed = (await ask("notes", "files.list", { recursive: true }, run)).result.entries;
  assert.deepEqual(listed.map((e) => [e.path, e.kind]).sort(), [["ws", "dir"], ["ws/a.log", "file"], ["ws/workspace.json", "file"]]);
  assert.equal((await ask("notes", "files.list", { dir: "../x" }, run)).error.code, "bad_path");
  assert.deepEqual((await ask("notes", "files.remove", { path: "ws/a.log" }, run)).result, { removed: true });
  assert.deepEqual((await ask("notes", "files.remove", { path: "ws/a.log" }, run)).result, { removed: false });
  const counts = takePluginCounts();
  assert.equal(counts.plugin_file_writes, 3);
  assert.equal(counts.plugin_file_reads, 2);
  assert.equal(counts.plugin_file_refusals, 1, "a bad path counts; exists doesn't");
});

test("sizes stop at 4 MiB a call, before anything reaches the host", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const before = files.calls.length;
  const over = Buffer.alloc(FILES_LIMITS.callBytes + 1).toString("base64");
  assert.equal((await ask("notes", "files.write", { path: "big", data: over }, run)).error.code, "too_large");
  assert.equal((await ask("notes", "files.read", { path: "big", length: FILES_LIMITS.callBytes + 1 }, run)).error.code, "too_large");
  assert.equal((await ask("notes", "files.read", { path: "big", offset: -1 }, run)).error.code, "bad_request");
  assert.equal((await ask("notes", "files.read", { path: "big", length: 1.5 }, run)).error.code, "bad_request");
  assert.equal((await ask("notes", "files.write", { path: "big", data: "not base64" }, run)).error.code, "bad_request");
  assert.equal(files.calls.length, before);
  const full = Buffer.alloc(FILES_LIMITS.callBytes).toString("base64");
  assert.equal((await ask("notes", "files.write", { path: "big", data: full }, run)).result.size, FILES_LIMITS.callBytes, "exactly 4 MiB fits");
});

test("a watch delivers files.changed to its own run, stops at 8, and ends with the run", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const watched = (await ask("notes", "files.watch", {}, run)).result.watch;
  assert.match(watched, /^w[0-9a-f]{16}$/);
  files.emitChange(watched, ["ws/docs/ws/dev.log"]);
  await settle();
  const [event] = changeEvents("notes");
  assert.equal(host.events.at(-1).run, run);
  assert.deepEqual(event.data, { watch: watched, root: "data", paths: ["ws/docs/ws/dev.log"] });
  files.emitChange(watched, ["../escape", "/abs"]);
  await settle();
  assert.equal(changeEvents("notes").length, 1, "paths that aren't relative are never passed on");
  for (let i = 1; i < 8; i++) assert.ok((await ask("notes", "files.watch", {}, run)).result.watch);
  assert.equal((await ask("notes", "files.watch", {}, run)).error.code, "refused", "at most 8 per run");
  assert.deepEqual((await ask("notes", "files.unwatch", { watch: watched }, run)).result, { ok: true });
  assert.equal(files.watches.has(watched), false);
  assert.ok((await ask("notes", "files.watch", {}, run)).result.watch, "unwatching frees a slot");
  restartProcess("notes");
  await settle();
  await settledStops();
  assert.equal(fileWatchCount("notes"), 0, "the run's watches are dropped when it stops");
  assert.equal(files.watches.size, 0, "and the host stops watching");
});

test("folders.create asks first, makes the folder in Ardia Shared, grants it and names a second one <name> 2", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  dialog.confirmAnswer = { confirmed: false, suppressed: false };
  assert.deepEqual((await ask("notes", "folders.create", { name: "Team" }, run)).result, { folder: null });
  assert.equal(dialog.confirms[0].title, "Notes wants to create a shared folder");
  assert.equal(dialog.confirms[0].message, "It makes “Team” in iCloud Drive › Ardia Shared, which you can then share with people. Ardia never deletes it.");
  assert.equal(files.folderCreates.length, 0, "declined makes nothing");
  dialog.confirmAnswer = { confirmed: true, suppressed: false };
  const first = (await ask("notes", "folders.create", { name: "Team" }, run)).result.folder;
  assert.match(first.id, /^f[0-9a-f]{10}$/);
  assert.deepEqual({ ...first, id: "" }, { id: "", name: "Team", location: "other", available: true });
  const second = (await ask("notes", "folders.create", { name: "Team" }, run)).result.folder;
  assert.equal(second.name, "Team 2");
  assert.deepEqual(P().records.notes.folders[first.id].path, "/icloud/Ardia Shared/Team");
  for (const bad of ["", ".hidden", "a/b", "a:b", "x".repeat(101), "a\u0007"]) assert.equal((await ask("notes", "folders.create", { name: bad }, run)).error.code, "bad_request", bad);
  assert.equal(takePluginCounts().plugin_folder_grants, 2);
  await ask("notes", "files.write", { path: "workspace.json", data: b64("{}"), root: first.id }, run);
  assert.equal(files.text("notes", "/icloud/Ardia Shared/Team", "workspace.json"), "{}", "a grant root reaches the granted folder's real path");
});

test("with iCloud Drive off, create asks for a folder to put it in", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  iCloudAvailable = false;
  dialog.pickAnswer = "/Users/me/Dropbox";
  const folder = (await ask("notes", "folders.create", { name: "Shared" }, run)).result.folder;
  assert.equal(dialog.confirms[0].confirmTitle, "Choose Folder…");
  assert.equal(folder.name, "Shared");
  assert.equal(P().records.notes.folders[folder.id].path, "/Users/me/Dropbox/Shared");
});

test("folders.pick grants the picked folder, answers the same grant for it again, and null when cancelled", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  assert.deepEqual((await ask("notes", "folders.pick", { prompt: "Join" }, run)).result, { folder: null });
  assert.deepEqual(dialog.picks[0], { current: "/icloud/Ardia Shared", prompt: "Join" });
  dialog.pickAnswer = "/icloud/Ardia Shared/Theirs";
  files.folders["/icloud/Ardia Shared/Theirs"] = { exists: true, realPath: "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Ardia Shared/Theirs", location: "icloud", protected: false, device: 1, inode: 501 };
  const picked = (await ask("notes", "folders.pick", {}, run)).result.folder;
  assert.equal(dialog.picks[1].prompt, "Choose");
  assert.deepEqual({ ...picked, id: "" }, { id: "", name: "Theirs", location: "icloud", available: true });
  assert.equal(P().records.notes.folders[picked.id].path, "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Ardia Shared/Theirs", "the grant keeps the real path");
  assert.equal((await ask("notes", "folders.pick", {}, run)).result.folder.id, picked.id, "the same folder answers the existing grant");
  assert.equal(Object.keys(P().records.notes.folders).length, 1);
  assert.equal((await ask("notes", "folders.pick", { prompt: "x".repeat(41) }, run)).error.code, "bad_request");
  dialog.pickAnswer = "/config/plugins/notes";
  assert.equal((await ask("notes", "folders.pick", {}, run)).error.code, "refused", "Ardia's own folders can't be granted");
  dialog.pickAnswer = "/Users/me";
  files.folders["/Users/me"] = { exists: true, realPath: "/Users/me", location: "other", protected: true };
  assert.equal((await ask("notes", "folders.pick", {}, run)).error.code, "refused", "a folder native calls protected can't be granted");
});

test("folders list, share and forget; forgetting drops the grant's watches", async () => {
  await enable(NOTES);
  const windowId = S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  const folder = (await ask("notes", "folders.create", { name: "Team" }, run)).result.folder;
  const path = P().records.notes.folders[folder.id].path;
  assert.deepEqual((await ask("notes", "folders.list", {}, run)).result.folders, [folder]);
  const shown = files.folders[path];
  files.folders[path] = { ...shown, exists: false };
  assert.equal((await ask("notes", "folders.list", {}, run)).result.folders[0].available, false, "a missing folder is listed as unavailable");
  assert.deepEqual((await ask("notes", "folders.share", { id: folder.id }, run)).result, { ok: false }, "a missing folder isn't shared");
  files.folders[path] = shown;
  assert.deepEqual((await ask("notes", "folders.share", { id: folder.id }, run)).result, { ok: true });
  assert.deepEqual(shares.at(-1), { url: "file:///icloud/Ardia%20Shared/Team/", title: "Team", windowId });
  assert.equal((await ask("notes", "folders.share", { id: "f9999999999" }, run)).error.code, "refused");
  const watched = (await ask("notes", "files.watch", { root: folder.id }, run)).result.watch;
  assert.deepEqual({ ...files.watches.get(watched), rootIdentity: undefined }, { plugin: "notes", root: path, rootIdentity: undefined });
  assert.deepEqual((await ask("notes", "folders.forget", { id: folder.id }, run)).result, { ok: true });
  assert.equal(files.watches.has(watched), false, "its watch stopped");
  assert.equal(P().records.notes.folders, undefined);
  assert.equal((await ask("notes", "files.read", { path: "a", root: folder.id }, run)).error.code, "refused", "a forgotten grant reaches nothing");
  assert.equal(takePluginCounts().plugin_folder_shares, 1);
});

test("no folder dialog opens without a normal window: a private window never asks", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/", kind: "private" });
  const run = await activated("notes");
  const answered = await ask("notes", "folders.create", { name: "Team" }, run);
  assert.deepEqual(Object.values(S().windows).map((w) => w.kind), ["private"]);
  assert.equal(answered.error.code, "no_window");
  assert.equal((await ask("notes", "folders.pick", {}, run)).error.code, "no_window");
  assert.equal(dialog.confirms.length + dialog.picks.length, 0);
});

test("grants survive plugins.json, re-approval and turning off, and go with the record", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  const folder = (await ask("notes", "folders.create", { name: "Team" }, run)).result.folder;
  const round = parsePluginRecords(pluginRecordsJson(P().records));
  assert.deepEqual(round.notes.folders, P().records.notes.folders);
  assert.equal(parsePluginRecords(JSON.stringify({ version: 1, plugins: { notes: { ...round.notes, folders: { bad: { name: "x", path: "/x" }, f0123456789: { name: "y", path: "relative" } } } } })).notes.folders, undefined, "malformed grants are dropped");
  lifecycle.disablePlugin("notes", consentToken());
  assert.ok(P().records.notes.folders[folder.id], "turning off keeps grants");
  assert.ok(lifecycle.requestPluginConsent("notes"));
  assert.ok(lifecycle.enablePlugin("notes", P().consent.hash));
  assert.ok(P().records.notes.folders[folder.id], "approving again keeps grants");
  await settledStops();
  const removed = await lifecycle.removePlugin("notes");
  assert.equal(removed.ok, true, removed.reason);
  assert.equal(P().records.notes, undefined, "removing the plugin drops its record and grants");
  assert.ok(files.folders["/icloud/Ardia Shared/Team"]?.exists, "Ardia never deletes the folder");
  assert.equal(host.removed.at(-1), "notes");
});

test("the consent sheet names files and folders in the contract's words", async () => {
  await enable(NOTES);
  const texts = consentLines(P().listings.notes.manifest).map((l) => l.text);
  assert.ok(texts.includes("Keeps its own files on this Mac"));
  assert.ok(texts.includes("Reads and writes folders you choose, like a shared folder in iCloud Drive"));
});

test("a run that exits on its own drops its watches at once, even ones that never fired", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const quiet = (await ask("notes", "files.watch", {}, run)).result.watch;
  assert.ok(files.watches.has(quiet));
  stub.emitPluginExit({ name: "notes", run, status: 0, signal: null, overMemory: false });
  await settle();
  assert.equal(fileWatchCount("notes"), 0);
  assert.equal(files.watches.has(quiet), false, "the host stops watching too");
});

test("with iCloud Drive off, create refuses a protected parent before it makes anything", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  iCloudAvailable = false;
  dialog.pickAnswer = "/Users/me";
  files.protectedRoots.add("/Users/me");
  assert.equal((await ask("notes", "folders.create", { name: "Shared" }, run)).error.code, "refused");
  dialog.pickAnswer = "/config/plugins";
  assert.equal((await ask("notes", "folders.create", { name: "Shared" }, run)).error.code, "refused");
  assert.deepEqual(files.folderCreates, [], "no folder was made in either");
});

test("a grant is to the folder itself: one replaced at the same path is unavailable, and an old grant learns its folder at first use", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  const path = "/icloud/Ardia Shared/Team";
  const folder = (await ask("notes", "folders.create", { name: "Team" }, run)).result.folder;
  const kept = files.identities[path];
  assert.deepEqual([P().records.notes.folders[folder.id].device, P().records.notes.folders[folder.id].inode], [kept.device, kept.inode], "the grant keeps the folder's identity");
  await ask("notes", "files.write", { path: "a", data: "AAE=", root: folder.id }, run);
  assert.deepEqual(files.calls.at(-1).rootIdentity, kept);
  files.identities[path] = { device: 1, inode: 99 };
  files.folders[path] = { ...files.folders[path], inode: 99 };
  assert.equal((await ask("notes", "files.read", { path: "a", root: folder.id }, run)).error.code, "unavailable", "a different folder at that path isn't reached");
  assert.equal((await ask("notes", "files.watch", { root: folder.id }, run)).error.code, "unavailable");
  assert.equal((await ask("notes", "folders.list", {}, run)).result.folders[0].available, false);
  assert.deepEqual((await ask("notes", "folders.share", { id: folder.id }, run)).result, { ok: false });
  dialog.pickAnswer = path;
  const repicked = (await ask("notes", "folders.pick", {}, run)).result.folder;
  assert.deepEqual([repicked.id, repicked.available, P().records.notes.folders[folder.id].inode], [folder.id, true, 99], "picking the new folder yourself moves the grant to it");
  assert.ok((await ask("notes", "files.read", { path: "a", root: folder.id }, run)).result, "the moved grant reaches the folder again");
  const old = "/elsewhere/Old";
  files.identities[old] = { device: 2, inode: 5 };
  lifecycle.updateRecord("notes", (r) => ({ ...r, folders: { ...r.folders, f00000000aa: { name: "Old", path: old, location: "other", addedAt: 1 } } }), consentToken());
  await ask("notes", "files.read", { path: "a", root: "f00000000aa" }, run);
  assert.deepEqual(files.calls.at(-1).rootIdentity, { device: 2, inode: 5 }, "a grant saved without its identity gets it at first use");
  assert.deepEqual([P().records.notes.folders.f00000000aa.device, P().records.notes.folders.f00000000aa.inode], [2, 5]);
});

test("forgetting a grant revokes that root's queued work, and a run ending revokes the plugin's", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  const folder = (await ask("notes", "folders.create", { name: "Team" }, run)).result.folder;
  await ask("notes", "folders.forget", { id: folder.id }, run);
  assert.deepEqual(files.revokes.at(-1), { plugin: "notes", root: "/icloud/Ardia Shared/Team" });
  stub.emitPluginExit({ name: "notes", run, status: 0, signal: null, overMemory: false });
  await settle();
  assert.deepEqual(files.revokes.at(-1), { plugin: "notes", root: null });
});

test("turning a running plugin off revokes its queued file work", async () => {
  await enable(NOTES);
  await activated("notes");
  lifecycle.disablePlugin("notes", consentToken());
  await settle();
  assert.deepEqual(files.revokes.at(-1), { plugin: "notes", root: null });
});

const pluginsModule = requireNativeModule("ArdiaPlugins");

function gateFolderInfo() {
  const real = pluginsModule.pluginFolderInfo;
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  pluginsModule.pluginFolderInfo = async (path) => (await gate, real(path));
  return () => {
    pluginsModule.pluginFolderInfo = real;
    open();
  };
}

const legacyGrant = (path) => lifecycle.updateRecord("notes", (r) => ({ ...r, folders: { ...(r.folders ?? {}), f00000000bb: { name: "Old", path, location: "other", addedAt: 1 } } }), consentToken());

test("F5: a legacy grant whose folder can't be identified reaches nothing", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  legacyGrant("/elsewhere/Unknown");
  const before = files.calls.length;
  assert.equal((await ask("notes", "files.read", { path: "a", root: "f00000000bb" }, run)).error.code, "unavailable");
  assert.equal((await ask("notes", "files.watch", { root: "f00000000bb" }, run)).error.code, "unavailable");
  assert.equal(files.calls.length, before, "no call went to the host without the folder's identity");
  assert.equal(files.watches.size, 0);
});

test("F5: a grant forgotten, or a run ended, while its folder is looked up reaches nothing", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  files.identities["/elsewhere/Old"] = { device: 3, inode: 7 };
  legacyGrant("/elsewhere/Old");
  const before = files.calls.length;
  let release = gateFolderInfo();
  const forgotten = send("notes", "files.read", { path: "a", root: "f00000000bb" }, run);
  await settle();
  await ask("notes", "folders.forget", { id: "f00000000bb" }, run);
  release();
  await settle();
  assert.equal(replyTo(forgotten).error.code, "refused");
  legacyGrant("/elsewhere/Old");
  release = gateFolderInfo();
  const ended = send("notes", "files.write", { path: "a", data: "AAE=", root: "f00000000bb" }, run);
  await settle();
  restartProcess("notes");
  release();
  await settle();
  assert.ok(!replyTo(ended) || replyTo(ended).error?.code === "refused", "the ended run's write is refused");
  assert.equal(files.calls.length, before, "neither call reached the host");
});

test("every folder answer that waited on the disk checks again that the plugin may still have it", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  dialog.pickAnswer = "/picked/Late";
  const release = gateFolderInfo();
  const picking = send("notes", "folders.pick", {}, run);
  await settle();
  lifecycle.disablePlugin("notes", consentToken());
  release();
  await settle();
  assert.equal(P().records.notes.folders, undefined, "nothing was granted to a plugin turned off meanwhile");
  assert.ok(picking);
});

test("F4: create makes the folder in the parent it checked, and grants what native made, not what a later lookup finds", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  files.folders["/icloud/Ardia Shared"] = { exists: true, realPath: "/icloud/Ardia Shared", location: "icloud", protected: false, device: 1, inode: 10 };
  files.identities["/icloud/Ardia Shared"] = { device: 1, inode: 10 };
  const real = pluginsModule.pluginFolderInfo;
  pluginsModule.pluginFolderInfo = async (path) => (path.endsWith("/Fresh") ? { exists: true, realPath: path, location: "other", protected: false, device: 9, inode: 999 } : real(path));
  try {
    const folder = (await ask("notes", "folders.create", { name: "Fresh" }, run)).result.folder;
    assert.deepEqual(files.folderCreates.at(-1), { parent: "/icloud/Ardia Shared", parentIdentity: { device: 1, inode: 10 }, name: "Fresh" });
    const saved = P().records.notes.folders[folder.id];
    assert.deepEqual([saved.path, saved.device, saved.inode], ["/icloud/Ardia Shared/Fresh", 1, files.identities["/icloud/Ardia Shared/Fresh"].inode]);
  } finally {
    pluginsModule.pluginFolderInfo = real;
  }
  files.identities["/icloud/Ardia Shared"] = { device: 1, inode: 11 };
  assert.equal((await ask("notes", "folders.create", { name: "Swapped" }, run)).error.code, "unavailable", "a parent swapped after the check gets nothing made in it");
  assert.equal(Object.keys(P().records.notes.folders).length, 1);
});

test("F5: every file call carries the ticket taken when it arrived, so a revoke while it waits refuses it natively", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  await ask("notes", "files.write", { path: "a", data: "AAE=" }, run);
  assert.equal(typeof files.calls.at(-1).ticket, "number");
  files.identities["/elsewhere/Old"] = { device: 3, inode: 7 };
  legacyGrant("/elsewhere/Old");
  const release = gateFolderInfo();
  const waiting = send("notes", "files.read", { path: "a", root: "f00000000bb" }, run);
  await settle();
  const ticketBefore = files.generation;
  stub.pluginFiles.revokedAt["notes\u0000/elsewhere/Old"] = ++files.generation;
  release();
  await settle();
  const sent = files.calls.at(-1);
  assert.ok(sent.root !== "/elsewhere/Old" || sent.ticket === ticketBefore, "the ticket is the one from before the wait");
  assert.equal(replyTo(waiting).error.code, "refused");
});

const ARDIA_SHARED = "/icloud/Ardia Shared";
const parentAt = (inode, realPath = ARDIA_SHARED) => {
  files.folders[ARDIA_SHARED] = { exists: true, realPath, location: "icloud", protected: false, device: 1, inode };
  files.identities[realPath] = { device: 1, inode };
};

test("#4: the parent is the one checked before the confirm; one swapped while it's open gets nothing made in it", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  parentAt(10);
  let accept;
  dialog.confirmGate = new Promise((resolve) => (accept = resolve));
  const asked = send("notes", "folders.create", { name: "Team" }, run);
  await settle();
  assert.equal(dialog.confirms.length, 1, "the confirm is open");
  parentAt(11);
  accept();
  await settle();
  assert.ok(["unavailable", "refused"].includes(replyTo(asked).error?.code), JSON.stringify(replyTo(asked)));
  assert.deepEqual(files.folderCreates.map((c) => c.parentIdentity), [{ device: 1, inode: 10 }], "native was handed the identity seen before the confirm");
  assert.equal(P().records.notes.folders, undefined);
});

test("#4: a parent that is a link is refused before anything is asked", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  parentAt(10, "/somewhere/else");
  assert.equal((await ask("notes", "folders.create", { name: "Team" }, run)).error.code, "refused");
  assert.equal(dialog.confirms.length, 0);
  assert.equal(files.folderCreates.length, 0);
});

test("#4: with iCloud Drive off, the picked parent's identity is taken at the pick and handed to native as is", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  iCloudAvailable = false;
  dialog.pickAnswer = "/Users/me/Dropbox";
  files.folders["/Users/me/Dropbox"] = { exists: true, realPath: "/Users/me/Dropbox", location: "other", protected: false, device: 1, inode: 40 };
  files.identities["/Users/me/Dropbox"] = { device: 1, inode: 40 };
  await ask("notes", "folders.create", { name: "Shared" }, run);
  assert.deepEqual(files.folderCreates.at(-1), { parent: "/Users/me/Dropbox", parentIdentity: { device: 1, inode: 40 }, name: "Shared" });
  dialog.pickAnswer = "/Users/me/Linked";
  files.folders["/Users/me/Linked"] = { exists: true, realPath: "/Users/me/Dropbox", location: "other", protected: false, device: 1, inode: 40 };
  assert.equal((await ask("notes", "folders.create", { name: "Other" }, run)).error.code, "refused", "a picked link is refused");
});

test("#4b: a watch whose root went away is delivered once as gone and stops counting against the run's 8", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push((await ask("notes", "files.watch", {}, run)).result.watch);
  assert.equal((await ask("notes", "files.watch", {}, run)).error.code, "refused");
  stub.pluginFiles.watches.delete(ids[0]);
  stubEmitGone(ids[0]);
  await settle();
  const gone = changeEvents("notes").filter((e) => e.data.watch === ids[0]);
  assert.deepEqual(gone.map((e) => e.data), [{ watch: ids[0], root: "data", paths: [], gone: true }]);
  const goneLine = host.events.find((e) => e.name === "notes" && e.line.includes('"gone":true'));
  assert.equal(goneLine.notice, true, "codex S6: the terminal gone goes in the channel's notice reserve, never dropped and never retiring it");
  assert.equal(fileWatchCount("notes"), 7);
  assert.ok((await ask("notes", "files.watch", {}, run)).result.watch, "a 9th watch fits once one is gone");
  stubEmitGone(ids[0]);
  await settle();
  assert.equal(changeEvents("notes").filter((e) => e.data.watch === ids[0]).length, 1, "gone is said once");
});

const parentAbsent = () => {
  delete files.folders[ARDIA_SHARED];
  delete files.identities[ARDIA_SHARED];
  files.missingRoots.add(ARDIA_SHARED);
  files.identities["/icloud"] = { device: 1, inode: 5 };
};

test("#5: with Ardia Shared absent, native makes it under the grandparent checked before the confirm", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  parentAbsent();
  const folder = (await ask("notes", "folders.create", { name: "Team" }, run)).result.folder;
  assert.equal(folder.name, "Team");
  assert.deepEqual(files.folderCreates.at(-1), { parent: ARDIA_SHARED, parentIdentity: null, name: "Team", grandparentIdentity: { device: 1, inode: 5 } });
  assert.equal(P().records.notes.folders[folder.id].path, `${ARDIA_SHARED}/Team`);
});

test("#5: an Ardia Shared that appears while the confirm is open gets nothing made in it and nothing granted", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  parentAbsent();
  let accept;
  dialog.confirmGate = new Promise((resolve) => (accept = resolve));
  const asked = send("notes", "folders.create", { name: "Team" }, run);
  await settle();
  assert.equal(dialog.confirms.length, 1, "the confirm is open");
  files.missingRoots.delete(ARDIA_SHARED);
  files.identities[ARDIA_SHARED] = { device: 1, inode: 77 };
  accept();
  await settle();
  assert.equal(replyTo(asked).error?.code, "unavailable", JSON.stringify(replyTo(asked)));
  assert.equal(files.identities[`${ARDIA_SHARED}/Team`], undefined, "nothing was made in the folder that appeared");
  assert.equal(P().records.notes.folders, undefined);
});

test("#5: an absent Ardia Shared under a grandparent that is a link or protected is refused before the confirm", async () => {
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  parentAbsent();
  files.folders["/icloud"] = { exists: true, realPath: "/elsewhere", location: "other", protected: false, device: 1, inode: 5 };
  assert.equal((await ask("notes", "folders.create", { name: "Team" }, run)).error.code, "refused");
  files.folders["/icloud"] = { exists: true, realPath: "/icloud", location: "icloud", protected: true, device: 1, inode: 5 };
  assert.equal((await ask("notes", "folders.create", { name: "Team" }, run)).error.code, "refused");
  assert.equal(dialog.confirms.length, 0);
  assert.equal(files.folderCreates.length, 0);
});

async function askLong(name, method, params, run) {
  const id = send(name, method, params, run);
  for (let i = 0; i < 200 && !replyTo(id); i++) await tick();
  const reply = replyTo(id);
  assert.ok(reply, `a reply to ${method}`);
  return reply;
}

test("files.pick gives read access to the picked file alone, for this run, and needs only files", async () => {
  await enable(DATA_ONLY);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("scratch");
  assert.deepEqual((await askLong("scratch", "files.pick", {}, run)).result, { files: [] }, "cancelled");
  files.folders["/Users/me/Downloads"] = { exists: true, realPath: "/Users/me/Downloads", location: "other", protected: false, device: 1, inode: 77 };
  files.identities["/Users/me/Downloads"] = { device: 1, inode: 77 };
  files.put("scratch", "/Users/me/Downloads", "Export é.zip", "PK-zip-bytes");
  files.put("scratch", "/Users/me/Downloads", "other.txt", "secret");
  dialog.fileAnswer = ["file:///Users/me/Downloads/Export%20%C3%A9.zip", "file:///Users/me/Downloads/other.txt"];
  const one = (await askLong("scratch", "files.pick", {}, run)).result.files;
  assert.equal(one.length, 1, "one file unless multiple");
  assert.match(one[0].id, /^p[0-9a-f]{10}$/);
  assert.deepEqual({ name: one[0].name, size: one[0].size }, { name: "Export é.zip", size: 12 });
  const read = (await askLong("scratch", "files.read", { path: "Export é.zip", root: one[0].id }, run)).result;
  assert.equal(Buffer.from(read.data, "base64").toString(), "PK-zip-bytes");
  assert.equal((await askLong("scratch", "files.read", { path: "other.txt", root: one[0].id }, run)).error.code, "refused", "nothing beside it");
  assert.equal((await askLong("scratch", "files.list", { root: one[0].id }, run)).error.code, "refused");
  assert.equal((await askLong("scratch", "files.write", { path: "Export é.zip", data: "AAE=", root: one[0].id }, run)).error.code, "refused");
  assert.equal((await askLong("scratch", "files.remove", { path: "Export é.zip", root: one[0].id }, run)).error.code, "refused");
  const both = (await askLong("scratch", "files.pick", { multiple: true }, run)).result.files;
  assert.deepEqual(both.map((f) => f.name), ["Export é.zip", "other.txt"]);
  assert.equal(takePluginCounts().plugin_file_picks, 3);
  assert.equal((await askLong("scratch", "files.pick", { multiple: "yes" }, run)).error.code, "bad_request");
  dialog.fileAnswer = ["file:///config/plugins/scratch/dist/index.js"];
  files.folders["/config/plugins/scratch/dist"] = { exists: true, realPath: "/config/plugins/scratch/dist", location: "other", protected: false, device: 1, inode: 78 };
  assert.equal((await askLong("scratch", "files.pick", {}, run)).error.code, "refused", "Ardia's own files can't be picked");
  dialog.fileAnswer = ["file:///Users/me/notes.md"];
  files.folders["/Users/me"] = { exists: true, realPath: "/Users/me", location: "other", protected: true, device: 1, inode: 2 };
  assert.equal((await askLong("scratch", "files.pick", {}, run)).error.code, "refused", "a file right in the home folder isn't given");
  assert.ok(pickedFileCount("scratch") > 0);
  stub.emitPluginExit({ name: "scratch", run, status: 0, signal: null, overMemory: false });
  await settle();
  assert.equal(pickedFileCount("scratch"), 0, "a pick ends with its run");
});

test("files.pick needs the files permission and a normal window", async () => {
  await enable(NOTHING);
  const run = await activated("bare");
  assert.equal((await ask("bare", "files.pick", {}, run)).error.code, "refused");
  assert.equal(dialog.filePicks, 0);
});

test("files.pick turns whatever the open panel answers into plain names in a checked folder, or nothing", async () => {
  await enable(DATA_ONLY);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("scratch");
  files.folders["/Users/me/Downloads"] = { exists: true, realPath: "/Users/me/Downloads", location: "other", protected: false, device: 1, inode: 77 };
  files.identities["/Users/me/Downloads"] = { device: 1, inode: 77 };
  for (const { value } of HOSTILE_VALUES) {
    const name = typeof value === "string" ? value : "x";
    files.put("scratch", "/Users/me/Downloads", "plain.zip", "x");
    let encoded = name;
    try {
      encoded = encodeURIComponent(name);
    } catch {}
    dialog.fileAnswer = [value, `file:///Users/me/Downloads/${encoded}`, `file:///Users/me/Downloads/${name}`, "file:///Users/me/Downloads/plain.zip"];
    const reply = await askLong("scratch", "files.pick", { multiple: true }, run);
    for (const f of reply.result?.files ?? []) {
      assert.equal(pathProblem(f.name), null, JSON.stringify(f.name));
      assert.ok(!f.name.includes("/"), JSON.stringify(f.name));
    }
  }
  for (const spec of files.calls) {
    assert.equal(spec.root, "/Users/me/Downloads", JSON.stringify(spec));
    assert.equal(pathProblem(spec.path), null, JSON.stringify(spec));
  }
});

test("app.controlStatus says whether the Command Line plugin and program control are on, with the app permission", async () => {
  await enable(APP);
  const run = await activated("appy");
  S().updateSettings({ cliControl: false });
  assert.deepEqual((await askLong("appy", "app.controlStatus", {}, run)).result, { command: false, control: false });
  S().updateSettings({ cliControl: true });
  assert.deepEqual((await askLong("appy", "app.controlStatus", {}, run)).result, { command: false, control: true });
  S().updateSettings({ cliControl: false });
});

test("app.openSettings opens only the Plugins or Advanced pane, with a window, at most every 2 s, with the app permission", async () => {
  await enable(APP);
  const run = await activated("appy");
  const { useSettingsNav } = await import("../settings/settingsWindows.ts");
  assert.equal((await askLong("appy", "app.openSettings", { pane: "advanced" }, run)).error.code, "no_window");
  S().createWindow({ url: "https://a.example/" });
  assert.deepEqual((await askLong("appy", "app.openSettings", { pane: "advanced" }, run)).result, { ok: true });
  assert.equal(useSettingsNav.getState().pane, "advanced");
  assert.equal((await askLong("appy", "app.openSettings", { pane: "plugins" }, run)).error.code, "refused", "too soon after the last");
  for (const { value } of HOSTILE_VALUES) assert.equal((await askLong("appy", "app.openSettings", { pane: value }, run)).error.code, "bad_request");
  assert.equal((await askLong("appy", "app.openSettings", { pane: "general" }, run)).error.code, "bad_request");
  assert.equal(useSettingsNav.getState().pane, "advanced", "nothing hostile moved Settings");
  assert.ok(takePluginCounts().plugin_settings_opens >= 1);
});

test("codex S3: the app calls need the app permission", async () => {
  await enable(NOTHING);
  const run = await activated("bare");
  for (const [method, params] of [["app.controlStatus", {}], ["app.openSettings", { pane: "plugins" }], ["app.icon", { path: "/System/Applications/Notes.app" }]])
    assert.equal((await askLong("bare", method, params, run)).error.code, "refused", method);
});

test("app.icon gives an app's icon only for apps in /Applications or /System/Applications", async () => {
  await enable(APP);
  const run = await activated("appy");
  assert.equal((await askLong("appy", "app.icon", { path: "/System/Applications/Notes.app", size: 64 }, run)).result.icon, "data:image/png;base64,iVBORw0KGgo=");
  for (const path of ["/Users/me/secret.app", "/Applications/../Users/me/x.app", "/Applications/Notes", "/System/Applications/Notes.app/Contents/Info.plist", "Applications/X.app", "/Applications/a/b/c/d.app"])
    assert.equal((await askLong("appy", "app.icon", { path }, run)).error.code, "bad_request", path);
  for (const { value } of HOSTILE_VALUES) assert.equal((await askLong("appy", "app.icon", { path: value }, run)).error.code, "bad_request");
  assert.equal((await askLong("appy", "app.icon", { path: "/Applications/X.app", size: 4096 }, run)).error.code, "bad_request");
});

test("appleNotes reads only after Ardia's own consent sheet, for that run, with whatever Notes answers cleaned", async () => {
  const { appleNotesFake } = stub;
  appleNotesFake.reset();
  await enable(NOTES);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("notes");
  assert.equal((await askLong("notes", "appleNotes.folders", {}, run)).error.code, "refused", "nothing before the sheet");
  assert.equal(appleNotesFake.calls.length, 0);
  dialog.confirmAnswer = { confirmed: false, suppressed: false };
  assert.deepEqual((await askLong("notes", "appleNotes.request", {}, run)).result, { granted: false });
  assert.match(dialog.confirms.at(-1).title, /Notes wants to read your Apple Notes/);
  assert.equal((await askLong("notes", "appleNotes.folders", {}, run)).error.code, "refused");
  dialog.confirmAnswer = { confirmed: true, suppressed: false };
  assert.deepEqual((await askLong("notes", "appleNotes.request", {}, run)).result, { granted: true });
  appleNotesFake.folders = [{ id: "x-coredata://F1", name: "Work", account: "iCloud", parent: "", count: 2 }];
  appleNotesFake.notes["x-coredata://F1"] = [
    { id: "n1", name: "Plan", created: 1, modified: 2, locked: false, body: "<div>Hi</div>" },
    { id: "n2", name: "Secret", created: 1, modified: 2, locked: true, body: "should not pass" },
  ];
  assert.deepEqual((await askLong("notes", "appleNotes.folders", {}, run)).result.folders, appleNotesFake.folders);
  const page = (await askLong("notes", "appleNotes.notes", { folder: "x-coredata://F1", offset: 0, limit: 50 }, run)).result;
  assert.equal(page.total, 2);
  assert.equal(page.notes[1].body, "", "a locked note's body never reaches the plugin");
  assert.equal((await askLong("notes", "appleNotes.notes", { folder: "x", limit: 201 }, run)).error.code, "bad_request");
  appleNotesFake.raw = JSON.stringify({ total: "lots", notes: [{ id: 3 }, { id: "ok", name: { toString: 1 }, created: -5, body: 7 }, null] });
  assert.deepEqual((await askLong("notes", "appleNotes.notes", { folder: "x" }, run)).result, { total: 0, notes: [{ id: "ok", name: "", created: 0, modified: 0, locked: true, body: "" }] });
  appleNotesFake.raw = JSON.stringify({ total: 1, notes: [{ id: "u", name: "Unknown", body: "<div>maybe locked</div>" }, { id: "o", name: "Open", locked: false, body: "<div>open</div>" }] });
  const unknown = (await askLong("notes", "appleNotes.notes", { folder: "x" }, run)).result.notes;
  assert.equal(unknown[0].body, "", "codex S3: a note whose locked status is unknown is skipped");
  assert.equal(unknown[1].body, "<div>open</div>", "positive control");
  appleNotesFake.raw = "not json";
  assert.equal((await askLong("notes", "appleNotes.folders", {}, run)).error.code, "failed");
  appleNotesFake.raw = null;
  appleNotesFake.failCode = -1743;
  assert.match((await askLong("notes", "appleNotes.folders", {}, run)).error.message, /Privacy & Security › Automation/);
  appleNotesFake.failCode = 0;
  const counts = takePluginCounts();
  assert.equal(counts.plugin_apple_notes_asks, 2);
  assert.equal(counts.plugin_apple_notes_allowed, 1);
  stub.emitPluginExit({ name: "notes", run, status: 0, signal: null, overMemory: false });
  await settle();
  appleNotesFake.reset();
});

test("codex S2: a picked file is bound to the file itself, so another file put at its name can't be read through the pick", async () => {
  await enable(DATA_ONLY);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("scratch");
  files.folders["/Users/me/Downloads"] = { exists: true, realPath: "/Users/me/Downloads", location: "other", protected: false, device: 1, inode: 77 };
  files.identities["/Users/me/Downloads"] = { device: 1, inode: 77 };
  files.put("scratch", "/Users/me/Downloads", "export.zip", "picked");
  dialog.fileAnswer = ["file:///Users/me/Downloads/export.zip"];
  const [one] = (await askLong("scratch", "files.pick", {}, run)).result.files;
  assert.equal(Buffer.from((await askLong("scratch", "files.read", { path: "export.zip", root: one.id }, run)).result.data, "base64").toString(), "picked", "positive control");
  files.put("scratch", "/Users/me/Downloads", "export.zip", "swapped in later");
  assert.equal((await askLong("scratch", "files.read", { path: "export.zip", root: one.id }, run)).error.code, "refused");
  assert.ok(files.calls.at(-1).fileIdentity, "the read carries the picked file's identity");
});

test("codex S3: Apple Notes needs the appleNotes permission, and its sheet says so when the plugin can reach the network", async () => {
  const { appleNotesFake } = stub;
  appleNotesFake.reset();
  await enable({ ...NOTES, name: "plain", permissions: { files: true } });
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("plain");
  assert.equal((await askLong("plain", "appleNotes.request", {}, run)).error.code, "refused");
  const { appleNotesDisclosure } = await import("./channelAppleNotes.ts");
  const { readManifest } = await import("../../lib/pluginManifest.ts");
  const offline = readManifest(JSON.stringify(NOTES)).manifest;
  assert.match(appleNotesDisclosure(offline), /Nothing is sent anywhere/);
  const online = readManifest(JSON.stringify({ ...NOTES, permissions: { ...NOTES.permissions, sites: ["app.notion.com"] } })).manifest;
  assert.doesNotMatch(appleNotesDisclosure(online), /Nothing is sent anywhere/);
  assert.match(appleNotesDisclosure(online), /app\.notion\.com/);
  const any = readManifest(JSON.stringify({ ...NOTES, permissions: { ...NOTES.permissions, network: "*" } })).manifest;
  assert.match(appleNotesDisclosure(any), /the internet/);
  const tabs = readManifest(JSON.stringify({ ...NOTES, permissions: { ...NOTES.permissions, tabs: "write" } })).manifest;
  assert.match(appleNotesDisclosure(tabs), /web pages it opens in your tabs/, "codex round 2 S3: tabs write is a way out too");
  assert.doesNotMatch(appleNotesDisclosure(tabs), /Nothing is sent anywhere/);
  const commands = readManifest(JSON.stringify({ ...NOTES, permissions: { ...NOTES.permissions, commands: true } })).manifest;
  assert.match(appleNotesDisclosure(commands), /web pages it opens/);
});

test("codex round 2 S2: a pick is bound to the identity the panel saw when you chose, not to what a later probe finds", async () => {
  await enable(DATA_ONLY);
  S().createWindow({ url: "https://a.example/" });
  const run = await activated("scratch");
  files.folders["/Users/me/Downloads"] = { exists: true, realPath: "/Users/me/Downloads", location: "other", protected: false, device: 1, inode: 77 };
  files.identities["/Users/me/Downloads"] = { device: 1, inode: 77 };
  files.put("scratch", "/Users/me/Downloads", "chosen.zip", "the one you chose");
  dialog.fileAnswer = ["file:///Users/me/Downloads/chosen.zip"];
  dialog.afterPanel = () => files.put("scratch", "/Users/me/Downloads", "chosen.zip", "swapped in before the probe");
  assert.equal((await askLong("scratch", "files.pick", {}, run)).error.code, "refused", "a file swapped between the panel and the probe isn't given");
  dialog.afterPanel = null;
  const [one] = (await askLong("scratch", "files.pick", {}, run)).result.files;
  assert.ok(one, "positive control: an unchanged file is given");
  dialog.fileAnswer = [];
});
