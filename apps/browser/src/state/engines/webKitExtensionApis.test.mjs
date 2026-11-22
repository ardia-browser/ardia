import assert from "node:assert/strict";
import { after, test } from "node:test";
import { nativeEvents } from "../../test-native/events.ts";

const channel = nativeEvents();
const replies = new Map();
const sentEvents = [];
const synced = [];
globalThis.acTestNativeModules = {
  ...globalThis.acTestNativeModules,
  ArdiaWebKit: {
    call: (verb, profile, json) => {
      const args = JSON.parse(json);
      if (verb === "extensionReply") replies.set(args.id, args.reply);
      if (verb === "extensionEvent") sentEvents.push({ profile, ...args.event });
      if (verb === "syncExtensions") synced.push(profile);
      return Promise.resolve(verb === "syncExtensions" ? JSON.stringify({ available: true, loaded: [], failed: [] }) : "null");
    },
    addListener: channel.addListener,
  },
};

const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
await import("./webKitExtensions.ts");
const { startWebKitCounts, takeEngineSwitchCounts } = await import("../telemetry/engineSwitchCounts.ts");
startWebKitCounts();
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const counted = (name) => emit("webKit.counted", { name, epoch: client.consentEpoch() });
const { engineCalls } = await import("../../test-native/ardiacore.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const S = () => useBrowser.getState();
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (name, data) => channel.emit("webKit", { name, data });
let calls = 0;

async function ask(api, method, args = [], extra = {}) {
  const id = `t${++calls}`;
  emit("webKit.extensionCall", { id, profile: "", base: "", private: false, extensionId: "abc", api, method, args, tabKeys: [], windows: [], ...extra });
  for (let i = 0; i < 50 && !replies.has(id); i++) await tick();
  const reply = replies.get(id);
  assert.ok(reply, `${api}.${method} answered`);
  if ("error" in reply) throw new Error(reply.error);
  return reply.result;
}

function windowWithTabs(...urls) {
  S().hydrate({});
  const w = S().createWindow({ url: urls[0] });
  const first = model.activeTabId(S(), w);
  const rest = urls.slice(1).map((url) => S().newTab(w, { url }));
  return { w, tabs: [first, ...rest] };
}

const listen = (apis) => emit("webKit.extensionListeners", { profile: "", base: "", private: false, apis });

test("bookmarks read and write the app's own bookmarks, with Chrome's root ids, and refuse what Chrome refuses", async () => {
  windowWithTabs("https://home.example/");
  try {
    useBrowser.setState({ bookmarksReady: {} });
    let answered = false;
    const early = ask("bookmarks", "getTree", []).then((tree) => ((answered = true), tree));
    await tick(5);
    assert.equal(answered, false, "a bookmark call waits until Chrome's bookmark numbers are in, so WebKit never hands out ids of its own");
    useBrowser.setState({ bookmarksReady: { "": true } });
    assert.equal((await early)[0].id, "0");
    useBrowser.setState({ bookmarksReady: {} });
    const late = ask("bookmarks", "create", [{ parentId: "1", title: "Never" }]);
    await tick(5);
    emit("webKit.extensionCallsCancelled", { ids: [`t${calls}`] });
    useBrowser.setState({ bookmarksReady: { "": true } });
    await assert.rejects(late, /turned off/, "a call WebKit cancelled while it waited doesn't act");
    assert.equal(Object.values(S().bookmarks.nodes).some((n) => n.title === "Never"), false);
  } finally {
    useBrowser.setState({ bookmarksReady: { "": true } });
  }
  const folder = await ask("bookmarks", "create", [{ parentId: "1", title: "Work" }]);
  assert.equal(folder.parentId, "1");
  const link = await ask("bookmarks", "create", [{ title: "Docs", url: "https://docs.example/" }]);
  assert.equal(link.parentId, "2", "Chrome files a bookmark without a parent under Other Bookmarks");
  assert.match(link.id, /^\d+$/, "Chrome's bookmark ids are numbers");
  const node = (title) => Object.values(S().bookmarks.nodes).find((n) => n.title === title);
  const moved = await ask("bookmarks", "move", [link.id, { parentId: folder.id, index: 0 }]);
  assert.deepEqual([moved.parentId, moved.index], [folder.id, 0]);
  assert.equal(node("Docs").parentId, node("Work").id);
  const [tree] = await ask("bookmarks", "getTree");
  assert.deepEqual(tree.children.map((c) => [c.id, c.folderType]), [["1", "bookmarks-bar"], ["2", "other"]]);
  assert.equal(tree.children[0].children[0].children[0].url, "https://docs.example/");
  assert.deepEqual((await ask("bookmarks", "search", ["docs"])).map((b) => b.id), [link.id]);
  await ask("bookmarks", "update", [link.id, { title: "Team Docs" }]);
  assert.equal((await ask("bookmarks", "get", [link.id]))[0].title, "Team Docs");
  await assert.rejects(ask("bookmarks", "remove", [folder.id]), /non-empty folder/);
  await assert.rejects(ask("bookmarks", "update", ["1", { title: "Mine" }]), /root bookmark folders/);
  await assert.rejects(ask("bookmarks", "get", ["nope"]), /Can't find bookmark/);
  const inner = await ask("bookmarks", "create", [{ parentId: folder.id, title: "Inner" }]);
  await assert.rejects(ask("bookmarks", "move", [folder.id, { parentId: inner.id }]), /into itself/);
  await assert.rejects(ask("bookmarks", "create", [{ parentId: folder.id, title: "Far", index: 9 }]), /out of bounds/);
  await assert.rejects(ask("bookmarks", "update", [folder.id, { url: "https://x.example/" }]), /URL of a bookmark folder/);
  await ask("bookmarks", "removeTree", [folder.id]);
  assert.equal(node("Work"), undefined);
  assert.equal(node("Team Docs"), undefined);
});

test("ids for bookmarks, downloads, history and groups come out the same after a relaunch, and old ids still find their item", async () => {
  const first = await import("./webKitExtensionData.ts?launch=1");
  const second = await import("./webKitExtensionData.ts?launch=2");
  for (const [kind, key] of [["bookmark", "5c1f6a1e-7d3b-4d55-9f3e-2b8a1f9e0c11"], ["download", "dl-1"], ["history", "https://a.example/"], ["group", "g-1"]]) {
    const id = first.numberFor(kind, key);
    assert.equal(second.numberFor(kind, key), id, kind);
    const fresh = await import(`./webKitExtensionData.ts?launch=${kind}`);
    assert.equal(fresh.keyFor(kind, String(id), () => ["other", key]), key, `${kind} found again by its old id`);
  }
  assert.ok(first.numberFor("bookmark", "x") > 2, "never one of Chrome's root folder ids");
});

test("bookmarks take Chromium's own ids from the engine's tree, while an id already handed out stays put", async () => {
  const data = await import("./webKitExtensionData.ts?chrome-ids=1");
  const kept = "aaaaaaaa-0000-4000-8000-000000000001";
  const before = data.numberFor("bookmark", kept);
  const tree = {
    bar: { id: "bar-root", n: "1", c: [{ id: "bbbbbbbb-0000-4000-8000-000000000002", n: "57", c: [{ id: kept, n: "58" }] }] },
    other: { id: "other-root", n: "2", c: [{ id: "cccccccc-0000-4000-8000-000000000003", n: "x" }, { id: "dddddddd-0000-4000-8000-000000000004" }] },
  };
  assert.equal(data.adoptChromeBookmarkNumbers(tree), 1);
  assert.equal(data.numberFor("bookmark", "bbbbbbbb-0000-4000-8000-000000000002"), 57);
  assert.equal(data.keyFor("bookmark", "57"), "bbbbbbbb-0000-4000-8000-000000000002");
  assert.equal(data.numberFor("bookmark", kept), before, "an extension may already hold the old id");
  assert.notEqual(data.numberFor("bookmark", "dddddddd-0000-4000-8000-000000000004"), undefined, "an older engine's tree keeps the stable hash");
  assert.equal(data.adoptChromeNumber("bookmark", "eeeeeeee-0000-4000-8000-000000000005", 57), false, "an id Chromium gave another bookmark isn't reused");
  assert.equal(data.adoptChromeBookmarkNumbers(tree), 0, "a second read adopts nothing new");
});

test("shared-state counts from WebKit reach the hourly usage counts, apart from the tab counts", async () => {
  takeEngineSwitchCounts();
  for (const name of ["extensionSharedCall", "extensionSharedCall", "extensionSharedFallback", "extensionGrantsLive", "extensionGrantWritten", "extensionDnrMirrored", "extensionTabCreate"]) {
    counted(name);
  }
  const counts = takeEngineSwitchCounts();
  assert.equal(counts.webkit_extension_shared_calls, 2);
  assert.equal(counts.webkit_extension_shared_fallbacks, 1);
  assert.equal(counts.webkit_extension_grants_live, 1);
  assert.equal(counts.webkit_extension_grants_written, 1);
  assert.equal(counts.webkit_extension_dnr_mirrors, 1);
  assert.equal(counts.webkit_extension_tab_creates, 1);
  assert.equal(takeEngineSwitchCounts().webkit_extension_shared_calls, 0);
});

test("tab groups act on the sidebar's groups through the tabs the extension names, and report changes", async () => {
  const { w, tabs } = windowWithTabs("https://a.example/", "https://b.example/", "https://c.example/");
  sentEvents.length = 0;
  listen(["tabGroups"]);
  const windows = [[tabs[0], tabs[1], tabs[2]]];
  const groupId = await ask("tabGroups", "group", [{ tabIds: [{ __tab: 0 }, { __tab: 1 }] }], { tabKeys: [tabs[0], tabs[1]], windows });
  assert.equal(typeof groupId, "number");
  const group = Object.values(S().groups).find((g) => g.tabIds.includes(tabs[0]));
  assert.deepEqual([...group.tabIds].sort(), [tabs[0], tabs[1]].sort());
  assert.equal(group.pinned, false);
  assert.deepEqual(await ask("tabGroups", "groupIdsOf", [], { tabKeys: tabs }), [groupId, groupId, -1]);
  const updated = await ask("tabGroups", "update", [groupId, { title: "Research", color: "cyan", collapsed: true }]);
  assert.deepEqual([updated.title, updated.color, updated.collapsed], ["Research", "cyan", true]);
  assert.deepEqual(updated.windowId.__windowTabs.sort(), [...S().windows[w].tabIds].sort());
  assert.equal((await ask("tabGroups", "query", [{ windowId: { __window: 0 } }], { windows })).length, 1);
  assert.equal((await ask("tabGroups", "query", [{ color: "red" }])).length, 0);
  await assert.rejects(ask("tabGroups", "move", [groupId, { index: 0 }]), /only move to the end/, "a position Ardia can't honour fails instead of reporting a move");
  assert.equal((await ask("tabGroups", "move", [groupId, { index: -1 }])).id, groupId);
  await ask("tabGroups", "ungroup", [{ tabIds: [{ __tab: 0 }, { __tab: 1 }] }], { tabKeys: [tabs[0], tabs[1]] });
  assert.equal(Object.values(S().groups).length, 0);
  await tick();
  assert.deepEqual(sentEvents.map((e) => e.event), ["onCreated", "onUpdated", "onRemoved"]);
  assert.ok(sentEvents.every((e) => e.api === "tabGroups" && e.profile === ""));
  await assert.rejects(ask("tabGroups", "get", [groupId]), /No group with id/);
  listen([]);
});

const download = (over) => ({ id: "wk-download-1", url: "https://files.example/a.zip", filename: "a.zip", path: "/tmp/a.zip", state: "downloading", paused: false, received: 10, total: 100, speed: 0, mimeType: "application/zip", profile: "", ...over });

test("downloads list the profile's downloads under stable numbers, follow their changes and wait for the one an extension started", async () => {
  windowWithTabs("https://home.example/");
  sentEvents.length = 0;
  listen(["downloads"]);
  S().upsertDownload(download());
  S().upsertDownload(download());
  S().upsertDownload(download({ id: "elsewhere", profile: "other", url: "https://files.example/b.zip" }));
  const [item] = await ask("downloads", "search", [{}]);
  assert.deepEqual([item.state, item.totalBytes, item.url], ["in_progress", 100, "https://files.example/a.zip"]);
  assert.equal((await ask("downloads", "search", [{ query: "b.zip" }])).length, 0, "another profile's downloads stay out of sight");
  S().upsertDownload(download({ state: "finished", received: 100 }));
  await tick();
  const changed = sentEvents.find((e) => e.event === "onChanged");
  assert.deepEqual(changed.args[0].state, { previous: "in_progress", current: "complete" });
  assert.equal(changed.args[0].id, item.id);
  const started = ask("downloads", "download", [{ url: "https://files.example/c.zip" }]);
  await tick(5);
  S().upsertDownload(download({ id: "wk-download-2", url: "https://files.example/c.zip", filename: "c.zip", path: "/tmp/c.zip" }));
  const newId = await started;
  assert.equal((await ask("downloads", "search", [{ id: newId }]))[0].url, "https://files.example/c.zip");
  const first = ask("downloads", "download", [{ url: "https://files.example/same.zip", id: "wk-download-same-1" }]);
  const second = ask("downloads", "download", [{ url: "https://files.example/same.zip", id: "wk-download-same-2" }]);
  await tick(5);
  S().upsertDownload(download({ id: "wk-download-same-2", url: "https://files.example/same.zip", filename: "same.zip", path: "/tmp/same 2.zip" }));
  S().upsertDownload(download({ id: "wk-download-same-1", url: "https://files.example/same.zip", filename: "same.zip", path: "/tmp/same.zip" }));
  const [firstId, secondId] = await Promise.all([first, second]);
  assert.notEqual(firstId, secondId, "two downloads of one URL each get their own id, whichever starts first");
  assert.equal((await ask("downloads", "search", [{ id: secondId }]))[0].filename, "/tmp/same 2.zip");
  assert.deepEqual(await ask("downloads", "erase", [{ id: item.id }]), [item.id]);
  await tick();
  assert.ok(sentEvents.some((e) => e.event === "onErased" && e.args[0] === item.id));
  await assert.rejects(ask("downloads", "pause", [item.id]), /Invalid download id/);
  listen([]);
});

test("history searches the profile's history the way Chrome does, last day by default, and reports new visits", async () => {
  windowWithTabs("https://home.example/");
  const now = Date.now();
  const entry = (url, title, lastVisit) => ({ url, title, favicon: null, visits: 1, lastVisit, visitTimes: [lastVisit] });
  const put = (list) => useBrowser.setState((s) => ({ history: { ...s.history, "": { list, floor: -Infinity, ready: true } } }));
  put([entry("https://news.example/", "News", now - 1000), entry("https://old.example/", "Old", now - 3 * 86_400_000)]);
  assert.deepEqual((await ask("history", "search", [{ text: "" }])).map((h) => h.url), ["https://news.example/"]);
  assert.deepEqual((await ask("history", "search", [{ text: "old", startTime: 0 }])).map((h) => h.title), ["Old"]);
  assert.equal((await ask("history", "getVisits", [{ url: "https://news.example/" }])).length, 1);
  sentEvents.length = 0;
  listen(["history"]);
  put([entry("https://fresh.example/", "Fresh", now), entry("https://news.example/", "News", now - 1000)]);
  await tick();
  assert.deepEqual(sentEvents.map((e) => [e.event, e.args[0].url ?? e.args[0].urls]), [
    ["onVisited", "https://fresh.example/"],
    ["onVisitRemoved", ["https://old.example/"]],
  ]);
  sentEvents.length = 0;
  const reload = (list) => useBrowser.setState((s) => ({ history: { ...s.history, "": { list, floor: -Infinity, ready: true, reloads: (s.history[""].reloads ?? 0) + 1 } } }));
  reload([entry("https://loaded.example/", "Loaded", now - 5000), entry("https://fresh.example/", "Fresh", now)]);
  await tick();
  assert.deepEqual(sentEvents, [], "reloading the window of history the browser keeps loaded is neither a visit nor a removal");
  reload([]);
  await tick();
  assert.deepEqual(sentEvents.map((e) => e.args[0]), [{ allHistory: true, urls: [] }], "a reload that finds history cleared still says so");
  sentEvents.length = 0;
  useBrowser.setState((s) => ({ history: { ...s.history, "": { list: [entry("https://during.example/", "During", now)], floor: -Infinity, ready: true, reloads: s.history[""].reloads + 1, replayed: ["https://during.example/"] } } }));
  await tick();
  assert.deepEqual(sentEvents.map((e) => [e.event, e.args[0].url]), [["onVisited", "https://during.example/"]], "a visit made while history reloaded is still reported");
  listen([]);
});

test("an unknown call is an error, not a hang, and native counts reach WebKit's telemetry", async () => {
  await assert.rejects(ask("history", "explode"), /isn't supported/);
  takeEngineSwitchCounts();
  for (const name of ["shimBookmarks", "shimBookmarks", "nativeHostLaunch", "privateExtensionLoaded", "somethingNew"]) counted(name);
  const counts = takeEngineSwitchCounts();
  assert.equal(counts.webkit_extension_bookmarks_calls, 2);
  assert.equal(counts.webkit_native_host_launches, 1);
  assert.equal(counts.webkit_private_extensions_loaded, 1);
});

test("a private window that opens before its profile synced asks for that profile's extensions", async () => {
  synced.length = 0;
  emit("webKit.extensionsWanted", { profile: "" });
  await tick(20);
  assert.deepEqual(synced, [""]);
});

function answerDialogs(...answers) {
  const asked = [];
  const original = shellNativeModules.ArdiaDialogs.confirm;
  shellNativeModules.ArdiaDialogs.confirm = (options) => (asked.push(options), Promise.resolve({ confirmed: answers.shift() ?? false, suppressed: false }));
  return { asked, restore: () => (shellNativeModules.ArdiaDialogs.confirm = original) };
}

const engineVerbs = (domain) => engineCalls.filter((c) => c.domain === domain).map((c) => c.verb);

test("an extension can't remove another extension without asking you, and a refusal comes back as its error", async () => {
  const extension = (id, name) => ({ id, name, enabled: true, mayModify: true, location: "INTERNAL", sites: [], permissions: [] });
  const uninstalled = [];
  globalThis.acTestUserScripts = {
    engine: { list: async () => [extension("abc", "Manager"), extension("other", "Victim")], uninstall: async (id) => void uninstalled.push(id) },
  };
  const dialogs = answerDialogs(false, true);
  try {
    await assert.rejects(ask("management", "uninstall", ["other"]), /canceled by user/);
    assert.deepEqual(uninstalled, []);
    await ask("management", "uninstall", ["other"]);
    assert.deepEqual(uninstalled, ["other"]);
    assert.match(dialogs.asked[0].message, /Manager/);
    await ask("management", "uninstallSelf");
    assert.deepEqual(uninstalled, ["other", "abc"]);
    assert.equal(dialogs.asked.length, 2, "removing itself asks nothing unless the extension wants it to");
  } finally {
    dialogs.restore();
    delete globalThis.acTestUserScripts;
  }
});

test("clearing browsing data for some sites is refused instead of clearing every site", async () => {
  engineCalls.length = 0;
  await assert.rejects(ask("browsingData", "removeCookies", [{ origins: ["https://one.example"] }]), /only some sites/);
  await assert.rejects(ask("browsingData", "remove", [{ excludeOrigins: ["https://keep.example"] }, { cookies: true }]), /only some sites/);
  assert.deepEqual(engineVerbs("profiles"), []);
  await ask("browsingData", "removeCache", [{}]);
  assert.deepEqual(engineVerbs("profiles"), ["clearBrowsingData"]);
});

test("clearing only cookies is refused instead of clearing every site's storage with them", async () => {
  engineCalls.length = 0;
  await assert.rejects(ask("browsingData", "removeCookies", [{}]), /only some kinds of site data/);
  await assert.rejects(ask("browsingData", "removeLocalStorage", [{}]), /only some kinds of site data/);
  await assert.rejects(ask("browsingData", "remove", [{}, { cookies: true, history: true }]), /only some kinds of site data/);
  assert.deepEqual(engineVerbs("profiles"), [], "nothing is cleared, history included, when part of the request can't be honoured");
  const settings = await ask("browsingData", "settings", []);
  await ask("browsingData", "remove", [{}, settings.dataToRemove]);
  assert.deepEqual(engineVerbs("profiles"), ["clearBrowsingData"], "everything Settings' defaults name, site data together, still goes");
});

test("a dangerous download is kept only after you agree, and a download opens only once it's finished", async () => {
  windowWithTabs("https://home.example/");
  S().upsertDownload(download({ id: "wk-danger", url: "https://files.example/x.dmg", path: "/tmp/x.dmg", dangerous: true }));
  const [item] = await ask("downloads", "search", [{ url: "https://files.example/x.dmg" }]);
  engineCalls.length = 0;
  const dialogs = answerDialogs(false, true);
  try {
    await ask("downloads", "acceptDanger", [item.id]);
    assert.deepEqual(engineVerbs("downloads"), []);
    await ask("downloads", "acceptDanger", [item.id]);
    assert.deepEqual(engineVerbs("downloads"), ["keep"]);
  } finally {
    dialogs.restore();
  }
  await assert.rejects(ask("downloads", "open", [item.id]), /must be complete/);
  await assert.rejects(ask("downloads", "search", [{ urlRegex: "(" }]), /Invalid query filter/);
});

test("an extension opens a finished download only after you agree, and a search can't stall the app with a runaway pattern", async () => {
  windowWithTabs("https://home.example/");
  S().upsertDownload(download({ id: "wk-done", url: "https://files.example/run.command", filename: "run.command", path: "/tmp/run.command", state: "finished" }));
  const [item] = await ask("downloads", "search", [{ url: "https://files.example/run.command" }]);
  const opened = [];
  const original = shellNativeModules.ArdiaSystem.openFile;
  shellNativeModules.ArdiaSystem.openFile = (path) => (opened.push(path), Promise.resolve(true));
  S().upsertDownload(download({ id: "wk-spoof", url: "https://files.example/spoof", filename: "invoice\u202Efdp.app\u0007", path: "/tmp/spoof", state: "finished" }));
  const [spoof] = await ask("downloads", "search", [{ url: "https://files.example/spoof" }]);
  globalThis.acTestUserScripts = { engine: { list: async () => [{ id: "abc", name: "Helper", enabled: true, mayModify: true, location: "INTERNAL", sites: [], permissions: [] }] } };
  const dialogs = answerDialogs(false, true, false);
  try {
    await assert.rejects(ask("downloads", "open", [item.id]), /didn't allow/);
    assert.deepEqual(opened, []);
    await ask("downloads", "open", [item.id]);
    assert.deepEqual(opened, ["/tmp/run.command"]);
    assert.match(dialogs.asked[0].title, /run\.command/);
    assert.match(dialogs.asked[0].message, /Helper/, "the prompt says which extension asks");
    await assert.rejects(ask("downloads", "open", [spoof.id]), /didn't allow/);
    assert.doesNotMatch(dialogs.asked[2].title, /[\u202A-\u202E\u2066-\u2069\u0000-\u001F\u007F]/, "a filename can't reorder or hide its own text");
    assert.match(dialogs.asked[2].title, /invoice.*fdp\.app/);
  } finally {
    dialogs.restore();
    shellNativeModules.ArdiaSystem.openFile = original;
    delete globalThis.acTestUserScripts;
  }
  for (const urlRegex of ["(a+)+$", "(?:x*)*y", "(a)\\1", "(?=a)a", "a".repeat(300), "(a|aa)+$", "(?:b|bb){2,}", "((a|b)c)*", ".*.*.*.*.*.*.*.*.*.*Z", "a+b+c+", "x{2,}y{3,}z{1,}", ".*a.*Z", "a{1,500}b{1,500}c{1,500}", "a?a?a?a?a?a?a?aaaaaaa"]) {
    await assert.rejects(ask("downloads", "search", [{ urlRegex }]), /Invalid query filter/, urlRegex);
  }
  assert.equal((await ask("downloads", "search", [{ urlRegex: "^https://files\\.example/run" }])).length, 1);
  assert.equal((await ask("downloads", "search", [{ urlRegex: "^https://.*\\.example/.*run(?:ner)?\\.d[a-z]{1,3}$" }])).length, 0);
});

test("a search from a private window stays in that private window", async () => {
  const { w, tabs } = windowWithTabs("https://home.example/");
  const priv = S().createWindow({ kind: "private", url: "https://secret.example/" });
  await ask("search", "query", [{ text: "needle", disposition: "NEW_TAB" }], { private: true, profile: model.engineProfile(S(), S().windows[priv].profileId) });
  assert.ok(S().windows[priv].tabIds.some((id) => /needle/.test(S().tabs[id].url)));
  assert.deepEqual(S().windows[w].tabIds, tabs);
});

test("only an api's own methods answer, never what every object inherits", async () => {
  await assert.rejects(ask("downloads", "constructor"), /isn't supported/);
  await assert.rejects(ask("bookmarks", "__proto__"), /isn't supported/);
});

test("a yes that comes after the extension stopped waiting removes nothing and keeps nothing", async () => {
  const extension = (id, name) => ({ id, name, enabled: true, mayModify: true, location: "INTERNAL", sites: [], permissions: [] });
  const uninstalled = [];
  globalThis.acTestUserScripts = {
    engine: { list: async () => [extension("abc", "Manager"), extension("other", "Victim")], uninstall: async (id) => void uninstalled.push(id) },
  };
  windowWithTabs("https://home.example/");
  S().upsertDownload(download({ id: "wk-late", url: "https://files.example/late.dmg", path: "/tmp/late.dmg", dangerous: true }));
  const [item] = await ask("downloads", "search", [{ url: "https://files.example/late.dmg" }]);
  const late = { answerBy: Date.now() - 1 };
  const dialogs = answerDialogs(true, true);
  engineCalls.length = 0;
  try {
    await assert.rejects(ask("management", "uninstall", ["other"], late), /timed out/);
    assert.deepEqual(uninstalled, []);
    await ask("downloads", "acceptDanger", [item.id], late);
    assert.deepEqual(engineVerbs("downloads"), []);
    assert.equal(dialogs.asked.length, 2);
  } finally {
    dialogs.restore();
    delete globalThis.acTestUserScripts;
  }
});
