import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { reconcileTab, postToContent, receiveWorldMessage } = await import("./pageWorlds.ts");
const { minimizedMarkdown } = await import("./pageApis.ts");
const { openPluginPage, routePluginPage, isSelfRouted, pluginPageLoadSeq } = await import("./pages.ts");
const { parsePluginPageUrl, pluginPageUrl, pageRouteOfView, pluginPagePath } = await import("./pageNames.ts");
const { mountPluginSurface, unmountPluginSurface } = await import("./surfaces.ts");
const { acceptsFile, dropFilesOnPluginView, pickFilesForPluginView, droppedFilePaths } = await import("./surfaceMedia.ts");
const { pluginPageMenuItems, runPluginPageMenu, pluginMenuItems } = await import("./menus.ts");
const { pluginMenuShortcut, pluginShortcutSources, pluginShortcutSignature } = await import("./pluginMenuBar.ts");
const { refreshHealth, usePluginHealth } = await import("./watchdog.ts");
const { keepPluginPage, keptPluginPageTabs, useKeptPluginPages } = await import("./keptPages.ts");
const { heldByArdia, shortcutSourcesKey, provideShortcutSources } = await import("../commands/commandCatalog.ts");
const { comboKey, resolveShortcuts } = await import("../commands/shortcuts.ts");
const { worldBootstrap, worldScript, worldOf } = await import("../../lib/pluginWorlds.ts");
const { pageReadScript } = await import("../../lib/pluginPageRead.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugins-v3-review-2-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 50_000;

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const key of ["starts", "stops", "replies", "events", "finishes", "drops", "picks"]) if (Array.isArray(host[key])) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: v3Text(doc), folderId: `folder-${doc.name}` }));
  host.files = {
    "spa/inbox.js": "setInterval(() => {}, 10);",
    "spa/settings.js": "setInterval(() => {}, 10);",
    "spa/settings.css": "body { color: red }",
  };
  await lifecycle.rescanPlugins(consentToken());
  for (const doc of docs) {
    assert.deepEqual(P().listings[doc.name].problems, [], doc.name);
    assert.ok(lifecycle.requestPluginConsent(doc.name));
    assert.ok(lifecycle.enablePlugin(doc.name, P().consent.hash));
  }
  await settle();
}

const sendLine = (name, run, id, method, params) => stub.emitPluginLine({ name, run, line: JSON.stringify({ id, method, params }) });
const replyTo = (id, from = 0) => host.replies.slice(from).map((r) => JSON.parse(r.line)).find((r) => r.id === id);

async function ask(name, method, params, run) {
  const id = ++nextId;
  const before = host.replies.length;
  sendLine(name, run, id, method, params);
  for (let i = 0; i < 60; i++) {
    await tick();
    const reply = replyTo(id, before);
    if (reply) return reply;
  }
  assert.fail(`no reply to ${method}`);
}

async function activated(name) {
  const waiting = ensurePluginActivated(name, "test");
  await settle();
  const run = P().processes[name].run;
  assert.deepEqual((await ask(name, "ready", {}, run)).result, { ok: true });
  assert.equal(await waiting, run);
  return run;
}

function fakeWeb(document) {
  const calls = [];
  const web = {
    document,
    calls,
    reloads: 0,
    scripts: [],
    pluginDocument: async () => web.document,
    runPluginWorld: async (world, source, doc) => (calls.push({ world, source, doc }), doc === web.document),
    postPluginWorld: async (world, expression, doc) => void calls.push({ world, post: expression, doc }),
    removePluginWorld: async (world, teardown) => void calls.push({ world, teardown }),
    reload: async () => void web.reloads++,
    evaluate: async (script) => (web.scripts.push(script), { text: "Body", markdown: "[a](https://w.example/wiki/Topic_(example)?preview=demo)", selection: "", lang: "en" }),
    capturePicture: async () => null,
  };
  return web;
}

const twoProfiles = () => {
  const a = S().createProfile({ name: "Work" });
  const b = S().createProfile({ name: "Home" });
  return { a, b };
};

const SPA = {
  manifest: 2,
  name: "spa",
  scope: "global",
  title: "Spa",
  main: "index.js",
  permissions: { pages: ["https://mail.example/*"] },
  contributes: {
    contentScripts: [
      { id: "inbox", matches: ["https://mail.example/inbox*"], js: ["inbox.js"] },
      { id: "settings", matches: ["https://mail.example/settings*"], js: ["settings.js"] },
    ],
    pageStyles: [{ id: "look", matches: ["https://mail.example/settings*"], css: "settings.css" }],
  },
};

test("a world whose token changed is torn down and replaced in place, and remembers the document native bound it to", () => {
  const fired = { old: 0, next: 0 };
  const timers = new Map();
  let id = 0;
  const context = vm.createContext({
    setTimeout: (fn) => (timers.set(++id, fn), id),
    clearTimeout: (t) => void timers.delete(t),
    setInterval: (fn) => (timers.set(++id, fn), id),
    clearInterval: (t) => void timers.delete(t),
    EventTarget,
    console,
    location: { href: "https://mail.example/inbox" },
    document: { querySelectorAll: () => [] },
    fired,
    JSON,
    Object,
    Set,
    Promise,
    Error,
    TypeError,
    RangeError,
  });
  context.globalThis = context;
  const href = "https://mail.example/inbox";
  assert.equal(vm.runInContext(worldBootstrap("ardia-plugin:spa", "poll", "dtokenold001", href, "loader-1"), context), "dtokenold001");
  vm.runInContext(worldScript({ id: "inbox", code: "setInterval(() => fired.old++, 5);" }, "dtokenold001", href), context);
  assert.equal(vm.runInContext("globalThis.__ardiaWorld.native", context), "loader-1");
  assert.equal(vm.runInContext(worldBootstrap("ardia-plugin:spa", "poll", "dtokennew002", href, "loader-1"), context), "dtokennew002", "a new token takes the world over");
  vm.runInContext(worldScript({ id: "settings", code: "setInterval(() => fired.next++, 5);" }, "dtokennew002", href), context);
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(fired, { old: 0, next: 1 }, "the stale world's interval is gone, and the new world's timers are real ones, not the disposed wrappers");
  assert.equal(vm.runInContext(worldScript({ id: "late", code: "fired.old = 99;" }, "dtokenold001", href), context), false, "a script for the stale token never runs");
  context.location.href = "https://mail.example/settings";
  assert.equal(vm.runInContext(worldScript({ id: "x", code: "fired.next = 99;" }, "dtokennew002", href), context), false, "a script bound to another address doesn't run after the page moved");
  assert.equal(fired.next, 1);
});

test("native document binding: Chromium rechecks the loader after creating the world and before each poll delivery, WebKit before evaluating and on discard", () => {
  const root = new URL("../../../../../packages/ardiacore/ios/", import.meta.url);
  const chromium = readFileSync(new URL("ArdiaPluginWorlds.mm", root), "utf8");
  const created = chromium.slice(chromium.indexOf("Page.createIsolatedWorld"));
  assert.ok(/frameOfTab:tab completion:\^\(NSString \*madeFrame, NSString \*after\)/.test(created) && created.indexOf("isEqualToString:document") < created.indexOf("_contexts[key] = context"), "the context is cached only after its loader is confirmed");
  const poll = chromium.slice(chromium.indexOf("- (void)pollOnce:"), chromium.indexOf("- (void)post:"));
  assert.ok(poll.indexOf("frameOfTab:liveTab") >= 0 && poll.indexOf("frameOfTab:liveTab") < poll.indexOf("_messages(world, document, value)"), "a poll checks the current loader before it hands messages on");
  const menu = readFileSync(new URL("ArdiaWebView+ContextMenu.mm", root), "utf8");
  const command = menu.slice(menu.indexOf("contextMenuCommand:(NSString *)itemId"));
  assert.ok(command.indexOf("whenPageMenuDocument:") >= 0 && command.indexOf("whenPageMenuDocument:") < command.indexOf("@\"document\" : document"), "a pick that beats the loader lookup waits for it instead of sending an empty document");
  const webkit = readFileSync(new URL("WebKitTab+PluginWorlds.swift", root), "utf8");
  const run = webkit.slice(webkit.indexOf("func runPluginWorld"), webkit.indexOf("func postPluginWorld"));
  assert.ok(run.indexOf("document(of: self) == document") < run.indexOf("evaluateJavaScript"), "WebKit refuses before it evaluates");
  assert.match(run, /staleTeardown\(document\)/, "a run that landed in a newer document tears its world down");
  const tab = readFileSync(new URL("WebKitTab.swift", root), "utf8");
  const discard = tab.slice(tab.indexOf("func dropViewForDiscard"), tab.indexOf("func dropViewForDiscard") + 400);
  assert.match(discard, /WebKitPluginWorldHandler\.detachAll\(view: view\)/, "a discarded page drops its world handler registrations");
  assert.match(discard, /documentSerial \+= 1/);
});

test("an SPA move from /inbox to /settings stops the inbox script, keeps the address current, and lets only eligible contributions run and talk", async () => {
  await enable(SPA);
  const run = await activated("spa");
  const w = S().createWindow({ url: "https://mail.example/inbox" });
  const tab = activeTabId(S(), w);
  const web = fakeWeb("doc-spa");
  webviews.set(tab, web);
  await reconcileTab(tab, consentToken());
  const ran = (id) => web.calls.filter((c) => c.source?.includes("(function (ardia) {") && c.source.includes(JSON.stringify(id)));
  assert.equal(ran("inbox").length, 1);
  const firstToken = /const doc = "([^"]+)"/.exec(web.calls.find((c) => c.source?.includes("const doc = ")).source)[1];
  S().updateTab(tab, { url: "https://mail.example/settings" });
  await reconcileTab(tab, consentToken());
  assert.ok(web.calls.some((c) => c.teardown?.includes(firstToken)), "the inbox world is torn down the moment /inbox stops matching");
  assert.equal(web.reloads, 0, "the page itself stays, it's the same document");
  assert.equal(ran("settings").length, 1, "the settings script runs in a fresh world");
  assert.equal(ran("inbox").length, 1, "the inbox script isn't run again");
  const boots = web.calls.filter((c) => c.source?.includes("const doc = "));
  const secondToken = /const doc = "([^"]+)"/.exec(boots.at(-1).source)[1];
  assert.notEqual(secondToken, firstToken);
  assert.ok(boots.at(-1).source.includes('"https://mail.example/settings"'), "the stored address follows the same-document move");
  assert.ok(web.calls.some((c) => c.source?.includes("data-ardia-sheet") && c.source.includes("https://mail.example/settings")), "a style that just became eligible applies");
  assert.equal(postToContent("spa", tab, { x: 1 }, "inbox"), "That tab has no content script with that id running.");
  assert.equal(postToContent("spa", tab, { x: 1 }, "settings"), null);
  const before = host.events.length;
  const message = (scriptId, doc = secondToken) => JSON.stringify([JSON.stringify({ doc, scriptId, message: scriptId })]);
  receiveWorldMessage(tab, worldOf("spa", "inbox"), "doc-spa", message("inbox", firstToken), consentToken());
  receiveWorldMessage(tab, worldOf("spa", "settings"), "doc-spa", message("settings", firstToken), consentToken());
  receiveWorldMessage(tab, worldOf("spa", "settings"), "doc-spa", message("inbox"), consentToken());
  receiveWorldMessage(tab, worldOf("spa", "settings"), "doc-spa", message("settings"), consentToken());
  const delivered = host.events.slice(before).map((e) => JSON.parse(e.line)).filter((e) => e.event === "page.contentMessage");
  assert.deepEqual(delivered.map((e) => e.data.scriptId), ["settings"], "only the eligible contribution's own world reaches the plugin");
  assert.equal(run, P().processes.spa.run);
  webviews.delete(tab);
});

function fakePage(nodes) {
  const node = (tagName, props = {}, children = []) => {
    const el = { nodeType: 1, tagName, hidden: false, getAttribute: () => null, childNodes: children, ...props };
    el.children = children.filter((c) => c.nodeType === 1);
    if (el.innerText === undefined) el.innerText = children.map((c) => c.textContent ?? c.innerText ?? "").join("");
    return el;
  };
  const text = (value) => ({ nodeType: 3, textContent: value });
  const built = nodes(node, text);
  const posted = [];
  const document = {
    querySelector: (sel) => (sel === "article" ? built.root : sel === 'link[rel="canonical"]' ? { href: "https://w.example/c?session=1" } : null),
    querySelectorAll: (sel) => (sel === "a[href]" ? built.links : []),
    body: { innerText: "Body" },
    documentElement: { lang: "en" },
    forms: [],
  };
  const context = vm.createContext({ document, window: { getSelection: () => "" }, post: (_kind, json) => posted.push(JSON.parse(json)), JSON, String, Number, Set });
  return { context, posted };
}

test("a page read redacts link and image addresses before it writes Markdown, and never cuts a link in half", () => {
  const { context, posted } = fakePage((node, text) => {
    const link = node("A", { href: "https://w.example/wiki/Topic_(example)?preview=demo" }, [text("Topic [1]")]);
    const image = node("IMG", { alt: "pic", src: "https://img.example/a.png?sig=secret" });
    return { root: node("ARTICLE", {}, [node("P", {}, [text("See "), link]), image]), links: [link] };
  });
  vm.runInContext(pageReadScript({ markdown: true, metadata: true, selection: false, fullUrls: false }), context);
  const read = posted[0];
  assert.ok(read.markdown.includes("[Topic \\[1\\]](https://w.example/wiki/Topic_%28example%29)"), read.markdown);
  assert.ok(read.markdown.includes("![pic](https://img.example/a.png)"));
  assert.ok(!/preview|secret|session/.test(JSON.stringify(read)), "no query survives in Markdown, links or metadata");
  assert.equal(read.links[0].url, "https://w.example/wiki/Topic_(example)");
  assert.equal(read.metadata.canonicalUrl, "https://w.example/c");
  const long = fakePage((node, text) => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => node("P", {}, [text("x".repeat(600)), node("A", { href: `https://w.example/p/${i}?q=${i}` }, [text(`l${i}`)])]));
    return { root: node("ARTICLE", {}, paragraphs), links: [] };
  });
  vm.runInContext(pageReadScript({ markdown: true, metadata: false, selection: false, fullUrls: false }), long.context);
  const md = long.posted[0].markdown;
  assert.ok(md.length <= 200_000 && md.length > 150_000, String(md.length));
  assert.equal((md.match(/\]\(/g) ?? []).length, (md.match(/\]\([^)]*\)/g) ?? []).length, "every link in the cut Markdown is closed");
  assert.ok(!md.includes("?q="));
  assert.equal(minimizedMarkdown("see [a](https://w.example/wiki/Topic_(example)?preview=demo) end"), "see [a](https://w.example/wiki/Topic_(example)) end", "the host's own pass follows balanced parentheses too");
  const full = fakePage((node, text) => {
    const link = node("A", { href: "https://w.example/p?keep=1" }, [text("k")]);
    return { root: node("ARTICLE", {}, [node("P", {}, [link])]), links: [link] };
  });
  vm.runInContext(pageReadScript({ markdown: true, metadata: true, selection: false, fullUrls: true }), full.context);
  assert.ok(full.posted[0].markdown.includes("?keep=1"), "fullUrls keeps them");
});

const PAGEY = { manifest: 2, name: "pagey", scope: "profile", title: "Pagey", main: "index.js", permissions: { tabs: "read" }, contributes: { panels: [{ id: "default", title: "Pagey", mode: "tab", file: "page/index.html" }] } };
const CALLEE = { manifest: 2, name: "callee", scope: "profile", title: "Callee", main: "index.js", contributes: { tools: [{ name: "t", title: "T" }] } };
const CALLER = { manifest: 2, name: "caller", scope: "profile", title: "Caller", main: "index.js", contributes: { tools: [{ name: "noop", title: "Noop" }] } };
const MEDIA = { manifest: 2, name: "mediaa", scope: "profile", title: "Media", main: "index.js", permissions: { media: "control", tabs: "write", state: { intents: ["peek.open", "splits.open"] } } };

test("two profiles: page.open, plugin pages, tools.call after activation, media and split/peek all stay in the caller's profiles", async () => {
  await enable(PAGEY, CALLEE, CALLER, MEDIA);
  const { a, b } = twoProfiles();
  for (const name of ["pagey", "callee", "caller", "mediaa"]) lifecycle.updateRecord(name, (r) => ({ ...r, profiles: [a] }), consentToken());
  await settle();
  const wa = S().createWindow({ profileId: a, url: "https://a.example/" });
  const wb = S().createWindow({ profileId: b, url: "https://b.example/" });
  const pagey = await activated("pagey");
  assert.equal(openPluginPage(wb, "pagey", { context: true }), null, "a Profile A plugin page never opens in Profile B's window");
  assert.equal((await ask("pagey", "page.open", {}, pagey)).error.code, "refused", "the front window is Profile B's, so page.open refuses");
  const opened = await ask("pagey", "page.open", { profile: a }, pagey);
  assert.equal(opened.result.windowId, wa, "naming Profile A picks Profile A's window");
  assert.equal((await ask("pagey", "page.open", { profile: b }, pagey)).error.code, "refused");

  const media = await activated("mediaa");
  for (const method of ["media.sessions", "media.control", "peek.open", "splits.open"]) {
    assert.equal((await ask("mediaa", method, { profile: b, tabId: activeTabId(S(), wb), url: "https://x.example/", action: "play" }, media)).error.code, "refused", `${method} refuses an explicit profile it isn't on in`);
  }

  const caller = await activated("caller");
  const before = host.events.length;
  const callId = ++nextId;
  sendLine("caller", caller, callId, "tools.call", { plugin: "callee", tool: "t", profile: a });
  await settle();
  const calleeRun = P().processes.callee.run;
  lifecycle.updateRecord("caller", (r) => ({ ...r, profiles: [b] }), consentToken());
  await settle();
  await ask("callee", "ready", {}, calleeRun);
  await settle(20);
  const reply = replyTo(callId);
  assert.ok(reply?.error, "the call fails once the caller lost Profile A while the callee was starting");
  assert.deepEqual(host.events.slice(before).filter((e) => e.name === "callee" && JSON.parse(e.line).tool === "t"), [], "the callee never sees the call");
});

const DROPPER = { manifest: 2, name: "dropper", scope: "global", title: "Dropper", main: "index.js", permissions: { files: "picker" }, contributes: { sidebarViews: [{ id: "v", title: "V" }] } };

test("a FileDropZone pick or drop is bound to its exact surface instance and enforces accept on both paths", async () => {
  await enable(DROPPER);
  await activated("dropper");
  const w = S().createWindow({ url: "https://a.example/" });
  await mountPluginSurface("dropper", "v#1", "sidebar", w, {}, "v");
  await settle();
  const files = [
    { name: "a.png", size: 1, mimeType: "image/png", data: "AA==", encoding: "base64" },
    { name: "b.txt", size: 300000, mimeType: "text/plain", data: "", encoding: "base64", handle: "h7" },
  ];
  host.pickResult = { ok: true, files };
  const picked = await pickFilesForPluginView("dropper", "v#1", w, { accept: ["image/*"], multiple: true, maxBytes: null });
  assert.deepEqual(picked.map((f) => f.name), ["a.png"], "click-pick keeps only accepted files");
  assert.deepEqual(host.finishes.at(-1), { handle: "h7", commit: false }, "a rejected file's handle is closed");
  const dropped = await dropFilesOnPluginView("dropper", "v#1", w, ["/tmp/a.png", "/tmp/b.txt"], { accept: [".png"], multiple: true, maxBytes: null });
  assert.deepEqual(host.drops.at(-1).paths, ["/tmp/a.png"], "a drop only opens files whose extension is accepted");
  assert.deepEqual(dropped.map((f) => f.name), ["a.png"]);
  let release;
  host.pickResult = new Promise((resolve) => (release = resolve));
  host.finishes.length = 0;
  const pending = dropFilesOnPluginView("dropper", "v#1", w, ["/tmp/a.png"], { accept: [], multiple: true, maxBytes: null });
  unmountPluginSurface("dropper", "v#1", w);
  await mountPluginSurface("dropper", "v#1", "sidebar", w, {}, "v");
  release({ ok: true, files: [{ ...files[1] }] });
  assert.equal(await pending, null, "a replacement surface with the same id doesn't get the first one's files");
  assert.deepEqual(host.finishes, [{ handle: "h7", commit: false }], "and their handles are closed");
  host.pickResult = { ok: false, reason: "you didn't pick a file", cancelled: true };
  assert.equal(await pickFilesForPluginView("dropper", "v#1", S().createWindow({ url: "https://b.example/" }), { accept: [], multiple: false, maxBytes: null }), null, "a window the surface isn't in can't pick for it");
  assert.equal(acceptsFile(["image/*"], { name: "x.PNG", mimeType: "image/png" }), true);
  assert.equal(acceptsFile([".png"], { name: "x.PNG" }), true);
  assert.equal(acceptsFile([".png"], { name: "x.jpg" }), false);
  assert.deepEqual(droppedFilePaths([{ kind: "file", url: "file:///Users/me/My%20File.png" }, { kind: "url", url: "https://x" }]), ["/Users/me/My File.png"]);
  const component = readFileSync(new URL("../../components/plugins/SurfaceRich.tsx", import.meta.url), "utf8");
  assert.match(component, /<FileDropArea accepts="files"/, "FileDropZone uses Ardia's FileDropArea for drops");
});

const MENUS = { manifest: 2, name: "menus", scope: "profile", title: "Menus", main: "index.js", contributes: { commands: [{ name: "find", title: "Find" }, { name: "only", title: "Only Active" }], menus: { selection: [{ command: "find", title: "Find Selection" }, { command: "only", title: "Only Active", when: "isActive && !isPinned && tabCount == 2" }] } } };

test("selection menu items see the full tab context, and running one rechecks the tab's document and profile", async () => {
  await enable(MENUS);
  await activated("menus");
  const { a, b } = twoProfiles();
  lifecycle.updateRecord("menus", (r) => ({ ...r, profiles: [a] }), consentToken());
  await settle();
  const w = S().createWindow({ profileId: a, url: "https://a.example/" });
  const active = activeTabId(S(), w);
  const other = S().newTab(w, { url: "https://a.example/two", background: true });
  const web = fakeWeb("doc-1");
  webviews.set(active, web);
  webviews.set(other, fakeWeb("doc-x"));
  assert.deepEqual(pluginPageMenuItems(active).map((i) => i.title), ["Find Selection", "Only Active"], "isActive, isPinned and tabCount are in the selection context");
  assert.deepEqual(pluginPageMenuItems(other).map((i) => i.title), ["Find Selection"], "a background tab isn't the active one");
  const only = pluginPageMenuItems(active)[1].id;
  assert.equal(await runPluginPageMenu(active, only, "picked", "doc-1", consentToken()), true);
  web.document = "doc-2";
  assert.equal(await runPluginPageMenu(active, only, "picked", "doc-1", consentToken()), false, "the page moved on since the menu was shown");
  assert.equal(await runPluginPageMenu(active, only, "picked", "", consentToken()), false, "a menu without its document is refused");
  const wb = S().createWindow({ profileId: b, url: "https://b.example/" });
  const tb = activeTabId(S(), wb);
  webviews.set(tb, fakeWeb("doc-b"));
  assert.deepEqual(pluginPageMenuItems(tb), [], "a plugin isn't offered in a profile it isn't on in");
  assert.equal(await runPluginPageMenu(tb, only, "picked", "doc-b", consentToken()), false);
  assert.equal(pluginMenuItems("selection", { when: { isActive: false }, data: { windowId: w } }).length, 1);
  for (const id of [active, other, tb]) webviews.delete(id);
});

const KEYS = { manifest: 2, name: "keys", scope: "global", title: "Keys", main: "index.js", contributes: { commands: [{ name: "y", title: "Y", shortcut: "cmd+y" }, { name: "sy", title: "Shift Y", shortcut: "cmd+shift+y" }] } };

test("manifest shortcuts normalize like recorded ones: cmd+y isn't Shift-Cmd-Y, and a changed shortcut refreshes the catalog", async () => {
  await enable(KEYS);
  assert.deepEqual(pluginMenuShortcut("cmd+y"), { key: "y", modifiers: ["command"] });
  assert.deepEqual(pluginMenuShortcut("cmd+shift+y"), { key: "y", modifiers: ["shift", "command"] });
  assert.notEqual(comboKey(pluginMenuShortcut("cmd+y")), comboKey(pluginMenuShortcut("cmd+shift+y")));
  assert.deepEqual(pluginMenuShortcut("cmd+space"), null, "a reserved key stays refused");
  assert.deepEqual(pluginMenuShortcut("cmd+shift+f5"), { key: String.fromCharCode(0xf708), modifiers: ["shift", "command"] }, "function keys become their key equivalents");
  const sources = pluginShortcutSources(() => false);
  const keysOf = (id) => sources.find((s) => s.id === `openExtension:plugin:keys/${id}`).keys;
  assert.deepEqual([keysOf("y"), keysOf("sy")], [[{ key: "y", modifiers: ["command"] }], [{ key: "y", modifiers: ["shift", "command"] }]], "both bind, one each");
  const resolved = resolveShortcuts(sources, {});
  assert.deepEqual(resolved.holdersOf({ key: "y", modifiers: ["command"] }), ["openExtension:plugin:keys/y"]);
  assert.equal(heldByArdia({ key: "t", modifiers: ["command"] }), true);
  assert.deepEqual(pluginShortcutSources(heldByArdia).find((x) => x.id === "openExtension:plugin:keys/y").keys, heldByArdia({ key: "y", modifiers: ["command"] }) ? [] : [{ key: "y", modifiers: ["command"] }], "a key Ardia holds is checked with the same reading");
  assert.equal(heldByArdia({ key: "T", modifiers: ["command"] }), heldByArdia({ key: "t", modifiers: ["shift", "command"] }), "reserved checks read keys the way the resolver does");
  const signature = pluginShortcutSignature();
  provideShortcutSources(() => pluginShortcutSources(heldByArdia), () => pluginShortcutSignature());
  assert.equal(shortcutSourcesKey(), signature);
  host.folders = [{ name: "keys", status: "ok", text: v3Text({ ...KEYS, contributes: { commands: [{ name: "y", title: "Y", shortcut: "cmd+shift+u" }, KEYS.contributes.commands[1]] } }), folderId: "folder-keys" }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.notEqual(shortcutSourcesKey(), signature, "editing only a shortcut changes the catalog's key, so menus and the resolver refresh");
  const nativeSync = readFileSync(new URL("../app/nativeSync.ts", import.meta.url), "utf8");
  assert.match(nativeSync, /shortcutSourcesKey\(\)\]\)/, "the menu bar's item key carries the shortcut signature");
});

test("plugin page tabs: scoped keys round-trip, in-page routes update the address without a reload, and a shown page stays mounted while hidden", async () => {
  assert.deepEqual(parsePluginPageUrl("ardia://sample__notes/inbox?x=1"), { name: "sample__notes", path: "/inbox?x=1" });
  assert.deepEqual(parsePluginPageUrl("ardia://@sample/notes/inbox"), { name: "sample__notes", path: "/inbox" });
  assert.equal(pluginPageUrl("sample__notes", "/inbox"), "ardia://sample__notes/inbox");
  assert.deepEqual(parsePluginPageUrl(pluginPageUrl("sample__notes", "/a/b?c=d")), { name: "sample__notes", path: "/a/b?c=d" });
  assert.equal(parsePluginPageUrl("ardia://bad__/x"), null);
  assert.equal(pageRouteOfView("sample__notes", "ardia-plugin://sample__notes/page/index.html?ardiaPath=%2Fsettings%3Ftab%3D2"), "/settings?tab=2");
  assert.equal(pageRouteOfView("sample__notes", "ardia-plugin://other/page/index.html?ardiaPath=%2Fx"), null);
  const READER = { manifest: 2, name: "reader", scope: "global", title: "Reader", main: "index.js", contributes: { panels: [{ id: "default", title: "Reader", mode: "tab", file: "page/index.html" }] } };
  await enable(READER);
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = openPluginPage(w, "reader", { path: "/inbox" });
  assert.equal(S().tabs[tab].url, "ardia://reader/inbox");
  assert.equal(routePluginPage(tab, "reader", "ardia-plugin://reader/page/index.html?ardiaPath=%2Fthread%2F7", pluginPageLoadSeq(S().tabs[tab])), true);
  assert.equal(S().tabs[tab].url, "ardia://reader/thread/7", "the address follows the page's own route");
  assert.equal(isSelfRouted(tab), true, "and the page isn't reloaded for a route it set itself");
  assert.equal(pluginPagePath(S().tabs[tab].url), "/thread/7");
  S().updateTab(tab, { url: "ardia://reader/typed" });
  assert.equal(isSelfRouted(tab), false, "an address you type loads the page fresh");
  keepPluginPage(tab);
  const second = S().newTab(w, { url: "https://b.example/" });
  S().activate(second);
  assert.deepEqual(keptPluginPageTabs(useKeptPluginPages.getState().order, S(), w), [tab], "after switching away the page tab is still in the window's mounted panes");
  const pane = readFileSync(new URL("../../components/window/usePaneLayout.ts", import.meta.url), "utf8");
  assert.match(pane, /useShownPaneKeys\(paneIds, shownPanes\)/, "kept page tabs join the pane list");
  const internal = readFileSync(new URL("../../components/pages/InternalPage.tsx", import.meta.url), "utf8");
  assert.match(internal, /<View style=\{hidden \? HIDDEN : StyleSheet\.absoluteFill\}/, "one parent tree whether shown or hidden");
  S().updateTab(tab, { url: "https://c.example/" });
  assert.deepEqual(keptPluginPageTabs(useKeptPluginPages.getState().order, S(), w), [], "a tab that left the plugin page isn't kept");
});

test("the Health row counts only the current sidecar run's memory", async () => {
  const BOTH = { manifest: 2, name: "both", scope: "global", title: "Both", main: "index.js", process: { run: ["bin/helper"], memoryMB: 64 }, permissions: { network: "*" }, contributes: { commands: [{ name: "x", title: "X" }] } };
  await enable(BOTH);
  const run = await activated("both");
  const rows = (sidecarRun) => [
    { name: "both", run, memoryBytes: 10, cpuMs: 0, streams: 0, sockets: 0 },
    { name: "both/sidecar", run: sidecarRun, memoryBytes: 1000, cpuMs: 0, streams: 0, sockets: 0 },
  ];
  const source = readFileSync(new URL("./watchdog.ts", import.meta.url), "utf8");
  assert.match(source, /r\.name === `\$\{name\}\$\{SIDECAR_SUFFIX\}` && r\.run === sidecarRun/, "the sidecar row must match the live sidecar run");
  refreshHealth(rows(3));
  assert.equal(usePluginHealth.getState().rows.both.memoryBytes, 10, "with no live sidecar run, a stale sidecar sample isn't added");
});

test("parsePluginThemeKey accepts scoped registry keys and rejects malformed ones", async () => {
  const { parsePluginThemeKey } = await import("./themes.ts");
  assert.deepEqual(parsePluginThemeKey("plugin:sample__notes/dark"), { plugin: "sample__notes", id: "dark" });
  assert.deepEqual(parsePluginThemeKey("plugin:classic/light_1"), { plugin: "classic", id: "light_1" });
  assert.equal(parsePluginThemeKey("plugin:bad__/dark"), null);
  assert.equal(parsePluginThemeKey("plugin:../evil/dark"), null);
});
