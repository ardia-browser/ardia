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
const { reconcileTab, postToContent, notePluginWorldCommit } = await import("./pageWorlds.ts");
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
setConsentPeriod(true, "plugins-v3-review-4-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 120_000;
const root = new URL("../../../../../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const key of ["starts", "stops", "replies", "events", "finishes", "drops", "picks"]) if (Array.isArray(host[key])) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: v3Text(doc), folderId: `folder-${doc.name}` }));
  host.files = { "spa/inbox.js": "setInterval(() => {}, 10);", "spa/site.js": "setInterval(() => {}, 10);", "early/boot.js": "1;" };
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

const scriptRuns = (web, world) => web.calls.filter((c) => c.world === world && c.source?.includes("(function (ardia) {"));

const EARLY = { manifest: 2, name: "early", scope: "global", title: "Early", main: "index.js", permissions: { pages: ["https://mail.example/*"] }, contributes: { contentScripts: [{ id: "boot", matches: ["https://mail.example/*"], js: ["boot.js"], runAt: "document_start" }] } };

test("a same-address reload doesn't re-inject document_start into the departing document; only a real commit starts a new record", async () => {
  await enable(EARLY);
  await activated("early");
  const w = S().createWindow({ url: "https://mail.example/inbox" });
  const tab = activeTabId(S(), w);
  const web = fakeWeb("doc-1");
  webviews.set(tab, web);
  await reconcileTab(tab, consentToken());
  assert.equal(scriptRuns(web, worldOf("early", "boot")).length, 1);
  S().updateLive(tab, { isLoading: true });
  await settle();
  await reconcileTab(tab, consentToken());
  assert.deepEqual(scriptRuns(web, worldOf("early", "boot")).map((c) => c.doc), ["doc-1"], "loading started, but the document is still the departing one: nothing runs again");
  web.document = "doc-2";
  notePluginWorldCommit(tab, 1234);
  await settle();
  assert.deepEqual(scriptRuns(web, worldOf("early", "boot")).map((c) => c.doc), ["doc-1", "doc-2"], "the commit brings exactly one injection into the new document");
  notePluginWorldCommit(tab, 1234);
  await settle();
  assert.equal(scriptRuns(web, worldOf("early", "boot")).length, 2, "the same commit reported twice changes nothing");
  S().updateLive(tab, { isLoading: false });
  webviews.delete(tab);
});

const SPA = {
  manifest: 2,
  name: "spa",
  scope: "global",
  title: "Spa",
  main: "index.js",
  permissions: { pages: ["https://mail.example/*"] },
  contributes: { contentScripts: [{ id: "site", matches: ["https://mail.example/*"], js: ["site.js"] }] },
};

test("a route change during a contribution's first evaluation leaves it unran, and it runs cleanly on the new route", async () => {
  await enable(SPA);
  await activated("spa");
  const w = S().createWindow({ url: "https://mail.example/inbox" });
  const tab = activeTabId(S(), w);
  const web = fakeWeb("doc-1");
  let first = true;
  const real = web.runPluginWorld;
  web.runPluginWorld = async (world, source, doc) => {
    if (first && source.includes("(function (ardia) {")) {
      first = false;
      web.calls.push({ world, source, doc, refused: true });
      S().updateTab(tab, { url: "https://mail.example/settings" });
      return false;
    }
    return real(world, source, doc);
  };
  webviews.set(tab, web);
  await reconcileTab(tab, consentToken());
  await settle(20);
  const runs = scriptRuns(web, worldOf("spa", "site"));
  assert.equal(runs.length, 2, "the refused run is tried again");
  assert.equal(runs.filter((c) => !c.refused).length, 1, "and it runs exactly once");
  assert.ok(runs.at(-1).source.includes(JSON.stringify("https://mail.example/settings")), "on the new route");
  assert.equal(postToContent("spa", tab, { x: 1 }, "site"), null, "it counts as running only once it actually ran");
  webviews.delete(tab);
});

test("a navigation event from an older load of a plugin page can't overwrite a newer explicit navigation", async () => {
  const READER = { manifest: 2, name: "reader", scope: "global", title: "Reader", main: "index.js", contributes: { panels: [{ id: "default", title: "Reader", mode: "tab", file: "page/index.html" }] } };
  await enable(READER);
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = openPluginPage(w, "reader", { path: "/inbox" });
  const oldLoad = pluginPageLoadSeq(S().tabs[tab]);
  assert.equal(routePluginPage(tab, "reader", "ardia-plugin://reader/page/index.html?ardiaPath=%2Fthread%2F7", oldLoad), true);
  S().navigate(tab, "ardia://reader/inbox", { userInitiated: true });
  const newLoad = pluginPageLoadSeq(S().tabs[tab]);
  assert.notEqual(newLoad, oldLoad);
  assert.equal(routePluginPage(tab, "reader", "ardia-plugin://reader/page/index.html?ardiaPath=%2Fthread%2F7", oldLoad), false, "the old view's late event is dropped");
  assert.equal(tabDestination(S().tabs[tab]), "ardia://reader/inbox", "the explicit navigation stands");
  assert.equal(isSelfRouted(tab), false, "and isn't mistaken for a route the page set");
  assert.equal(routePluginPage(tab, "reader", "ardia-plugin://reader/page/index.html?ardiaPath=%2Finbox%2F2", newLoad), true, "the new view's own events still route");
  const view = source("apps/browser/src/components/plugins/PluginFileView.tsx");
  assert.match(view, /routePluginPage\(tabId, plugin, e\.nativeEvent\.url, load\)/, "each view tags its events with the load it belongs to");
});

test("Chromium menu lookups keep their own waiting clicks and hand each one the document its lookup resolved", () => {
  const menu = source("packages/ardiacore/ios/ArdiaWebView+ContextMenu.mm");
  const note = menu.slice(menu.indexOf("- (void)notePageMenuDocument"), menu.indexOf("- (BOOL)pageMenuStillOn"));
  assert.match(note, /NSMutableArray<void \(\^\)\(NSString \*\)> \*waiting = \[NSMutableArray array\];\n\s*self\.pageMenuWaiting = waiting;/, "a fresh list per lookup");
  assert.match(note, /for \(void \(\^send\)\(NSString \*\) in \[waiting copy\]\) send\(resolved\);/, "each queued click gets its own lookup's document");
  assert.doesNotMatch(menu.slice(menu.indexOf("contextMenuCommand:(NSString *)itemId")), /strong\.pageMenuDocument/, "a queued click never reads the shared, mutable document");
});

test("a page read with a URL and title over 1 MB still comes back under the channel line", () => {
  const huge = fittedRead({ tabId: "t", url: `https://x.example/${"a".repeat(1_200_000)}`, title: "標".repeat(700_000), text: "x", selection: "中".repeat(400_000), lang: "en" });
  assert.ok(byteLength(JSON.stringify(huge)) <= READ_REPLY_BYTES, String(byteLength(JSON.stringify(huge))));
  assert.ok(byteLength(huge.url) <= 8 * 1024 && byteLength(huge.title) <= 4 * 1024 && byteLength(huge.selection) <= 64 * 1024);
  assert.equal(huge.text, "x", "what fits is kept");
  const worst = fittedRead({ tabId: "t", url: "u", title: "t", text: "\u0000".repeat(400_000), markdown: "\u0000".repeat(400_000) });
  assert.ok(byteLength(JSON.stringify(worst)) <= READ_REPLY_BYTES, "even text that escapes six times over fits");
});
