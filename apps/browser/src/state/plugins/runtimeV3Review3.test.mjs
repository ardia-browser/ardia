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
const { reconcileTab, postToContent, receiveWorldMessage } = await import("./pageWorlds.ts");
const { openPluginPage, routePluginPage, isSelfRouted, pluginPageLoadSeq, wakeForFilePage } = await import("./pages.ts");
const { pageRouteOfView } = await import("./pageNames.ts");
const { pluginStoreKey } = await import("./hooks.ts");
const { dropFilesOnPluginView } = await import("./surfaceMedia.ts");
const { mountPluginSurface } = await import("./surfaces.ts");
const { pageMenuKey } = await import("./menus.ts");
const { fittedRead, READ_REPLY_BYTES } = await import("./pageApis.ts");
const { byteLength } = await import("./stateEventPacking.ts");
const { tabDestination } = await import("../pages/urls.ts");
const { worldOf, unitOfWorld, worldBootstrap, worldDeliver } = await import("../../lib/pluginWorlds.ts");
const { pageReadScript } = await import("../../lib/pluginPageRead.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugins-v3-review-3-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 90_000;
const root = new URL("../../../../../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const key of ["starts", "stops", "replies", "events", "finishes", "drops", "picks"]) if (Array.isArray(host[key])) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: v3Text(doc), folderId: `folder-${doc.name}` }));
  host.files = { "spa/inbox.js": "setInterval(() => {}, 10);", "spa/site.js": "setInterval(() => {}, 10);" };
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
    pluginDocument: async () => web.document,
    runPluginWorld: async (world, source, doc) => (calls.push({ world, source, doc }), doc === web.document),
    postPluginWorld: async (world, expression, doc) => void calls.push({ world, post: expression, doc }),
    removePluginWorld: async (world, teardown) => void calls.push({ world, teardown }),
    reload: async () => void web.reloads++,
    evaluate: async () => ({ text: "Body", selection: "", lang: "en" }),
    capturePicture: async () => null,
  };
  return web;
}

const swiftStrings = (text, name) => {
  const start = text.indexOf(`static let ${name} =`);
  const end = text.indexOf("\n  static", start + 10);
  return [...text.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
};
const objcStrings = (text, name) => {
  const start = text.indexOf(`NSString *const ${name} =`);
  const end = text.indexOf(";\n", start);
  return [...text.slice(start, end).matchAll(/@"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
};

test("each engine stamps a per-document nonce and refuses to run a script or style in a replacement document, even at the same address", () => {
  const webkit = source("packages/ardiacore/ios/WebKitPluginWorldHandler.swift");
  const chromium = source("packages/ardiacore/ios/ArdiaPluginWorlds.mm");
  const nonceScript = swiftStrings(webkit, "nonceScript");
  assert.equal(nonceScript, objcStrings(chromium, "kNonce"), "both engines stamp the same way");
  const makeWorld = () => {
    const seen = { mutated: 0 };
    const context = vm.createContext({ crypto: { getRandomValues: (a) => a.fill(7) }, Uint8Array, Array, Object, seen });
    context.globalThis = context;
    return context;
  };
  const first = makeWorld();
  const nonce = vm.runInContext(nonceScript, first);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal(vm.runInContext(nonceScript, first), nonce, "stamping again keeps the document's nonce");
  const guard = (n, expression) => `(() => { if (globalThis.__ardiaDocNonce !== "${n}") return "__ardia_stale__"; return (\n${expression}\n); })()`;
  assert.match(webkit, /if \(globalThis.__ardiaDocNonce !== \\"\\\(nonce\)\\"\) return \\"\\\(stale\)\\"; return \(\\n\\\(expression\)\\n\); \}\)\(\)/, "WebKit wraps with the guard");
  assert.match(chromium, /if \(globalThis.__ardiaDocNonce !== \\"%@\\"\) return \\"%@\\"; return \(\\n%@\\n\); \}\)\(\)/, "Chromium wraps with the same guard");
  assert.equal(vm.runInContext(guard(nonce, "(seen.mutated++, true)"), first), true);
  const reloaded = makeWorld();
  assert.equal(vm.runInContext(guard(nonce, "(seen.mutated++, true)"), reloaded), "__ardia_stale__", "a same-address reload has a fresh world with no nonce, so the stale op aborts");
  assert.equal(reloaded.seen.mutated, 0, "before touching the replacement document");
  const run = webkit.slice(webkit.indexOf("static func guarded"), webkit.indexOf("static func staleTeardown"));
  assert.ok(run.length > 0);
  const tab = source("packages/ardiacore/ios/WebKitTab+PluginWorlds.swift");
  assert.match(tab, /evaluateJavaScript\(WebKitPluginWorldHandler\.guarded\(nonce, source\)/, "every WebKit run, styles included, goes through the guard");
  assert.match(tab, /evaluateJavaScript\(WebKitPluginWorldHandler\.guarded\(nonce, expression\)/, "and every post");
  assert.match(chromium, /Guarded\(nonce, expression\)/);
  assert.match(chromium, /Guarded\(nonce, kTake\)/, "a Chromium poll only takes messages from the stamped document");
});

test("worlds are per contribution, and a delivery checks the page address inside the world too", () => {
  assert.equal(worldOf("spa", "inbox"), "ardia-plugin:spa~inbox");
  assert.deepEqual(unitOfWorld("ardia-plugin:scope__name~Site_1"), { plugin: "scope__name", scriptId: "Site_1" });
  assert.deepEqual(unitOfWorld("ardia-plugin:spa"), { plugin: "spa", scriptId: null });
  assert.equal(unitOfWorld("ardia-plugin:spa~a~b"), null);
  assert.equal(worldOf("spa", "bad id"), null);
  const got = [];
  const context = vm.createContext({ setTimeout, clearTimeout, setInterval, clearInterval, EventTarget, console, location: { href: "https://mail.example/settings" }, document: { querySelectorAll: () => [] }, got, JSON, Object, Set, Promise, Error, TypeError, RangeError });
  context.globalThis = context;
  vm.runInContext(worldBootstrap("ardia-plugin:spa~site", "poll", "dtokensite01", "https://mail.example/settings", "doc"), context);
  vm.runInContext("globalThis.__ardiaWorld.bridgeFor('site').onMessage((m) => got.push(m))", context);
  assert.equal(vm.runInContext(worldDeliver("dtokensite01", JSON.stringify({ scriptId: "site", message: 1 }), "https://mail.example/inbox"), context), false, "a message the host checked for /inbox doesn't land once the page is on /settings");
  assert.equal(vm.runInContext(worldDeliver("dtokensite01", JSON.stringify({ scriptId: "site", message: 2 }), "https://mail.example/settings"), context), true);
  assert.deepEqual(got, [2]);
});

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
      { id: "site", matches: ["https://mail.example/*"], js: ["site.js"] },
    ],
  },
};

test("an SPA move off /inbox stops only the inbox contribution; the sitewide one keeps running and never runs twice", async () => {
  await enable(SPA);
  await activated("spa");
  const w = S().createWindow({ url: "https://mail.example/inbox" });
  const tab = activeTabId(S(), w);
  const web = fakeWeb("doc-1");
  webviews.set(tab, web);
  await reconcileTab(tab, consentToken());
  const runs = (id) => web.calls.filter((c) => c.world === worldOf("spa", id) && c.source?.includes("(function (ardia) {")).length;
  assert.deepEqual([runs("inbox"), runs("site")], [1, 1]);
  const tokenOf = (id) => /const doc = "([^"]+)"/.exec(web.calls.find((c) => c.world === worldOf("spa", id) && c.source?.includes("const doc = ")).source)[1];
  const site = tokenOf("site");
  const inbox = tokenOf("inbox");
  S().updateTab(tab, { url: "https://mail.example/settings" });
  await reconcileTab(tab, consentToken());
  const teardowns = web.calls.filter((c) => c.teardown);
  assert.deepEqual(teardowns.map((c) => c.world), [worldOf("spa", "inbox")], "only the inbox world is disposed");
  assert.ok(teardowns[0].teardown.includes(inbox));
  assert.deepEqual([runs("inbox"), runs("site")], [1, 1], "the sitewide script ran once, before the move, and wasn't restarted");
  assert.equal(web.reloads, 0);
  assert.equal(postToContent("spa", tab, { x: 1 }), null);
  const posts = web.calls.filter((c) => c.post);
  assert.deepEqual(posts.map((c) => c.world), [worldOf("spa", "site")], "a broadcast reaches only contributions that match now");
  assert.ok(posts[0].post.includes(JSON.stringify("https://mail.example/settings")), "and carries the address the world checks before dispatch");
  const before = host.events.length;
  const message = (scriptId, doc) => JSON.stringify([JSON.stringify({ doc, scriptId, message: scriptId })]);
  receiveWorldMessage(tab, worldOf("spa", "inbox"), "doc-1", message("inbox", inbox), consentToken());
  receiveWorldMessage(tab, worldOf("spa", "site"), "doc-1", message("site", site), consentToken());
  const delivered = host.events.slice(before).map((e) => JSON.parse(e.line)).filter((e) => e.event === "page.contentMessage");
  assert.deepEqual(delivered.map((e) => e.data.scriptId), ["site"]);
  webviews.delete(tab);
});

const PAGEY = { manifest: 2, name: "pagey", scope: "profile", title: "Pagey", main: "index.js", contributes: { panels: [{ id: "default", title: "Pagey", mode: "tab", file: "page/index.html" }] } };

test("a plugin page tab typed or restored in a profile the plugin isn't on in never wakes it, and its web storage is per profile", async () => {
  await enable(PAGEY);
  const a = S().createProfile({ name: "Work" });
  const b = S().createProfile({ name: "Home" });
  lifecycle.updateRecord("pagey", (r) => ({ ...r, profiles: [a] }), consentToken());
  await settle();
  const wb = S().createWindow({ profileId: b, url: "https://b.example/" });
  const typed = activeTabId(S(), wb);
  S().navigate(typed, "ardia://pagey", { userInitiated: true });
  await settle();
  const starts = host.starts.length;
  wakeForFilePage("pagey", "", S().tabs[typed].profileId);
  await settle();
  assert.equal(host.starts.length, starts, "a typed page in Profile B doesn't start the plugin");
  const wa = S().createWindow({ profileId: a, url: "https://a.example/" });
  const kept = openPluginPage(wa, "pagey");
  assert.ok(kept);
  await settle();
  assert.ok(host.starts.length > starts, "control: the same page in Profile A does wake it");
  lifecycle.disablePlugin("pagey", consentToken());
  await settledStops();
  assert.ok(lifecycle.requestPluginConsent("pagey"));
  assert.ok(lifecycle.enablePlugin("pagey", P().consent.hash));
  await settle();
  lifecycle.updateRecord("pagey", (r) => ({ ...r, profiles: [b] }), consentToken());
  await settle();
  const beforeRestore = host.starts.length;
  wakeForFilePage("pagey", "", S().tabs[kept].profileId);
  await settle();
  assert.equal(host.starts.length, beforeRestore, "after the grant is removed, a restored tab doesn't wake it either");
  const page = source("apps/browser/src/components/plugins/PluginPage.tsx");
  assert.match(page, /if \(active && !inProfile\) return <Notice/, "the page shows a notice instead of mounting the view");
  assert.match(page, /if \(eligible && active && inProfile && url\) wakeForFilePage\(name, path, profileId\)/);
  assert.equal(pluginStoreKey(P(), "pagey", a), a, "a profile-scoped plugin's page store is keyed by profile");
  assert.equal(pluginStoreKey(P(), "pagey", null), "");
  const view = source("packages/shell/ios/PluginPageView.swift");
  assert.match(view, /WKWebsiteDataStore\(forIdentifier: Self\.storeIdentifier\(plugin, key: key\)\)/);
  assert.match(view, /\|profile\|\\\(key\)/, "a profile key changes the store identity");
});

test("in-page routes keep the destination current, Back to the root document restores the root address, and typing the same address reloads", async () => {
  const READER = { manifest: 2, name: "reader", scope: "global", title: "Reader", main: "index.js", contributes: { panels: [{ id: "default", title: "Reader", mode: "tab", file: "page/index.html" }] } };
  await enable(READER);
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = openPluginPage(w, "reader", { path: "/inbox" });
  assert.equal(pageRouteOfView("reader", "ardia-plugin://reader/page/index.html"), "", "a view URL without ardiaPath is the root route");
  assert.equal(pageRouteOfView("reader", "ardia-plugin://reader/page/index.html?ardiaPath=..%2Fx"), null);
  routePluginPage(tab, "reader", "ardia-plugin://reader/page/index.html?ardiaPath=%2Fthread%2F7", pluginPageLoadSeq(S().tabs[tab]));
  assert.equal(tabDestination(S().tabs[tab]), "ardia://reader/thread/7", "the tab's destination follows the page's own route");
  const seq = pluginPageLoadSeq(S().tabs[tab]);
  routePluginPage(tab, "reader", "ardia-plugin://reader/page/index.html", pluginPageLoadSeq(S().tabs[tab]));
  assert.equal(S().tabs[tab].url, "ardia://reader", "Back to the root document puts the root address back");
  assert.equal(tabDestination(S().tabs[tab]), "ardia://reader");
  assert.equal(isSelfRouted(tab), true);
  assert.equal(pluginPageLoadSeq(S().tabs[tab]), seq, "routing doesn't count as a new load");
  S().navigate(tab, "ardia://reader", { userInitiated: true });
  assert.equal(isSelfRouted(tab), false, "typing the exact current address is a new navigation and loads fresh");
  assert.notEqual(pluginPageLoadSeq(S().tabs[tab]), seq);
  const page = source("apps/browser/src/components/plugins/PluginPage.tsx");
  assert.match(page, /<PluginFileView key=\{load\}/, "a new load remounts the view");
});

test("page menu items refresh when the tab's predicates change at the same address, and Chromium pins the menu document to the commit count", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = activeTabId(S(), w);
  const first = pageMenuKey(S(), tab);
  const other = S().newTab(w, { url: "https://a.example/b", background: true });
  assert.notEqual(pageMenuKey(S(), tab), first, "a new tab in the window changes tabCount");
  const counted = pageMenuKey(S(), tab);
  S().activate(other);
  assert.notEqual(pageMenuKey(S(), tab), counted, "isActive changes");
  const hook = source("apps/browser/src/state/plugins/hooks.ts");
  assert.match(hook, /const key = useBrowser\(\(s\) => pageMenuKey\(s, tabId\)\)/);
  const menu = source("packages/ardiacore/ios/ArdiaWebView+ContextMenu.mm");
  assert.match(menu, /committedDocumentCount/, "the cached document belongs to one commit");
  assert.match(menu, /NSString \*resolved = strong && \[strong pageMenuStillOn:count\] \? \(document \?: @""\) : @"";/, "a click after a navigation sends no stale document");
  assert.match(menu, /\+\+self\.pageMenuGeneration/, "each menu starts a fresh lookup");
});

const DROPPER = { manifest: 2, name: "dropper", scope: "global", title: "Dropper", main: "index.js", permissions: { files: "picker" }, contributes: { sidebarViews: [{ id: "v", title: "V" }] } };

test("a single-file drop with a MIME accept takes the first accepted file, not the first dropped one", async () => {
  await enable(DROPPER);
  await activated("dropper");
  const w = S().createWindow({ url: "https://a.example/" });
  await mountPluginSurface("dropper", "v#1", "sidebar", w, {}, "v");
  await settle();
  host.pickResult = {
    ok: true,
    files: [
      { name: "note.txt", size: 300000, mimeType: "text/plain", data: "", encoding: "base64", handle: "h1" },
      { name: "pic.png", size: 1, mimeType: "image/png", data: "AA==", encoding: "base64" },
    ],
  };
  const dropped = await dropFilesOnPluginView("dropper", "v#1", w, ["/tmp/note.txt", "/tmp/pic.png"], { accept: ["image/*"], multiple: false, maxBytes: null });
  assert.deepEqual(host.drops.at(-1).paths, ["/tmp/note.txt", "/tmp/pic.png"], "both are opened so their types can be checked");
  assert.deepEqual(dropped.map((f) => f.name), ["pic.png"]);
  assert.deepEqual(host.finishes.at(-1), { handle: "h1", commit: false }, "the rejected file's handle is closed");
  host.pickResult = { ok: false, reason: "you didn't pick a file", cancelled: true };
});

test("a page read of 3- and 4-byte UTF-8 text stays under the channel line in the page and again on the host", () => {
  const posted = [];
  const big = "中".repeat(150_000) + "😀".repeat(40_000);
  const text = (value) => ({ nodeType: 3, textContent: value });
  const node = (tagName, children = []) => ({ nodeType: 1, tagName, hidden: false, getAttribute: () => null, childNodes: children, children: children.filter((c) => c.nodeType === 1), innerText: children.map((c) => c.textContent ?? c.innerText ?? "").join("") });
  const paragraphs = Array.from({ length: 60 }, () => node("P", [text("中😀".repeat(3000))]));
  const document = {
    querySelector: (sel) => (sel === "article" ? node("ARTICLE", paragraphs) : null),
    querySelectorAll: () => [],
    body: { innerText: big },
    documentElement: { lang: "zh" },
    forms: [],
  };
  const context = vm.createContext({ document, window: { getSelection: () => big }, post: (_k, json) => posted.push(json), JSON, String, Number, Set, Math });
  vm.runInContext(pageReadScript({ markdown: true, metadata: false, selection: true, fullUrls: false }), context);
  const bytes = Buffer.byteLength(posted[0]);
  assert.ok(bytes <= 760_000, `${bytes} bytes`);
  const read = JSON.parse(posted[0]);
  assert.ok(read.text.length > 1000 && read.markdown.length > 1000 && read.selection.length > 100, "it keeps content instead of failing");
  assert.ok(!/[\ud800-\udbff]$/.test(read.text), "no half surrogate at the cut");
  const fitted = fittedRead({ text: "中".repeat(400_000), markdown: "😀".repeat(200_000), screenshot: { data: "A".repeat(200_000) } });
  assert.ok(byteLength(JSON.stringify(fitted)) <= READ_REPLY_BYTES, "the host trims what's left to fit too");
  assert.ok(fitted.text.length > 0);
});

test("liveness is a leaf lock: PluginHost never syncs onto its queue to answer isLive", () => {
  const hostSource = source("packages/shell/ios/PluginHost.swift");
  const isLive = hostSource.slice(hostSource.indexOf("func isLive"), hostSource.indexOf("\n", hostSource.indexOf("func isLive")));
  assert.match(isLive, /live\.contains\(name, run: run\)/);
  assert.doesNotMatch(hostSource, /queue\.sync\(execute: check\)/);
  assert.ok(hostSource.indexOf("self.live.markClosed(process.name, run: process.run)") < hostSource.indexOf("PluginNetChannels.shared.closeAll(process.name, run: process.run)"), "a run is marked closed before its resources are");
  const handles = source("packages/shell/ios/PluginCore/PluginFileHandles.swift");
  const write = handles.slice(handles.indexOf("func writeChunk"), handles.indexOf("func finish"));
  assert.match(write, /lock\.lock\(\)\n\s*let offset = handle\.written\n(?:[^\n]*\n){1,2}\s*if room \{ handle\.written = offset \+ data\.count \}\n\s*lock\.unlock\(\)/, "the write offset is reserved in the same lock hold");
});
