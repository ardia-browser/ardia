import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { v3Text } from "./fixtures/manifests.mjs";

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated } = await import("./activation.ts");
const { settledStops } = await import("./process.ts");
const { notePluginGesture } = await import("./gestures.ts");
const { mountPluginSurface, unmountPluginSurface, surfaceRevs } = await import("./surfaces.ts");
const { reconcileTab, postToContent, receiveWorldMessage, injectedTabsOf } = await import("./pageWorlds.ts");
const { checkUsage, pausedReason, resumePlugin } = await import("./watchdog.ts");
const { minimizedMarkdown, grantTabLease } = await import("./pageApis.ts");
const { shownCommandContext } = await import("./commands.ts");
const { signInUrl } = await import("./osApis.ts");
const { pluginImage, pluginImageRequest } = await import("./surfaceMedia.ts");
const { pluginPageMenuItems, runPluginPageMenu } = await import("./menus.ts");
const { pluginMenuBarItems, pluginShortcutSources, parsePluginMenuItem } = await import("./pluginMenuBar.ts");
const { heldByArdia } = await import("../commands/commandCatalog.ts");
const { worldBootstrap, worldScript, worldTeardown, worldOf } = await import("../../lib/pluginWorlds.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { NO_PERMISSIONS } = await import("../../lib/pluginPermissions.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugins-v3-round-2-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 0;

const PAGES = {
  manifest: 2,
  name: "pages",
  scope: "global",
  title: "Pages",
  main: "index.js",
  permissions: { pages: ["https://github.com/*"] },
  contributes: { contentScripts: [{ id: "badge", matches: ["https://github.com/*"], js: ["content.js"] }] },
};
const DATA = { manifest: 2, name: "data", scope: "global", title: "Data", main: "index.js", permissions: { bookmarks: "read", history: "read", activePage: { read: true, multiTab: true }, tabs: "read", network: ["api.example.com"], files: "picker" }, contributes: { commands: [{ name: "go", title: "Go", shortcut: "cmd+shift+u" }, { name: "find", title: "Find", shortcut: "cmd+shift+y" }], menus: { page: [{ command: "go" }], selection: [{ command: "find", title: "Find Selection" }] } } };
const BRAIN = { manifest: 2, name: "brain", scope: "profile", title: "Brain", main: "index.js", provides: ["ai.provider"], contributes: { commands: [{ name: "x", title: "X" }] } };
const ASKER = { manifest: 2, name: "asker", scope: "global", title: "Asker", main: "index.js", consumes: ["ai.provider"], contributes: { commands: [{ name: "x", title: "X" }] } };

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const key of ["starts", "stops", "replies", "events"]) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: v3Text(doc), folderId: `folder-${doc.name}` }));
  host.files = { "pages/content.js": "setInterval(() => {}, 10);" };
  await lifecycle.rescanPlugins(consentToken());
  for (const doc of docs) {
    assert.deepEqual(P().listings[doc.name].problems, [], doc.name);
    assert.ok(lifecycle.requestPluginConsent(doc.name));
    assert.ok(lifecycle.enablePlugin(doc.name, P().consent.hash));
  }
  await settle();
}

async function ask(name, method, params, run) {
  const id = ++nextId;
  const before = host.replies.length;
  stub.emitPluginLine({ name, run, line: JSON.stringify({ id, method, params }) });
  for (let i = 0; i < 60; i++) {
    await tick();
    const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
    if (reply) return reply;
  }
  assert.fail(`no reply to ${method}`);
}

async function activated(name, params = {}) {
  const waiting = ensurePluginActivated(name, "test");
  await settle();
  const run = P().processes[name].run;
  assert.deepEqual((await ask(name, "ready", params, run)).result, { ok: true });
  assert.equal(await waiting, run);
  return run;
}

function fakeWeb(document) {
  const calls = [];
  const web = {
    document,
    calls,
    reloads: 0,
    pluginDocument: async () => web.document,
    runPluginWorld: async (world, source, doc) => (calls.push({ world, source, doc }), doc === web.document),
    postPluginWorld: async (world, expression, doc) => void calls.push({ world, post: expression, doc }),
    removePluginWorld: async (world, teardown) => void calls.push({ world, teardown }),
    reload: async () => void web.reloads++,
    evaluate: async () => ({ text: "Body", markdown: "[a](https://x.example/p?secret=1#h)", selection: "", lang: "en" }),
    capturePicture: async () => null,
  };
  return web;
}

test("a content script runs only in the document it was bound to, and a navigation mid-injection drops it", async () => {
  await enable(PAGES);
  await activated("pages");
  const w = S().createWindow({ url: "https://github.com/a/b" });
  const tab = activeTabId(S(), w);
  const web = fakeWeb("loader-1");
  webviews.set(tab, web);
  await reconcileTab(tab, consentToken());
  const scripts = web.calls.filter((c) => c.world === worldOf("pages", "badge") && c.source?.includes("(function (ardia) {"));
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].doc, "loader-1");
  assert.deepEqual(injectedTabsOf("pages"), [tab]);
  web.document = "loader-2";
  assert.equal(postToContent("pages", tab, { hi: 1 }), null);
  assert.equal(web.calls.at(-1).doc, "loader-1", "a post names the document it targets, which native refuses once that document is gone");
  web.calls.length = 0;
  receiveWorldMessage(tab, worldOf("pages", "badge"), "loader-1", JSON.stringify([JSON.stringify({ doc: "wrong-token-0", message: 1 })]), consentToken());
  assert.equal(host.events.filter((e) => e.line.includes("page.contentMessage")).length, 0, "a message carrying another document's token goes nowhere");
  webviews.delete(tab);
});

test("turning a plugin off tears its world down at once and reloads the tab its scripts ran in", async () => {
  await enable(PAGES);
  await activated("pages");
  const w = S().createWindow({ url: "https://github.com/a/b" });
  const tab = activeTabId(S(), w);
  const web = fakeWeb("loader-9");
  webviews.set(tab, web);
  await reconcileTab(tab, consentToken());
  lifecycle.disablePlugin("pages", consentToken());
  void reconcileTab(tab, consentToken());
  assert.ok(web.calls.some((c) => c.teardown?.includes("teardown")), "the teardown went out before any queued work");
  assert.equal(web.reloads, 1, "the tab reloads so nothing the script left running survives");
  webviews.delete(tab);
});

test("the world's teardown stops the script's intervals, timeouts and listeners", async () => {
  const fired = { interval: 0, timeout: 0, listener: 0 };
  const target = new EventTarget();
  const timers = new Map();
  let nextTimer = 0;
  const addTimer = (fn) => (timers.set(++nextTimer, fn), nextTimer);
  const addTimeout = (fn) => {
    const id = ++nextTimer;
    timers.set(id, () => (timers.delete(id), fn()));
    return id;
  };
  const dropTimer = (id) => void timers.delete(id);
  const runTimers = () => [...timers.values()].forEach((fn) => fn());
  const context = vm.createContext({ setTimeout: addTimeout, clearTimeout: dropTimer, setInterval: addTimer, clearInterval: dropTimer, EventTarget, console, location: { href: "https://github.com/a" }, document: { querySelectorAll: () => [] }, fired, target, JSON, Object, Set, Promise, Error, TypeError, RangeError });
  context.globalThis = context;
  vm.runInContext(worldBootstrap("ardia-plugin:pages", "poll", "dtokenabc123", "https://github.com/a", "doc-1"), context);
  vm.runInContext(worldScript({ id: "s", code: "setInterval(() => fired.interval++, 5); setTimeout(() => fired.timeout++, 40); target.addEventListener('ping', () => fired.listener++);" }, "dtokenabc123", "https://github.com/a"), context);
  target.dispatchEvent(new Event("ping"));
  runTimers();
  runTimers();
  assert.ok(fired.interval === 2 && fired.timeout >= 1 && fired.listener === 1);
  assert.equal(vm.runInContext(worldTeardown("dtokenabc123"), context), true);
  const after = { ...fired };
  target.dispatchEvent(new Event("ping"));
  runTimers();
  assert.equal(timers.size, 0, "every timer the script started was cleared");
  assert.deepEqual(fired, after, "nothing fires once the world is torn down");
  assert.equal(vm.runInContext(worldScript({ id: "late", code: "fired.interval = -1;" }, "dtokenabc123", "https://github.com/a"), context), false, "a script for a torn-down world doesn't run");
  assert.equal(vm.runInContext(worldBootstrap("ardia-plugin:pages", "poll", "other12345", "https://gitlab.com/a", "doc-1"), context), "", "a world never starts on a page it wasn't meant for");
});

test("a refused profile request fails instead of falling back, for browser data, services and tools", async () => {
  await enable(DATA, BRAIN, ASKER);
  const data = await activated("data");
  const asker = await activated("asker");
  assert.equal((await ask("data", "bookmarks.search", { query: "x", profile: "nobody" }, data)).error.code, "refused");
  assert.equal((await ask("data", "history.search", { profile: "nobody" }, data)).error.code, "refused");
  assert.equal((await ask("asker", "services.call", { iface: "ai.provider", method: "complete", profile: "nobody" }, asker)).error.code, "refused");
  assert.equal((await ask("asker", "tools.call", { plugin: "brain", tool: "t", profile: "nobody" }, asker)).error.code, "refused");
  lifecycle.updateRecord("brain", (r) => ({ ...r, profiles: ["elsewhere"] }), consentToken());
  await settle();
  assert.equal((await ask("asker", "services.call", { iface: "ai.provider", method: "complete" }, asker)).error.code, "refused", "a provider on in another profile isn't reached from this one");
});

test("page reads minimize Markdown links, and an attached tab's lease ends when its document changes", async () => {
  assert.equal(minimizedMarkdown("see [a](https://x.example/p?secret=1#h) and [b](http://y.example/)"), "see [a](https://x.example/p) and [b](http://y.example/)");
  await enable(DATA);
  const run = await activated("data");
  const w = S().createWindow({ url: "https://a.example/doc" });
  const tab = activeTabId(S(), w);
  const web = fakeWeb("doc-a");
  webviews.set(tab, web);
  assert.equal(await grantTabLease("data", tab, consentToken()), true);
  const read = await ask("data", "page.readTab", { tabId: tab, markdown: true }, run);
  assert.equal(read.result.markdown, "[a](https://x.example/p)");
  web.document = "doc-b";
  assert.equal((await ask("data", "page.readTab", { tabId: tab }, run)).error.code, "refused", "a reload or navigation ends the lease even at the same address");
  webviews.delete(tab);
  assert.deepEqual(shownCommandContext({ ...NO_PERMISSIONS, multiTab: true }, { tabs: ["t1", "t2"], from: "inputMode" }).tabs, ["t1", "t2"]);
  assert.equal(shownCommandContext(NO_PERMISSIONS, { tabs: ["t1"] }).tabs, undefined);
});

test("sign-in is https-only on the plugin's hosts, names its run, and drops a code that comes back after the plugin stopped", async () => {
  await enable(DATA);
  const run = await activated("data");
  const m = P().listings.data.manifest;
  assert.equal(signInUrl(m, "http://api.example.com/token"), null);
  assert.equal(signInUrl(m, "https://evil.example/token"), null);
  assert.equal(signInUrl(m, "https://api.example.com/token"), "https://api.example.com/token");
  let release;
  host.authResult = new Promise((resolve) => (release = resolve));
  host.fetchResult = { ok: true, status: 200, statusText: "OK", url: "https://api.example.com/token", headers: {}, body: JSON.stringify({ access_token: "t" }) };
  notePluginGesture("data", S().createWindow({ url: "https://a.example/" }));
  const id = ++nextId;
  stub.emitPluginLine({ name: "data", run, line: JSON.stringify({ id, method: "auth.signIn", params: { authorizeUrl: "https://api.example.com/auth", tokenUrl: "https://api.example.com/token", clientId: "c" } }) });
  await settle();
  assert.equal(host.authSpecs.at(-1).plugin, "data");
  const fetchesBefore = host.fetches.length;
  lifecycle.disablePlugin("data", consentToken());
  release({ ok: true, code: "abc", verifier: "v", redirectUri: "ardia-auth://test/data/callback" });
  await settle(20);
  assert.equal(host.fetches.length, fetchesBefore, "no code exchange after the plugin stopped");
  host.authResult = { ok: false, reason: "no sign-in in tests" };
  host.fetchResult = null;
});

test("plugin images go through the host loader or the sealed folder, and big files come back as run-scoped handles", async () => {
  await enable(DATA);
  const run = await activated("data");
  assert.equal(pluginImageRequest("data", "http://api.example.com/a.png"), null);
  assert.equal(pluginImageRequest("data", "https://evil.example/a.png"), null);
  assert.equal(pluginImageRequest("data", "../escape.png"), null);
  assert.equal(pluginImageRequest("data", "icons/a.png").kind, "asset");
  host.imageResult = { ok: true, url: "data:image/png;base64,AAAA" };
  assert.equal(await pluginImage("data", "https://api.example.com/a.png"), "data:image/png;base64,AAAA");
  assert.deepEqual(host.imageLoads.at(-1).allowedHosts, ["api.example.com"]);
  host.assets["data/icons/a.png"] = "data:image/png;base64,BBBB";
  assert.equal(await pluginImage("data", "icons/a.png"), "data:image/png;base64,BBBB");
  notePluginGesture("data", S().createWindow({ url: "https://a.example/" }));
  host.pickResult = { ok: true, files: [{ name: "big.bin", size: 900000, mimeType: "application/octet-stream", data: "", encoding: "base64", handle: "h1" }] };
  const picked = await ask("data", "fs.pickFiles", {}, run);
  assert.deepEqual(picked.result.files[0].handle, "h1");
  assert.deepEqual(host.picks.at(-1), { name: "data", run });
  host.chunks.h1 = ["QUJD"];
  assert.deepEqual((await ask("data", "fs.readChunk", { handle: "h1", offset: 0 }, run)).result, { data: "QUJD", eof: true });
  assert.equal((await ask("data", "fs.readChunk", { handle: "../x" }, run)).error.code, "bad_request");
  host.pickResult = { ok: false, reason: "you didn't pick a file", cancelled: true };
});

test("a surface's patch revision is forgotten when it unmounts", async () => {
  await enable({ ...ASKER, contributes: { ...ASKER.contributes, sidebarViews: [{ id: "v", title: "V" }] } });
  const run = await activated("asker");
  const w = S().createWindow({ url: "https://a.example/" });
  await mountPluginSurface("asker", "v#1", "sidebar", w, {}, "v");
  await settle();
  await ask("asker", "surface.render", { surfaceId: "v#1", tree: { type: "Box", props: {}, children: [] }, rev: 4 }, run);
  assert.equal(surfaceRevs.get("asker:v#1"), 4);
  unmountPluginSurface("asker", "v#1", w);
  assert.equal(surfaceRevs.has("asker:v#1"), false);
});

test("the watchdog ignores a stale run's sample and pauses a plugin whose sidecar runs away", async () => {
  await enable({ manifest: 2, name: "both", scope: "global", title: "Both", main: "index.js", process: { run: ["bin/helper"], memoryMB: 64 }, permissions: { network: "*" }, contributes: { commands: [{ name: "x", title: "X" }] } });
  const run = await activated("both");
  checkUsage([{ name: "both", run: run - 1, memoryBytes: 10 * 1024 * 1024 * 1024, cpuMs: 0, streams: 0, sockets: 0 }], consentToken(), Date.now());
  assert.equal(pausedReason("both"), null, "a sample from an earlier run never pauses the current one");
  checkUsage([{ name: "both/sidecar", run: 7, memoryBytes: 70 * 1024 * 1024, cpuMs: 0, streams: 0, sockets: 0 }], consentToken(), Date.now(), () => 7);
  assert.equal(pausedReason("both"), "memory", "the sidecar's footprint is held to the sidecar's memoryMB");
  resumePlugin("both", consentToken());
});

test("page and selection menu slots, and plugin commands in the menu bar with conflict-checked shortcuts", async () => {
  await enable(DATA);
  await activated("data");
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = activeTabId(S(), w);
  webviews.set(tab, fakeWeb("doc-menu"));
  const items = pluginPageMenuItems(tab);
  assert.deepEqual(items.map((i) => [i.slot, i.title]), [["page", "Go"], ["selection", "Find Selection"]]);
  const before = host.events.length;
  assert.equal(await runPluginPageMenu(tab, items[1].id, "picked text", "doc-menu", consentToken()), true);
  await settle();
  const call = host.events.slice(before).map((e) => JSON.parse(e.line)).find((l) => l.kind === "command");
  assert.deepEqual([call.name, call.context.selection], ["find", "picked text"]);
  assert.equal(await runPluginPageMenu(tab, items[1].id, "  ", "doc-menu", consentToken()), false, "a selection item needs a selection");
  webviews.delete(tab);
  const bar = pluginMenuBarItems(S(), w);
  assert.deepEqual(bar.map((i) => i.id), ["plugin:data/go", "plugin:data/find"]);
  assert.deepEqual(parsePluginMenuItem("plugin:data/go"), { plugin: "data", command: "go" });
  assert.equal(heldByArdia({ key: "t", modifiers: ["command"] }), true, "⌘T is Ardia's own New Tab");
  const sources = pluginShortcutSources((shortcut) => heldByArdia(shortcut) || shortcut.key === "u");
  assert.deepEqual(sources.find((s) => s.id === "openExtension:plugin:data/go").keys, [], "a key Ardia already holds leaves the plugin's default off");
  assert.deepEqual(sources.find((s) => s.id === "openExtension:plugin:data/find").keys, [{ key: "y", modifiers: ["shift", "command"] }]);
  const privateWindow = S().createWindow({ url: "https://a.example/", kind: "private" });
  assert.deepEqual(pluginMenuBarItems(S(), privateWindow), []);
});
