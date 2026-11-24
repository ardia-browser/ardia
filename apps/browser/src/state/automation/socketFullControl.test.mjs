import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { useExtensions, cancelInstall } = await import("../extensions/actions.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 0;
let nextConnection = 900;
const CONNECTION = 31;

async function call(method, params, connection = CONNECTION) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 200 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === connection); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === connection);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const code = async (method, params) => (await call(method, params)).error?.code;

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { windowId, tab: S().windows[windowId].activeTabIds[S().windows[windowId].profileId] };
}

const eventsFor = (connection, from) => stub.controlSocket.broadcasts.slice(from).filter((b) => b.connections.includes(connection)).map((b) => JSON.parse(b.line)).filter((l) => l.event && !l.decide);

test("methods lists the new areas with their schemas", async () => {
  await setup();
  const names = new Map((await ok("methods")).map((m) => [m.name, m]));
  for (const name of ["sync.now", "sync.setType", "sync.setProfile", "sync.setOpenTabs", "sync.devices", "sync.sendTab", "extensions.install", "extensions.configure", "windows.geometry", "windows.setFrame", "windows.setMaximized", "windows.setFullScreen"]) {
    assert.ok(names.has(name), name);
    assert.equal(names.get(name).params.additionalProperties, false, `${name} takes nothing it doesn't list`);
  }
  assert.equal(names.get("windows.setFrame").params.properties.frame.prefixItems.length, 4);
  assert.equal(await code("windows.setFrame", { window: "w", frame: [0, 0, 100] }), "bad_request");
  assert.equal(await code("sync.setType", { type: "cookies", on: true }), "bad_request");
});

test("settings: engines, rules, New Tab page and the legacy search URL, each checked as Settings checks it", async () => {
  await setup();
  const schema = new Map((await ok("settings.schema")).map((s) => [s.key, s]));
  for (const key of ["pageEngine", "websiteEngines", "protectedVideoInWebKit", "newTabUrl", "customSearchUrl"]) assert.equal(schema.get(key).writable, true, key);
  assert.equal(schema.get("extensionSearchEngines").writable, false);
  assert.match(schema.get("extensionSearchEngines").why, /extensions/);

  const set = await ok("settings.set", { values: { pageEngine: "webkit", websiteEngines: { "netflix.com": "webkit", "https://docs.example:8443/x": "chromium" }, protectedVideoInWebKit: false } });
  assert.deepEqual(set.values.websiteEngines, { "https://netflix.com": "webkit", "https://docs.example:8443": "chromium" });
  assert.equal(S().settings.pageEngine, "webkit");
  assert.equal(S().settings.protectedVideoInWebKit, false);

  assert.equal(await code("settings.set", { values: { pageEngine: "gecko" } }), "bad_request");
  assert.equal(await code("settings.set", { values: { websiteEngines: { "not a site at all ": "webkit" } } }), "bad_request");
  assert.equal(await code("settings.set", { values: { websiteEngines: { "netflix.com": "gecko" } } }), "bad_request");

  assert.equal((await ok("settings.set", { values: { newTabUrl: "  https://start.example/  " } })).values.newTabUrl, "https://start.example/");
  assert.equal(await code("settings.set", { values: { newTabUrl: "javascript:alert(1)" } }), "bad_request");
  assert.equal(S().settings.newTabUrl, "https://start.example/", "a refused value leaves the old one");

  await ok("settings.set", { values: { customSearchUrl: "https://find.example/?q=%s" } });
  assert.ok((await ok("search.engines")).some((e) => e.id === "custom" && e.url === "https://find.example/?q=%s"));
  await ok("search.setDefault", { id: "custom" });
  assert.equal(await code("settings.set", { values: { customSearchUrl: "https://find.example/" } }), "bad_request");
  assert.equal(await code("settings.set", { values: { customSearchUrl: "ftp://find.example/%s" } }), "bad_request");
  await ok("settings.set", { values: { customSearchUrl: "" } });
  assert.notEqual(S().settings.searchEngine, "custom", "clearing the URL drops it as the default, as removing an engine does");

  assert.equal(await code("settings.set", { values: { extensionSearchEngines: [] } }), "refused");
  assert.equal(await code("settings.set", { values: { pageEngine: "chromium", cliControl: false } }), "refused");
  await ok("settings.reset", { keys: ["pageEngine", "websiteEngines", "protectedVideoInWebKit", "newTabUrl"] });
  assert.deepEqual([S().settings.pageEngine, S().settings.websiteEngines, S().settings.protectedVideoInWebKit, S().settings.newTabUrl], ["chromium", {}, true, ""]);
});

function fakeExtensions() {
  const list = [];
  const pkg = { name: "Folder Ext", version: "1.0", description: "", manifestVersion: 3, icon: null, permissions: [], optionalPermissions: [], hostPermissions: [], hasAction: false, popup: null, optionsPage: null, sidePanel: null };
  const engine = {
    list: async () => list.map((x) => ({ ...x })),
    install: async (path) => {
      list.push({ id: "folderext", name: "Folder Ext", version: "1.0", description: "", enabled: true, state: "ENABLED", icon: "", permissions: [], siteAccess: null, sites: [], optionsUrl: null, pinned: false, incognito: false, fileAccess: false, mayModify: true, errors: [], location: path });
      return "folderext";
    },
    reload: async () => {},
    uninstall: async () => {},
    configure: async (id, _profile, options) => {
      const x = list.find((e) => e.id === id);
      if (options.incognito !== undefined) x.incognito = options.incognito;
      if (options.userScripts !== undefined) x.userScripts = options.userScripts;
      if (options.siteAccess) x.siteAccess = { allSites: "ON_ALL_SITES", specificSites: "ON_SPECIFIC_SITES", onClick: "ON_CLICK" }[options.siteAccess];
    },
    inspect: async (path) => {
      if (!path.endsWith("/ext")) throw new Error("Manifest file is missing or unreadable");
      return { ...pkg, path };
    },
  };
  globalThis.acTestUserScripts = { ...(globalThis.acTestUserScripts ?? {}), engine };
  return list;
}

test("extensions: folders are refused, the Web Store opens its page, and configure changes only what the details page offers", async () => {
  const { windowId } = await setup();
  const list = fakeExtensions();
  assert.equal(await code("extensions.install", {}), "bad_request");
  for (const folder of ["relative/ext", "/tmp/nothing", "/tmp/one/ext"]) assert.equal(await code("extensions.install", { folder }), "refused", "socket folder installs are refused");
  assert.equal(await code("extensions.install", { webStore: "https://example.com/not-a-store" }), "bad_request");
  assert.equal(useExtensions.getState().install, null, "no sheet shows for a refused folder");
  list.push({ id: "folderext", name: "Folder Ext", version: "1.0", description: "", enabled: true, state: "ENABLED", icon: "", permissions: [], siteAccess: null, sites: [], optionsUrl: null, pinned: false, incognito: false, fileAccess: false, mayModify: true, errors: [], incognitoAllowed: true });

  const tabsBefore = Object.keys(S().tabs).length;
  const store = await ok("extensions.install", { webStore: "https://chromewebstore.google.com/detail/name/abcdefghijklmnopabcdefghijklmnop" });
  assert.deepEqual(store, { waiting: true, id: "abcdefghijklmnopabcdefghijklmnop" });
  assert.equal(Object.keys(S().tabs).length, tabsBefore + 1, "opens the store page for the user to add it");

  assert.equal(await code("extensions.configure", { id: "folderext" }), "bad_request");
  assert.equal(await code("extensions.configure", { id: "folderext", siteAccess: "onClick" }), "refused", "no site access to choose");
  assert.equal(await code("extensions.configure", { id: "folderext", userScripts: true }), "refused", "it doesn't use user scripts");
  assert.equal(await code("extensions.configure", { id: "folderext", fileAccess: true }), "bad_request", "not on the details page");
  assert.equal((await ok("extensions.configure", { id: "folderext", incognito: true })).incognito, true);
  list[0].siteAccess = "ON_ALL_SITES";
  list[0].userScriptsAvailable = true;
  await ok("extensions.list");
  assert.equal(await code("extensions.configure", { id: "folderext", siteAccess: "onClick", userScripts: true }), "bad_request", "one setting per call");
  assert.equal((await ok("extensions.configure", { id: "folderext", siteAccess: "onClick" })).siteAccess, "ON_CLICK");
  assert.equal((await ok("extensions.configure", { id: "folderext", userScripts: true })).userScripts, true);
  list[0].mayModify = false;
  await ok("extensions.list");
  assert.equal(await code("extensions.configure", { id: "folderext", incognito: false }), "refused");
  assert.equal(await code("extensions.configure", { id: "nope", incognito: false }), "no_window");
});

test("windows: frame, zoom and full screen go through the native window, and the store follows full screen", async () => {
  const { windowId } = await setup();
  stub.windows.geometry.clear();
  if (!stub.windows.open.has(windowId)) stub.windows.open.set(windowId, {});
  const { onWindowEvent } = await import("../../platform/windows.ts");
  const listening = onWindowEvent((e) => e.type === "fullScreen" && S().setWindowFullScreen(e.id, e.on, e.display));
  const moved = await ok("windows.setFrame", { window: windowId, frame: [50, 60, 900, 700] });
  assert.deepEqual(moved.geometry.frame, [50, 60, 900, 700]);
  assert.equal((await ok("windows.setMaximized", { window: windowId, on: true })).maximized, true);
  assert.equal((await ok("windows.geometry", { window: windowId })).zoomed, true);
  const full = await ok("windows.setFullScreen", { window: windowId, on: true });
  assert.equal(full.fullScreen, true);
  assert.ok(S().windows[windowId].fullScreen, "the store took the native event");
  assert.equal(await code("windows.setFrame", { window: windowId, frame: [0, 0, 800, 600] }), "refused");
  assert.equal(await code("windows.setMaximized", { window: windowId, on: false }), "refused");
  assert.equal((await ok("windows.setFullScreen", { window: windowId, on: false })).fullScreen, false);
  assert.equal(await code("windows.setFrame", { window: "nope", frame: [0, 0, 800, 600] }), "no_window");
  listening.remove();
});

test("events: bookmarks, history removals, downloads and profiles", async () => {
  await setup();
  useBrowser.setState({ bookmarksReady: { "": true } });
  S().addBookmark({ profileId: "default", url: "https://seed.example/", title: "Seed" });
  const conn = ++nextConnection;
  await call("subscribe", { events: ["bookmarks.changed", "history.removed", "download.changed", "profile.changed"] }, conn);
  const from = stub.controlSocket.broadcasts.length;

  const mark = S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
  const markId = typeof mark === "string" ? mark : Object.values(S().bookmarks.nodes).find((n) => n.kind === "url" && n.url === "https://one.example/").id;
  S().updateBookmark?.(markId, { title: "Uno" });
  stub.chromeHistoryEvent({ kind: "deleted", profile: "", all: false, urls: ["https://gone.example/"] });
  S().upsertDownload({ id: "d1", url: "https://f.example/a.zip", filename: "a.zip", path: "/tmp/a.zip", state: "downloading", paused: false, received: 1, total: 10, speed: 0, mimeType: "application/zip", profile: "", startTime: 1 });
  S().upsertDownload({ id: "d1", url: "https://f.example/a.zip", filename: "a.zip", path: "/tmp/a.zip", state: "downloading", paused: false, received: 5, total: 10, speed: 0, mimeType: "application/zip", profile: "", startTime: 1 });
  S().upsertDownload({ id: "d1", url: "https://f.example/a.zip", filename: "a.zip", path: "/tmp/a.zip", state: "finished", paused: false, received: 10, total: 10, speed: 0, mimeType: "application/zip", profile: "", startTime: 1 });
  const made = await ok("profiles.create", { name: "Work" });
  await ok("profiles.update", { profile: made.id, name: "Office" });
  await wait(20);

  const events = eventsFor(conn, from);
  const bookmarks = events.filter((e) => e.event === "bookmarks.changed");
  assert.ok(bookmarks.some((e) => e.data.added.includes(markId) && e.data.profile === "default"), "the new bookmark");
  const history = events.find((e) => e.event === "history.removed");
  assert.deepEqual(history.data, { profiles: ["default"], all: false, count: 1, urls: ["https://gone.example/"], truncated: false });
  const downloads = events.filter((e) => e.event === "download.changed").map((e) => `${e.data.change}:${e.data.state}`);
  assert.deepEqual(downloads, ["added:downloading", "updated:finished"], "progress alone sends nothing");
  const profiles = events.filter((e) => e.event === "profile.changed").map((e) => e.data);
  assert.ok(profiles.some((p) => p.profile === made.id && p.change === "created"));
  assert.ok(profiles.some((p) => p.profile === made.id && p.change === "updated" && p.keys.includes("name")));
  stub.emitControlClose(conn);
});
