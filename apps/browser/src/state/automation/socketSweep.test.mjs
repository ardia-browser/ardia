import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { pinKeyOf } = await import("../browser/model.ts");
const { bindFolder, unbindFolder } = await import("../sharedFolders/store.ts");
const { confirmRemovingShared, sharedFolderOfGroup } = await import("../sharedFolders/removal.ts");
const { guardGroupClose, keepGroupsOpen } = await import("../groups/closeGuard.ts");
const { useLive, setAccount, live } = await import("../live/store.ts");
const { SOURCES } = await import("../live/sources.ts");
const { useAirTraffic } = await import("../airTraffic/store.ts");
const { methodsCatalog } = await import("./socketCatalog.ts");
const { registerSocketAreas } = await import("./socketAreas.ts");
const { automationCommands } = await import("./automationCommands.ts");
const { changesSharedFolders } = await import("./socketSharedChokePoint.ts");
const { encodeSetupCode } = await import("../presets/setupCode.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));
guardGroupClose(confirmRemovingShared);
keepGroupsOpen((groupId) => !!sharedFolderOfGroup(S(), groupId));
SOURCES.github.fetch = async () => [{ id: "pr1", source: "github", url: "https://github.com/o/r/pull/1", title: "PR 1", subtitle: "", icon: null, updatedAt: 1, section: "authored", pr: { number: 1, repo: "o/r", headRef: "b", baseRef: "main" } }];

let nextId = 0;
async function send(method, params, ticks = 80) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 97, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < ticks; i++) {
    const reply = stub.controlSocket.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
    if (reply) return reply;
    await tick();
  }
  return null;
}
const ok = async (method, params) => {
  const reply = await send(method, params, 400);
  assert.ok(reply && !reply.error && !reply.result?.error, `${method}: ${JSON.stringify(reply)}`);
  return reply.result;
};

const download = (id, state) => {
  const d = { id, url: `https://dl.example/${id}.bin`, filename: `${id}.bin`, path: `/scratch/${id}.bin`, state, received: 5, total: 10, speed: 0, mimeType: "application/octet-stream", paused: false, profile: "" };
  S().upsertDownload(d);
  stub.emitDownload(d);
};

let bound = null;
async function fixture() {
  if (bound) unbindFolder(...bound);
  S().hydrate({});
  useAirTraffic.setState((st) => ({ config: { ...st.config, rules: [] } }));
  useLive.setState({ folders: {}, folderOrder: [], items: {}, hidden: {}, unread: {}, completed: {}, status: {} });
  await controlOn();
  S().updateSettings({ appearance: "dark" });
  const windowId = S().createWindow({ url: "https://home.example/" });
  const tab = (url, w = windowId) => S().newTab(w, { url, background: true });
  const [one, two, homed, mate, loose, other, tileA, tileB, peekFrom, gone, spareA, spareB] = ["one", "two", "homed", "mate", "loose", "other", "tile-a", "tile-b", "peek-from", "gone", "spare-a", "spare-b"].map((n) => tab(`https://${n}.example/`));
  const shared = S().groupTabs([one, two, homed], { pinned: true, name: "Team" });
  const inner = S().newNestedGroup(shared);
  await ok("splits.create", { tabs: [two, mate] });
  const split = Object.values(S().splits)[0]?.id;
  const tileFolder = (await ok("pins.createFolder", { tabs: [tileA, tileB], name: "Tiles" })).id;
  setAccount("github", { login: "me", name: null, avatar: null, connectedAt: 1 });
  const liveFolder = (await ok("live.create", { kind: "pullRequests" })).id;
  await ok("live.refresh", { folder: liveFolder });
  const bookmark = (await ok("bookmarks.add", { url: "https://bm.example/", title: "BM" })).id;
  const bookmarkFolder = (await ok("bookmarks.addFolder", { title: "BF" })).id;
  download("dl-done", "finished");
  download("dl-going", "downloading");
  const rule = (await ok("airTraffic.addRule", { when: { kind: "site", host: "rule.example" }, open: "tab" })).id;
  const search = (await ok("search.add", { name: "Ex", keyword: "ex", url: "https://ex.example/?q=%s" })).id;
  await ok("peek.open", { tab: peekFrom, url: "https://peek.example/" });
  const w2 = S().createWindow({ url: "https://second.example/" });
  const p2 = S().createProfile({ name: "Side" });
  S().createWindow({ url: "https://side.example/", profileId: p2 });
  const little = (await ok("littleArdia.open", { url: "https://little.example/" })).window;
  await ok("apply", { ops: [{ op: "tab.close", tabs: [gone] }] });
  const closedId = (await ok("closed.list", {}).catch(() => null))?.items?.[0]?.id ?? S().closedTabs?.[0]?.id ?? "none";
  const profileId = S().groups[shared].profileId;
  const key = pinKeyOf(S().groups[shared]);
  bindFolder(profileId, key, "/scratch/Ardia Shared/Team", { device: 1, inode: 9 });
  bound = [profileId, key];
  return { windowId, w2, p2, little, spareA, spareB, one, two, homed, mate, loose, other, tileA, tileB, peekFrom, shared, inner, split, tileFolder, liveFolder, liveItem: "pr1", bookmark, bookmarkFolder, rule, search, closedId, profileId };
}

const PARAMS = (f) => ({
  apply: { ops: [{ op: "tab.mute", tabs: [f.loose] }] },
  run: { command: "toggleMute", tab: f.loose },
  offscreen: { tab: f.loose },
  subscribe: { events: ["tabs"] },
  answer: { decide: "none", answer: {} },
  "plugins.enable": { name: "none" },
  "plugins.disable": { name: "none" },
  "plugins.remove": { name: "none" },
  "plugins.call": { plugin: "none", tool: "none" },
  "tabs.navigate": { tab: f.other, url: "https://nav.example/" },
  "tabs.reload": { tab: f.other },
  "tabs.back": { tab: f.other },
  "tabs.forward": { tab: f.other },
  "tabs.duplicate": { tab: f.other },
  "tabs.setPinnedUrl": { tab: f.tileA, url: "https://tile-home.example/" },
  "tabs.returnToPinnedUrl": { tab: f.tileA },
  "closed.restore": { id: f.closedId },
  "closed.clear": {},
  "windows.create": {},
  "windows.close": { window: f.w2 },
  "windows.focus": { window: f.w2 },
  "windows.setLayout": { window: f.windowId, layout: "top" },
  "windows.switchProfile": { window: f.w2, profile: f.p2 },
  "windows.merge": { window: f.w2 },
  "littleArdia.open": { url: "https://little2.example/" },
  "littleArdia.close": { window: f.little },
  "littleArdia.toMain": { window: f.little },
  "profiles.create": { name: "New" },
  "profiles.update": { profile: f.p2, name: "Renamed" },
  "profiles.setLook": { profile: f.p2, color: "blue" },
  "profiles.reorder": { profiles: [f.p2, f.profileId] },
  "profiles.setDefault": { profile: f.p2 },
  "profiles.delete": { profile: f.p2 },
  "splits.create": { tabs: [f.spareA, f.spareB] },
  "splits.separate": { split: f.split },
  "splits.removeTab": { tab: f.mate },
  "splits.resize": { split: f.split, sizes: [1, 2] },
  "splits.flip": { split: f.split },
  "splits.setOrientation": { split: f.split, orientation: "vertical" },
  "peek.open": { tab: f.other, url: "https://peek2.example/" },
  "peek.close": { tab: f.peekFrom },
  "peek.toTab": { window: f.windowId },
  "bookmarks.add": { url: "https://bm2.example/", title: "BM2" },
  "bookmarks.addFolder": { title: "BF2" },
  "bookmarks.update": { id: f.bookmark, title: "Renamed" },
  "bookmarks.move": { ids: [f.bookmark], parent: f.bookmarkFolder },
  "bookmarks.remove": { ids: [f.bookmark] },
  "history.remove": { urls: ["https://one.example/"] },
  "history.clear": {},
  "downloads.pause": { id: "dl-going" },
  "downloads.resume": { id: "dl-going" },
  "downloads.cancel": { id: "dl-going" },
  "downloads.keep": { id: "dl-done" },
  "downloads.open": { id: "dl-done" },
  "downloads.reveal": { id: "dl-done" },
  "downloads.remove": { id: "dl-done" },
  "downloads.clear": {},
  "downloads.setSettings": { askWhereToSave: true },
  "settings.set": { values: { appearance: "light" } },
  "settings.reset": { keys: ["appearance"] },
  "search.setDefault": { id: f.search },
  "search.add": { name: "Ex2", keyword: "ex2", url: "https://ex2.example/?q=%s" },
  "search.update": { id: f.search, name: "Renamed" },
  "search.remove": { id: f.search },
  "sites.set": { origin: "https://site.example", type: "popups", value: "allow" },
  "sites.reset": { origin: "https://site.example" },
  "sites.clearData": { site: "site.example" },
  "sites.setZoom": { host: "site.example", zoom: 1.5 },
  "extensions.setEnabled": { id: "a".repeat(32), enabled: false },
  "extensions.setPinned": { id: "a".repeat(32), pinned: true },
  "extensions.reload": { id: "a".repeat(32) },
  "extensions.uninstall": { id: "a".repeat(32) },
  "media.control": { tab: f.other, action: "pause" },
  "passwords.remove": { origin: "https://site.example", username: "me" },
  "pins.createFolder": { tabs: [f.spareA, f.spareB], name: "More" },
  "pins.renameFolder": { folder: f.tileFolder, name: "Renamed" },
  "pins.removeFolder": { folder: f.tileFolder },
  "pins.addToFolder": { folder: f.tileFolder, tabs: [f.other] },
  "pins.removeFromFolder": { tabs: [f.tileA] },
  "live.create": { kind: "pullRequests", name: "Second" },
  "live.update": { folder: f.liveFolder, name: "Renamed" },
  "live.remove": { folder: f.liveFolder },
  "live.refresh": { folder: f.liveFolder },
  "live.hide": { folder: f.liveFolder, items: [f.liveItem] },
  "live.unhide": { folder: f.liveFolder },
  "live.markRead": { folder: f.liveFolder },
  "live.setRepoHidden": { folder: f.liveFolder, repo: "github:o/r", hidden: true },
  "live.open": { folder: f.liveFolder, item: f.liveItem },
  "presets.apply": { code: "ardia1-none" },
  "airTraffic.addRule": { when: { kind: "site", host: "rule2.example" }, open: "window" },
  "airTraffic.updateRule": { id: f.rule, enabled: false },
  "airTraffic.removeRule": { id: f.rule },
  "airTraffic.moveRule": { id: f.rule, index: 0 },
  "airTraffic.setFallback": { open: "window" },
  "windows.setFrame": { window: f.w2, frame: [40, 40, 900, 700] },
  "windows.setMaximized": { window: f.w2, on: true },
  "windows.setFullScreen": { window: f.w2, on: true },
  "sync.now": {},
  "sync.setType": { type: "history", on: false },
  "sync.setProfile": { profile: f.p2, on: true },
  "sync.setOpenTabs": { profile: f.p2, on: true },
  "sync.sendTab": { tab: f.other, device: "none" },
  "extensions.install": { webStore: "a".repeat(32) },
  "extensions.configure": { id: "a".repeat(32), incognito: true },
  "permissions.respond": { id: "pp1", decision: "allow" },
  "passwords.respond": { tab: f.loose, id: "pw1", decision: "save" },
  "autofill.respond": { tab: f.loose, id: 1, decision: "accept" },
  "menus.dismiss": { menu: "m1" },
  "menus.runBar": { path: [1, 0], ref: "cmd:newTab@File\u001fNew Tab", window: f.w2 },
});

const stores = () => [S(), useLive.getState(), useAirTraffic.getState()];
const changed = (a, b) => a.some((s, i) => s !== b[i]);

test("every mutating socket method, with valid parameters on a full fixture, either leaves the shared folder alone or is refused", async () => {
  registerSocketAreas();
  const mutating = methodsCatalog().filter((m) => m.mutates);
  const reached = [];
  const leaked = [];
  for (const entry of mutating) {
    const f = await fixture();
    const params = PARAMS(f)[entry.name];
    assert.ok(params, `no parameters written for ${entry.name}`);
    const before = S();
    const storesBefore = stores();
    await send(entry.name, params);
    for (let i = 0; i < 10; i++) await tick();
    if (changesSharedFolders(before, S())) leaked.push(entry.name);
    if (changed(storesBefore, stores())) reached.push(entry.name);
  }
  setAccount("github", null);
  assert.deepEqual(leaked, [], "methods that changed what a shared folder syncs");
  assert.ok(reached.length >= 60, `only ${reached.length} of ${mutating.length} methods changed a store: ${mutating.map((m) => m.name).filter((n) => !reached.includes(n)).join(", ")}`);
});

test("run, for every command the socket offers, with a shared folder member and with its window as the target, never changes what the folder syncs", async () => {
  const leaked = [];
  for (const command of automationCommands()) {
    for (const target of ["member", "window"]) {
      const f = await fixture();
      S().activate(f.one);
      const before = S();
      const params = { command: command.id, ...(command.variants?.length ? { arg: command.variants[0] } : {}), ...(target === "member" ? { tab: f.one } : { window: f.windowId }) };
      await send("run", params);
      for (let i = 0; i < 10; i++) await tick();
      if (changesSharedFolders(before, S())) leaked.push(`${command.id} (${target})`);
    }
  }
  assert.deepEqual(leaked, []);
});

test("aimed at the shared folder itself (its members, its window and its profile), no mutating method changes what it syncs", async () => {
  registerSocketAreas();
  const dialogs = shellNativeModules.ArdiaDialogs;
  const confirm = dialogs.confirm;
  dialogs.confirm = async () => ({ confirmed: true, suppressed: false });
  globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
  globalThis.acTestCliMoveOffscreen = () => ({ ok: true });
  const code = encodeSetupCode({ settings: { sidebarSide: "right" }, color: "green" });
  const leaked = [];
  try {
    for (const entry of methodsCatalog().filter((m) => m.mutates)) {
      const f = await fixture();
      S().activate(f.one);
      const aimed = { ...f, other: f.one, loose: f.one, mate: f.two, spareA: f.one, tileA: f.one, w2: f.windowId, p2: f.profileId };
      const params = {
        ...PARAMS(aimed),
        "tabs.duplicate": { tab: f.one },
        "tabs.setPinnedUrl": { tab: f.one, url: "https://elsewhere.example/" },
        "tabs.returnToPinnedUrl": { tab: f.one },
        "presets.apply": { code, window: f.windowId },
        "profiles.delete": { profile: f.profileId },
        "littleArdia.toMain": { window: f.little },
        offscreen: { tab: f.one },
        "splits.create": { tabs: [f.one, f.spareB] },
        "pins.createFolder": { tabs: [f.one, f.spareB] },
        "windows.switchProfile": { window: f.windowId, profile: f.p2 },
        "live.open": { folder: f.liveFolder, item: f.liveItem, window: f.windowId },
      }[entry.name];
      const before = S();
      await send(entry.name, params);
      for (let i = 0; i < 10; i++) await tick();
      if (changesSharedFolders(before, S())) leaked.push(entry.name);
    }
  } finally {
    dialogs.confirm = confirm;
    delete globalThis.acTestCliOwns;
    delete globalThis.acTestCliMoveOffscreen;
    setAccount("github", null);
  }
  assert.deepEqual(leaked, [], "methods aimed at the shared folder that changed what it syncs");
});
