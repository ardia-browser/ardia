import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const ios = new URL("../ios/", import.meta.url);
const raw = (text) => text.slice(text.indexOf('#"""') + 4, text.lastIndexOf('"""#'));
const swift = readFileSync(new URL("WebKitExtensionShim.swift", ios), "utf8");
const scripts = new Map(
  readdirSync(ios)
    .filter((f) => /^WebKitExtensionShim\+.+\.swift$/.test(f))
    .map((f) => readFileSync(new URL(f, ios), "utf8"))
    .map((text) => [text.match(/WebKitExtensionShimNamespace\(name: "([^"]+)"/)[1], raw(text).trim()]),
);
const order = swift
  .match(/static let namespaces: \[WebKitExtensionShimNamespace\] = \[([^\]]*)\]/)[1]
  .split(",")
  .map((n) => n.trim().replace(/^\./, ""))
  .filter(Boolean);
const APP = "dev.ardia.webkit";
const RELAY = "__ardiaWebKitRelay_0123456789abcdef";
assert.ok(swift.includes(`static let application = "${APP}"`));
assert.deepEqual([...scripts.keys()].sort(), [...order].sort(), "every namespace file is registered");
const shim = (apis, { permissions = apis, content = false, shared = [], contentFile = "" } = {}) =>
  raw(swift)
    .replace("__ARDIA_APP__", JSON.stringify(APP))
    .replace("__ARDIA_APIS__", JSON.stringify(apis))
    .replace("__ARDIA_PERMISSIONS__", JSON.stringify(permissions))
    .replace("__ARDIA_CONTENT__", String(content))
    .replace("__ARDIA_SHARED__", JSON.stringify(shared))
    .replace("__ARDIA_RELAY__", JSON.stringify(RELAY))
    .replace("__ARDIA_CONTENT_FILE__", JSON.stringify(contentFile))
    .replace("__ARDIA_NAMESPACES__", order.filter((n) => apis.includes(n)).map((n) => scripts.get(n)).join("\n"));

function load(apis, { answer = () => ({ result: null }), extra = {} } = {}) {
  const sent = [];
  const ports = [];
  const tabs = new Map([
    [11, { id: 11, windowId: 7, index: 0, url: "https://a.example/" }],
    [12, { id: 12, windowId: 9, index: 1, url: "https://b.example/" }],
  ]);
  const browser = {
    runtime: {
      sendNativeMessage: async (application, message) => {
        sent.push({ application, message });
        return answer(message);
      },
      connectNative: (application) => {
        const port = { application, posted: [], onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage: (m) => port.posted.push(m) };
        ports.push(port);
        return port;
      },
    },
    tabs: { get: async (id) => tabs.get(id), query: async () => [...tabs.values()] },
    windows: { getAll: async () => [{ id: 7 }, { id: 9 }], getCurrent: async () => ({ id: 9 }) },
    ...extra,
  };
  const context = { browser, chrome: browser, console, setTimeout, Promise, Object, Array, Set, Map, Error, JSON, String, Number };
  context.globalThis = context;
  vm.runInNewContext(shim(apis), context);
  return { browser, sent, ports };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const sansContext = ({ context, ...rest }) => (assert.equal(typeof context, "string"), plain(rest));

function listenerSet() {
  const set = new Set();
  return { addListener: (l) => set.add(l), fire: (...args) => [...set].forEach((l) => l(...args)) };
}

test("a callback-style call that fails sees runtime.lastError, and only while its callback runs", async () => {
  const sent = [];
  const browser = {
    runtime: { sendNativeMessage: async (application, message) => (sent.push(message), { error: "Can't find bookmark for id." }), connectNative: () => ({ onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage() {} }) },
    tabs: { get: async () => null, query: async () => [] },
    windows: { getAll: async () => [], getCurrent: async () => ({ id: 1 }) },
  };
  const context = { browser, chrome: browser, console, setTimeout, Promise, Object, Array, Set, Map, WeakMap, Error, JSON, String, Number };
  context.globalThis = context;
  vm.runInNewContext(shim(["bookmarks"]), context);
  const seen = await new Promise((resolve) => context.chrome.bookmarks.get("99", () => resolve(context.chrome.runtime.lastError && context.chrome.runtime.lastError.message)));
  assert.equal(seen, "Can't find bookmark for id.");
  assert.equal(context.chrome.runtime.lastError, undefined, "lastError is gone once the callback returns");
  await assert.rejects(context.chrome.bookmarks.get("99"), /Can't find bookmark/, "a promise caller still gets the rejection");
});

test("the shim adds only the APIs it was staged with, and never replaces one the engine has", () => {
  const ownHistory = { search: () => "engine" };
  const { browser } = load(["bookmarks", "history"], { extra: { history: ownHistory } });
  assert.equal(typeof browser.bookmarks.getTree, "function");
  assert.equal(browser.history, ownHistory);
  assert.equal(browser.downloads, undefined);
  assert.equal(browser.tabGroups, undefined);
});

test("a call goes to Ardia's application id and resolves with the reply, or rejects with its error, or answers a callback", async () => {
  let reply = { result: [{ id: "0", title: "" }] };
  const { browser, sent } = load(["bookmarks"], { answer: () => reply });
  assert.deepEqual(plain(await browser.bookmarks.getTree()), [{ id: "0", title: "" }]);
  assert.equal(sent[0].application, APP);
  assert.deepEqual(sansContext(sent[0].message), { ardia: 1, api: "bookmarks", method: "getTree", args: [], tabs: [], activation: false });
  reply = { error: "Can't find bookmark for id." };
  await assert.rejects(browser.bookmarks.get("99"), /Can't find bookmark/);
  reply = { result: { id: "5" } };
  const called = await new Promise((resolve) => assert.equal(browser.bookmarks.create({ title: "x" }, resolve), undefined));
  assert.deepEqual(plain(called), { id: "5" });
});

test("tab and window ids cross as positions the app can resolve, and window refs come back as the extension's window ids", async () => {
  const { browser, sent } = load(["tabGroups"], {
    answer: (m) => (m.method === "query" ? { result: [{ id: 3, windowId: { __windowTabs: ["t2"] } }], windows: [["t1"], ["t2", "t3"]] } : { result: 4 }),
  });
  assert.equal(await browser.tabs.group({ tabIds: [12, 11] }), 4);
  const group = plain(sent[0].message);
  assert.deepEqual(group.args, [{ tabIds: [{ __tab: 0 }, { __tab: 1 }] }]);
  assert.deepEqual(group.tabs, [
    { window: 1, index: 1, url: "https://b.example/" },
    { window: 0, index: 0, url: "https://a.example/" },
  ]);
  const groups = await browser.tabGroups.query({ windowId: -2 });
  assert.deepEqual(plain(sent[1].message.args), [{ windowId: { __window: 1 } }]);
  assert.equal(groups[0].windowId, 9);
});

test("tabs.query and tabs.get gain groupId, and tabs.query filters by it", async () => {
  const { browser } = load(["tabGroups"], { answer: (m) => (m.method === "groupIdsOf" ? { result: m.tabs.map((t) => (t.index === 1 ? 4 : -1)) } : { result: null }) });
  const all = await browser.tabs.query({});
  assert.deepEqual(plain(all.map((t) => t.groupId)), [-1, 4]);
  assert.deepEqual(plain((await browser.tabs.query({ groupId: 4 })).map((t) => t.id)), [12]);
  assert.equal((await browser.tabs.get(11)).groupId, -1);
});

test("listening opens one port to Ardia, says which APIs it wants, and hands events to the listeners", async () => {
  const { browser, ports } = load(["bookmarks", "downloads"]);
  const seen = [];
  const created = (id, node) => seen.push([id, node.title]);
  browser.bookmarks.onCreated.addListener(created);
  browser.downloads.onChanged.addListener(() => {});
  assert.equal(ports.length, 1);
  assert.equal(ports[0].application, APP);
  assert.deepEqual(sansContext(ports[0].posted.at(-1)), { ardia: 1, listen: ["bookmarks", "downloads"] });
  ports[0].onMessage.fire({ ardia: 1, api: "bookmarks", event: "onCreated", args: ["8", { title: "Docs" }], windows: [] });
  ports[0].onMessage.fire({ ardia: 1, api: "history", event: "onVisited", args: [{}] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen, [["8", "Docs"]]);
  assert.equal(browser.bookmarks.onCreated.hasListener(created), true);
  browser.bookmarks.onCreated.removeListener(created);
  assert.deepEqual(sansContext(ports[0].posted.at(-1)), { ardia: 1, listen: ["downloads"] });
});

test("without sendNativeMessage (a content script or sandboxed page) the shim leaves the page alone", () => {
  const browser = { runtime: {} };
  const context = { browser, chrome: browser, Object };
  context.globalThis = context;
  vm.runInNewContext(shim(["bookmarks"]), context);
  assert.equal(browser.bookmarks, undefined);
});

function world({ apis, permissions = apis, content = false, background = false, shared = [], contentFile = "", runtime = {}, extra = {}, activation, answer = () => ({ result: null }) }) {
  const sent = [];
  const ports = [];
  const relayed = [];
  const onMessage = listenerSet();
  const browser = {
    runtime: {
      id: "aaaabbbbccccddddeeeeffffgggghhhh",
      sendMessage: async () => "local",
      connect: (info) => {
        if (!info || info.name !== `${RELAY}:call`) return "local port";
        const port = {
          onMessage: listenerSet(),
          onDisconnect: listenerSet(),
          postMessage: ({ call, message }) => {
            relayed.push(message);
            Promise.resolve(answer(message)).then((reply) => port.onMessage.fire({ answer: call, reply }));
          },
        };
        return port;
      },
      onMessage,
      ...(content
        ? {}
        : {
            sendNativeMessage: async (application, message) => (sent.push(message), answer(message)),
            connectNative: () => {
              const port = { posted: [], onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage: (m) => port.posted.push(m) };
              ports.push(port);
              return port;
            },
          }),
      ...runtime,
    },
    ...extra,
  };
  const context = { browser, chrome: browser, console, setTimeout, Promise, Object, Array, Set, Map, WeakMap, Error, JSON, String, Number, Date, Math, RegExp };
  if (background) context.__ardiaWebKitBackground = typeof background === "string" ? background : true;
  if (activation !== undefined) context.navigator = { userActivation: { isActive: activation } };
  context.location = { href: `webkit-extension://${browser.runtime.id}/${background === true || !background ? "page.html" : "__ardia_webkit_worker.js"}` };
  context.globalThis = context;
  const source = shim(apis, { permissions, content, shared, contentFile });
  vm.runInNewContext(source, context);
  return { browser, sent, ports, relayed, onMessage, context, source };
}

test("a content script's calls reach Ardia only through its own relay port, and a page's data posted as a runtime message never does", async () => {
  const onConnect = listenerSet();
  const back = world({ apis: ["runtime", "storage"], permissions: ["storage"], background: "bg.js", runtime: { onConnect }, extra: { storage: {} }, answer: (m) => ({ result: { asked: m.method } }) });
  const seenMessages = [];
  const seenPorts = [];
  back.browser.runtime.onMessage.addListener((message) => seenMessages.push(message));
  back.browser.runtime.onConnect.addListener((port) => seenPorts.push(port.name));
  const forged = { [RELAY]: { ardia: 1, api: "storage", method: "sharedSet", args: ["local", { allow: true }] } };
  back.onMessage.fire(forged, { id: back.browser.runtime.id, url: "https://page.example/a" }, () => {});
  const sender = { id: back.browser.runtime.id, url: "https://page.example/a", origin: "https://page.example" };
  const callPort = { name: `${RELAY}:call`, sender, posted: [], onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage: (m) => callPort.posted.push(m) };
  onConnect.fire(callPort);
  onConnect.fire({ name: "mine", sender: { id: back.browser.runtime.id }, onMessage: listenerSet(), onDisconnect: listenerSet() });
  callPort.onMessage.fire({ call: 4, message: { ardia: 1, api: "storage", method: "managedGet", args: [null], relayed: false } });
  await tick();
  assert.deepEqual(plain(seenMessages), [forged], "a forwarded page message stays the extension's own data");
  assert.deepEqual(seenPorts, ["mine"], "the extension's own onConnect never sees the relay");
  assert.deepEqual(plain(back.sent), [
    { ardia: 1, api: "storage", method: "managedGet", args: [null], relayed: true, relayedFrom: { url: "https://page.example/a", origin: "https://page.example" } },
  ]);
  assert.deepEqual(plain(callPort.posted), [{ answer: 4, reply: { result: { asked: "managedGet" } } }]);

  const page = world({ apis: ["runtime", "storage"], permissions: ["storage"], content: true, extra: { storage: {} }, answer: () => ({ result: { policy: 1 } }) });
  assert.deepEqual(plain(await page.browser.storage.managed.get()), { policy: 1 });
  assert.equal(page.relayed.length, 1);
  await assert.rejects(page.browser.storage.managed.set({ a: 1 }), /read-only store/);
  assert.equal(page.browser.downloads, undefined);
});

test("messages to another extension go through Ardia with Chrome's sender, and messages to itself stay local", async () => {
  const { browser, sent } = world({ apis: ["runtime"], background: "bg.js", answer: (m) => ({ result: m.method === "sendExternal" ? { pong: true } : null }) });
  assert.equal(await browser.runtime.sendMessage({ to: "self" }), "local");
  assert.equal(await browser.runtime.sendMessage(browser.runtime.id, { to: "self" }), "local");
  assert.deepEqual(plain(await browser.runtime.sendMessage("zzzzbbbbccccddddeeeeffffgggghhhh", { ping: 1 })), { pong: true });
  const call = sent.find((m) => m.method === "sendExternal");
  assert.deepEqual(plain(call.args), [
    "zzzzbbbbccccddddeeeeffffgggghhhh",
    { ping: 1 },
    { url: "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/bg.js", origin: "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh", content: false },
  ]);
});

test("an extension answers another extension's message with sendResponse, and says when nothing answered", async () => {
  const { browser, ports } = world({ apis: ["runtime"], background: true });
  browser.runtime.onMessageExternal.addListener((message, sender, reply) => {
    if (message.later) {
      setTimeout(() => reply({ late: sender.id }), 1);
      return true;
    }
    if (message.now) reply({ now: true });
  });
  assert.deepEqual(plain(ports[0].posted.at(-1).listen), ["runtime"]);
  const fire = (message) => ports[0].onMessage.fire({ ardia: 1, signal: "message", request: `r${message.n}`, message, sender: { id: "other" } });
  fire({ n: 1, now: true });
  fire({ n: 2, later: true });
  fire({ n: 3 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const replies = Object.fromEntries(ports[0].posted.filter((m) => m.reply).map((m) => [m.reply, plain(m)]));
  assert.deepEqual(replies.r1.response, { now: true });
  assert.deepEqual(replies.r2.response, { late: "other" });
  assert.equal(replies.r3.responded, false);
  assert.equal(replies.r3.listened, true);
});

test("a Chrome-only member survives the engine making a fresh namespace object, as WebKit does after a collection", async () => {
  class Commands {
    getAll() {
      return Promise.resolve([{ name: "engine" }]);
    }
  }
  const browser = { runtime: { id: "x", sendNativeMessage: async () => ({ result: [{ name: "go", shortcut: "⌃⇧U" }] }) } };
  let made = new Commands();
  Object.defineProperty(browser, "commands", { get: () => made });
  const context = { browser, chrome: browser, console, setTimeout, Promise, Object, Array, Set, Map, WeakMap, Error, JSON, String, Number, Date, Math, RegExp };
  context.globalThis = context;
  vm.runInNewContext(shim(["commands"]), context);
  made = new Commands();
  assert.deepEqual(plain(await browser.commands.getAll()), [{ name: "go", shortcut: "⌃⇧U" }]);
});

test("Ardia's void answers come back as undefined, as Chrome's do", async () => {
  const { browser } = world({ apis: ["idle"], answer: () => ({ result: null }) });
  assert.equal(await browser.idle.setDetectionInterval(30), undefined);
});

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function area(log, name) {
  return {
    QUOTA_BYTES: 10485760,
    get: async (keys) => (log.push([name, "get", keys]), { from: "webkit" }),
    set: async (items) => void log.push([name, "set", items]),
    remove: async (keys) => void log.push([name, "remove", keys]),
    clear: async () => void log.push([name, "clear"]),
    getBytesInUse: async () => 7,
    getKeys: async () => ["webkit"],
    onChanged: listenerSet(),
  };
}

function webKitStorage(log) {
  return { local: area(log, "local"), sync: area(log, "sync"), session: area(log, "session"), onChanged: listenerSet() };
}

test("with Chromium's storage, every area reads and writes through Ardia without looking up windows, and keeps its constants", async () => {
  const log = [];
  let windowLookups = 0;
  const { browser, sent } = world({
    apis: ["runtime", "storage"],
    permissions: ["storage"],
    shared: ["storage"],
    extra: { storage: webKitStorage(log), windows: { getAll: async () => (windowLookups++, []) } },
    answer: (m) => ({ result: m.method === "sharedGet" ? { a: 1 } : m.method === "sharedBytesInUse" ? 42 : null }),
  });
  assert.deepEqual(plain(await browser.storage.local.get(["a"])), { a: 1 });
  assert.equal(await browser.storage.sync.set({ b: 2 }), undefined);
  assert.equal(await browser.storage.session.getBytesInUse(), 42);
  await browser.storage.local.remove("a");
  assert.equal(browser.storage.local.QUOTA_BYTES, 10485760);
  assert.deepEqual(
    sent.map((m) => [m.api, m.method, plain(m.args)]),
    [
      ["storage", "sharedGet", ["local", ["a"], false]],
      ["storage", "sharedSet", ["sync", { b: 2 }, false]],
      ["storage", "sharedBytesInUse", ["session", null, false]],
      ["storage", "sharedRemove", ["local", "a", false]],
    ],
  );
  assert.equal(windowLookups, 0);
  assert.deepEqual(log, [], "WebKit's own storage is never touched");
});

test("an engine without the storage calls sends the extension back to WebKit's own storage, once and for good", async () => {
  const log = [];
  const { browser, sent } = world({
    apis: ["runtime", "storage"],
    permissions: ["storage"],
    shared: ["storage"],
    extra: { storage: webKitStorage(log) },
    answer: () => ({ error: "__ardia_unshared__" }),
  });
  assert.deepEqual(plain(await browser.storage.local.get("k")), { from: "webkit" });
  await browser.storage.local.set({ k: 1 });
  assert.equal(sent.length, 1, "only the first call asked Ardia");
  assert.deepEqual(plain(log), [["local", "get", "k"], ["local", "set", { k: 1 }]]);
  await assert.rejects(world({ apis: ["storage"], shared: ["storage"], extra: { storage: webKitStorage([]) }, answer: () => ({ error: "QUOTA_BYTES quota exceeded" }) }).browser.storage.local.set({ x: 1 }), /quota exceeded/);
});

test("without the shared flag the areas stay WebKit's own", () => {
  const storage = webKitStorage([]);
  const local = storage.local;
  const { browser } = world({ apis: ["runtime", "storage"], permissions: ["storage"], extra: { storage } });
  assert.equal(browser.storage.local, local);
});

test("on WebKit, whose namespaces ignore redefining their own members, the shim's overrides reach the extension through a view of chrome, and browser stays WebKit's own", async () => {
  const stubborn = (object) => new Proxy(object, { defineProperty: () => true, set: () => true });
  const log = [];
  const areas = webKitStorage(log);
  const storage = stubborn({ local: stubborn(areas.local), sync: stubborn(areas.sync), session: stubborn(areas.session), onChanged: areas.onChanged });
  const sent = [];
  const runtime = stubborn({
    id: "aaaabbbbccccddddeeeeffffgggghhhh",
    sendMessage: async () => "local",
    onMessage: listenerSet(),
    sendNativeMessage: async (application, message) => (sent.push(message), { result: message.method === "sharedGet" ? { a: 1 } : null }),
    connectNative: () => ({ posted: [], onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage() {} }),
    getManifest() {
      if (this !== runtime) throw new TypeError("Illegal invocation");
      return { version: "1.0" };
    },
  });
  const native = stubborn({ runtime, storage });
  const context = { browser: native, chrome: native, console, setTimeout, Promise, Object, Array, Set, Map, WeakMap, Error, JSON, String, Number, Date, Math, RegExp };
  context.location = { href: `webkit-extension://${runtime.id}/page.html` };
  context.globalThis = context;
  vm.runInNewContext(shim(["runtime", "storage"], { permissions: ["storage"], shared: ["storage"] }), context);
  const chrome = context.chrome;
  assert.notEqual(chrome, native, "the global is a view of WebKit's namespace");
  assert.equal(context.browser, native, "WebKit delivers runtime messages and ports through its own browser, so a view there drops them");
  assert.equal(chrome.storage, chrome.storage);
  assert.equal(chrome.storage.local, chrome.storage.local);
  assert.deepEqual(plain(await chrome.storage.local.get(["a"])), { a: 1 });
  await chrome.storage.sync.set({ b: 2 });
  assert.deepEqual(sent.map((m) => [m.api, m.method]), [["storage", "sharedGet"], ["storage", "sharedSet"]]);
  assert.deepEqual(log, [], "WebKit's own storage is never touched");
  assert.equal(chrome.storage.local.QUOTA_BYTES, 10485760);
  assert.equal(chrome.runtime.getManifest().version, "1.0", "WebKit's own methods still run on their own object");
  assert.equal(chrome.runtime.getManifest, chrome.runtime.getManifest);
  assert.equal(native.storage.local.get, areas.local.get, "WebKit's namespace itself is left as it was");
});

test("a view serves overrides over WebKit members that can't be reconfigured, and keeps direct patches when WebKit hands out a fresh namespace", async () => {
  const log = [];
  const areas = webKitStorage(log);
  const storage = {};
  for (const name of ["local", "sync", "session"]) Object.defineProperty(storage, name, { value: areas[name], writable: false, configurable: false, enumerable: true });
  Object.defineProperty(storage, "onChanged", { value: areas.onChanged, writable: false, configurable: false });
  const sent = [];
  const runtimeFields = () => ({
    id: "aaaabbbbccccddddeeeeffffgggghhhh",
    sendMessage: async () => "local",
    onMessage: listenerSet(),
    sendNativeMessage: async (application, message) => (sent.push(message), { result: message.method === "sharedGet" ? { a: 1 } : null }),
    connectNative: () => ({ posted: [], onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage() {} }),
  });
  let runtime = runtimeFields();
  const native = {};
  Object.defineProperty(native, "runtime", { get: () => runtime, configurable: false, enumerable: true });
  Object.defineProperty(native, "storage", { value: storage, writable: false, configurable: false, enumerable: true });
  const context = { browser: native, chrome: native, console, setTimeout, Promise, Object, Array, Set, Map, WeakMap, Error, JSON, String, Number, Date, Math, RegExp };
  context.location = { href: `webkit-extension://${runtime.id}/page.html` };
  context.globalThis = context;
  vm.runInNewContext(shim(["runtime", "storage"], { permissions: ["storage"], shared: ["storage"] }), context);
  const chrome = context.chrome;
  assert.deepEqual(plain(await chrome.storage.local.get(["a"])), { a: 1 });
  assert.deepEqual(log, []);
  const patchedUninstall = chrome.runtime.setUninstallURL;
  assert.equal(typeof patchedUninstall, "function");
  runtime = runtimeFields();
  assert.equal(chrome.runtime.setUninstallURL, patchedUninstall, "a fresh runtime object still gets the shim's member");
  assert.ok(Object.keys(chrome.storage).includes("local"));
});

test("Chromium's storage changes reach the area's and the namespace's listeners, filtered by area", async () => {
  const { browser, ports } = world({ apis: ["runtime", "storage"], permissions: ["storage"], shared: ["storage"], background: "bg.js", extra: { storage: webKitStorage([]) } });
  const local = [];
  const all = [];
  browser.storage.local.onChanged.addListener((changes) => local.push(changes));
  browser.storage.onChanged.addListener((changes, areaName) => all.push([changes, areaName]));
  assert.equal(ports.length, 1);
  assert.ok(ports[0].posted.at(-1).listen.includes("storage"));
  const change = { a: { newValue: 2, oldValue: 1 } };
  ports[0].onMessage.fire({ ardia: 1, api: "storage", event: "onChanged", args: [change, "sync"], windows: [] });
  ports[0].onMessage.fire({ ardia: 1, api: "storage", event: "onChanged", args: [change, "local"], windows: [] });
  await tick();
  assert.deepEqual(plain(local), [change]);
  assert.deepEqual(plain(all), [[change, "sync"], [change, "local"]]);
});

test("a content script listening to storage reaches Ardia through a relay port its background pipes to Ardia", async () => {
  const connected = [];
  const contentPort = { posted: [], onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage: (m) => contentPort.posted.push(m) };
  const page = world({
    apis: ["runtime", "storage"],
    permissions: ["storage"],
    shared: ["storage"],
    content: true,
    runtime: { connect: (info) => (connected.push(info), contentPort) },
    extra: { storage: webKitStorage([]) },
  });
  const heard = [];
  page.browser.storage.onChanged.addListener((changes, areaName) => heard.push(areaName));
  assert.deepEqual(plain(connected), [{ name: RELAY }]);
  assert.deepEqual(plain(contentPort.posted.at(-1).listen), ["storage"]);
  contentPort.onMessage.fire({ ardia: 1, api: "storage", event: "onChanged", args: [{}, "local"], windows: [] });
  await tick();
  assert.deepEqual(heard, ["local"]);

  const onConnect = listenerSet();
  const back = world({ apis: ["runtime"], background: "bg.js", runtime: { onConnect } });
  const own = [];
  back.browser.runtime.onConnect.addListener((port) => own.push(port.name));
  const relay = { name: RELAY, sender: { id: back.browser.runtime.id, url: "https://page.example/" }, posted: [], onMessage: listenerSet(), onDisconnect: listenerSet(), postMessage: (m) => relay.posted.push(m), disconnect() {} };
  onConnect.fire(relay);
  onConnect.fire({ name: "mine", sender: { id: back.browser.runtime.id }, onMessage: listenerSet(), onDisconnect: listenerSet() });
  assert.deepEqual(own, ["mine"], "the extension's own onConnect never sees the relay");
  assert.equal(back.ports.length, 1);
  relay.onMessage.fire({ ardia: 1, listen: ["storage"], context: "c" });
  back.ports[0].onMessage.fire({ ardia: 1, api: "storage", event: "onChanged", args: [] });
  assert.deepEqual(plain(back.ports[0].posted), [{ ardia: 1, listen: ["storage"], context: "c", relayed: true, relayedFrom: { url: "https://page.example/", origin: "" } }]);
  assert.deepEqual(plain(relay.posted), [{ ardia: 1, api: "storage", event: "onChanged", args: [] }]);
});

test("alarms live in Chromium: they're made there, WebKit's own are cleared, and onAlarm fires only when Chromium's alarm goes off", async () => {
  const cleared = [];
  const webKitAlarm = listenerSet();
  const original = { clearAll: async () => cleared.push("all"), create: async () => cleared.push("webkit create"), onAlarm: webKitAlarm };
  const { browser, sent, ports } = world({ apis: ["runtime", "alarms"], shared: ["alarms"], background: "bg.js", extra: { alarms: original }, answer: (m) => ({ result: m.method === "getAll" ? [{ name: "x" }] : null }) });
  await tick();
  assert.deepEqual(cleared, ["all"]);
  const fired = [];
  browser.alarms.onAlarm.addListener((alarm) => fired.push(alarm));
  webKitAlarm.fire({ name: "stray" });
  await browser.alarms.create("tick", { periodInMinutes: 1 });
  await browser.alarms.create({ delayInMinutes: 2 });
  await assert.rejects(browser.alarms.create("a", { name: "b", when: 1 }), /both separate argument and object form/);
  assert.deepEqual(plain(await browser.alarms.getAll()), [{ name: "x" }]);
  assert.deepEqual(
    sent.filter((m) => m.api === "alarms").map((m) => [m.method, plain(m.args)]),
    [["create", ["tick", { periodInMinutes: 1 }]], ["create", ["", { delayInMinutes: 2 }]], ["getAll", []]],
  );
  assert.deepEqual(fired, [], "WebKit's own alarms never fire");
  assert.equal(ports.length, 1, "an onAlarm listener keeps the background reachable");
  assert.ok(ports[0].posted.at(-1).listen.includes("alarms"));
  ports[0].onMessage.fire({ ardia: 1, signal: "alarm", alarm: { name: "tick", scheduledTime: 60000, periodInMinutes: 1 } });
  await tick();
  assert.deepEqual(plain(fired), [{ name: "tick", scheduledTime: 60000, periodInMinutes: 1 }]);
});

test("alarms fall back to WebKit's own when the engine can't keep them, listeners included", async () => {
  const webKitAlarm = listenerSet();
  const made = [];
  const original = { clearAll: async () => {}, create: async (...args) => made.push(args), onAlarm: webKitAlarm };
  const { browser } = world({ apis: ["runtime", "alarms"], shared: ["alarms"], extra: { alarms: original }, answer: () => ({ error: "__ardia_unshared__" }) });
  const fired = [];
  browser.alarms.onAlarm.addListener((alarm) => fired.push(alarm.name));
  await browser.alarms.create("tick", { when: 5 });
  webKitAlarm.fire({ name: "tick" });
  assert.deepEqual(plain(made), [["tick", { when: 5 }]]);
  assert.deepEqual(fired, ["tick"]);
});

test("WebKit's first install of an extension Chromium already has arrives as an update, and setUninstallURL is left to Chromium", async () => {
  const onInstalled = listenerSet();
  const { browser, sent } = world({ apis: ["runtime"], background: "bg.js", runtime: { onInstalled, getManifest: () => ({ version: "4.2" }), setUninstallURL: () => "webkit" } });
  const seen = [];
  browser.runtime.onInstalled.addListener((details) => seen.push(details));
  onInstalled.fire({ reason: "install" });
  onInstalled.fire({ reason: "update", previousVersion: "4.1" });
  assert.deepEqual(plain(seen), [{ reason: "update", previousVersion: "4.2" }, { reason: "update", previousVersion: "4.1" }]);
  assert.equal(await browser.runtime.setUninstallURL("https://bye.example/"), undefined);
  assert.equal(sent.length, 0);
});

test("the background copies Chromium's dynamic, session and ruleset state into WebKit's rules, and again when Chromium changes them", async () => {
  const calls = [];
  let dynamic = [{ id: 1, action: { type: "block" }, condition: { urlFilter: "old" } }];
  let rulesets = ["a"];
  const dnr = {
    getDynamicRules: async () => dynamic,
    updateDynamicRules: async (options) => (calls.push(["dynamic", options]), (dynamic = options.addRules)),
    getSessionRules: async () => [],
    updateSessionRules: async (options) => calls.push(["session", options]),
    getEnabledRulesets: async () => rulesets,
    updateEnabledRulesets: async (options) => (calls.push(["rulesets", options]), (rulesets = options.enableRulesetIds)),
  };
  const wanted = [{ id: 7, action: { type: "block" }, condition: { urlFilter: "new" } }];
  const { ports, sent } = world({
    apis: ["runtime", "declarativeNetRequest"],
    permissions: ["declarativeNetRequest"],
    shared: ["dnr"],
    background: "bg.js",
    extra: { declarativeNetRequest: dnr },
    answer: (m) => {
      const state = { dynamic: wanted, session: [], rulesets: ["b"] };
      return { result: m.method === "mirrorState" ? Object.fromEntries(m.args[0].map((kind) => [kind, state[kind]])) : null };
    },
  });
  await tick(20);
  assert.deepEqual(plain(calls), [
    ["dynamic", { removeRuleIds: [1], addRules: wanted }],
    ["rulesets", { enableRulesetIds: ["b"], disableRulesetIds: ["a"] }],
  ]);
  assert.ok(ports[0].posted.at(-1).listen.includes("declarativeNetRequest"), "the background stays reachable for changes");
  calls.length = 0;
  ports[0].onMessage.fire({ ardia: 1, signal: "dnrChanged", kinds: ["dynamic"] });
  await tick(20);
  assert.deepEqual(plain(sent.at(-1).args), [["dynamic"]]);
  assert.deepEqual(calls, [], "rules that already match aren't rewritten");
});

test("only an extension page with a live user activation tells Ardia it was activated", async () => {
  const sentBy = async (options) => {
    const { browser, sent, relayed } = world({ apis: ["downloads"], ...options });
    await browser.downloads.open(3);
    return sent.length ? sent[0] : relayed[0];
  };
  assert.equal((await sentBy({ activation: true })).activation, true, "a clicked extension page reports its activation");
  assert.equal((await sentBy({ activation: false })).activation, false, "an extension page without a click reports none");
  assert.equal((await sentBy({})).activation, false, "a page without userActivation reports none");
  assert.equal((await sentBy({ activation: true, background: true })).activation, false, "a background page never reports activation");
  assert.equal((await sentBy({ activation: true, content: true })).activation, false, "a content script never reports activation");
});

test("a script the extension registers or injects at run time gets the content shim first, so its storage writes reach Chromium's store too", async () => {
  const CONTENT_FILE = "__ardia_webkit_content.js";
  const registered = [];
  const executed = [];
  const tabsExecuted = [];
  const scripting = {
    registerContentScripts: async (scripts) => void registered.push(...scripts),
    updateContentScripts: async (scripts) => void registered.push(...scripts),
    executeScript: async (injection) => (executed.push(injection), [{ result: executed.length }]),
  };
  const tabs = { executeScript: async (...args) => (tabsExecuted.push(args), ["done"]) };
  const back = world({ apis: ["runtime", "storage"], permissions: ["storage", "scripting"], background: "bg.js", contentFile: CONTENT_FILE, extra: { scripting, tabs } });
  await back.browser.scripting.registerContentScripts([
    { id: "late", matches: ["https://a.example/*"], js: ["late.js"], runAt: "document_idle" },
    { id: "main", matches: ["https://a.example/*"], js: ["main.js"], world: "MAIN" },
    { id: "styles", matches: ["https://a.example/*"], css: ["a.css"] },
  ]);
  await back.browser.scripting.updateContentScripts([{ id: "late", js: [`/${CONTENT_FILE}`, "later.js"] }]);
  assert.deepEqual(
    plain(registered.map((r) => r.js || null)),
    [[CONTENT_FILE, "late.js"], ["main.js"], null, [CONTENT_FILE, "later.js"]],
    "every isolated-world script runs the shim first, once; MAIN-world and css-only entries are left alone",
  );
  assert.equal(registered[0].runAt, "document_idle");
  await back.browser.scripting.executeScript({ target: { tabId: 3 }, files: ["inject.js"] });
  const answer = await back.browser.scripting.executeScript({ target: { tabId: 3, allFrames: true }, func: () => 1 });
  await back.browser.scripting.executeScript({ target: { tabId: 3 }, world: "MAIN", func: () => 2 });
  assert.deepEqual(
    plain(executed.map((e) => e.files || e.world || "func")),
    [[CONTENT_FILE, "inject.js"], [CONTENT_FILE], "func", "MAIN"],
    "a function runs after the shim is in its frames",
  );
  assert.deepEqual(plain(executed[1].target), { tabId: 3, allFrames: true });
  assert.deepEqual(plain(answer), [{ result: 3 }], "the extension gets its own injection's results");
  assert.deepEqual(plain(await back.browser.tabs.executeScript(5, { code: "1", allFrames: true })), ["done"]);
  assert.deepEqual(plain(tabsExecuted), [[5, { file: `/${CONTENT_FILE}`, runAt: "document_start", allFrames: true }], [5, { code: "1", allFrames: true }]]);

  const page = world({ apis: ["runtime", "storage"], permissions: ["storage"], shared: ["storage"], content: true, extra: { storage: webKitStorage([]) } });
  vm.runInNewContext(page.source, page.context);
  await page.browser.storage.local.set({ fromRegistered: true });
  assert.deepEqual(
    page.relayed.map((m) => [m.api, m.method, plain(m.args)]),
    [["storage", "sharedSet", ["local", { fromRegistered: true }, true]]],
    "the write goes to Chromium's store through the relay, once, even with the shim injected twice",
  );
});


test("a rule change made in WebKit is written to Chromium first and comes back through the mirror, and WebKit's apply failures are counted", async () => {
  const native = [];
  let dynamic = [];
  let disabled = { main: [] };
  const dnr = {
    getDynamicRules: async () => dynamic,
    updateDynamicRules: async (options) => {
      native.push(["dynamic", options]);
      if (options.addRules.some((rule) => rule.action.type === "unsupported")) throw new Error("WebKit can't apply this rule");
      dynamic = options.addRules;
    },
    getSessionRules: async () => [],
    updateSessionRules: async (options) => native.push(["session", options]),
    getEnabledRulesets: async () => ["main"],
    updateEnabledRulesets: async (options) => native.push(["rulesets", options]),
    getDisabledRuleIds: async ({ rulesetId }) => disabled[rulesetId] || [],
    updateStaticRules: async (options) => (native.push(["static", options]), (disabled[options.rulesetId] = options.disableRuleIds)),
  };
  let chromium = { dynamic: [], session: [], rulesets: ["main"], disabled: { main: [] } };
  const page = world({
    apis: ["runtime", "declarativeNetRequest"],
    permissions: ["declarativeNetRequest"],
    shared: ["dnr"],
    background: "bg.js",
    extra: { declarativeNetRequest: dnr },
    answer: (m) => {
      if (m.method === "update" && m.args[0] === "dynamic") chromium = { ...chromium, dynamic: m.args[1].addRules };
      if (m.method === "update" && m.args[0] === "static") chromium = { ...chromium, disabled: { main: m.args[1].disableRuleIds } };
      if (m.method === "mirrorState") return { result: Object.fromEntries(m.args[0].map((kind) => [kind, chromium[kind]])) };
      return { result: null };
    },
  });
  await tick();
  page.sent.length = 0;
  native.length = 0;
  const rule = { id: 3, action: { type: "block" }, condition: { urlFilter: "ads" } };
  await page.browser.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
  assert.deepEqual(
    page.sent.filter((m) => m.method !== "noteApplyFailure").map((m) => [m.method, plain(m.args)]),
    [["update", ["dynamic", { addRules: [rule] }]], ["mirrorState", [["dynamic"]]]],
    "the write goes to Chromium, then WebKit takes Chromium's result",
  );
  assert.deepEqual(plain(native), [["dynamic", { removeRuleIds: [], addRules: [rule] }]]);
  assert.deepEqual(plain(await page.browser.declarativeNetRequest.getDynamicRules()), [rule], "WebKit already shows the change when the write resolves");

  native.length = 0;
  page.sent.length = 0;
  await page.browser.declarativeNetRequest.updateStaticRules({ rulesetId: "main", disableRuleIds: [9] });
  assert.deepEqual(plain(page.sent.map((m) => m.method)), ["update", "mirrorState"]);
  assert.deepEqual(plain(page.sent[1].args[0]).sort(), ["disabled", "rulesets"]);
  assert.deepEqual(plain(native), [["static", { rulesetId: "main", disableRuleIds: [9], enableRuleIds: [] }]], "a disabled static rule reaches WebKit too");

  page.sent.length = 0;
  await assert.rejects(
    page.browser.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 4, action: { type: "unsupported" }, condition: {} }] }),
    /WebKit couldn't apply/,
    "a rule WebKit can't apply fails the write instead of reporting success",
  );
  await tick();
  assert.ok(page.sent.some((m) => m.method === "noteApplyFailure"), "a rule WebKit can't apply is counted, not just logged");

  const popup = world({
    apis: ["runtime", "declarativeNetRequest"],
    permissions: ["declarativeNetRequest"],
    shared: ["dnr"],
    extra: { declarativeNetRequest: dnr },
    answer: () => ({ result: null }),
  });
  native.length = 0;
  await popup.browser.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
  assert.deepEqual(plain(popup.sent.map((m) => [m.method, m.args[0]])), [["update", "dynamic"], ["wakeMirror", ["dynamic"]]], "a page writes to Chromium and wakes the background to mirror it, so its own snapshot can't undo a newer one");
  assert.deepEqual(native, []);

  const fallback = [];
  const old = world({
    apis: ["runtime", "declarativeNetRequest"],
    permissions: ["declarativeNetRequest"],
    shared: ["dnr"],
    extra: { declarativeNetRequest: { ...dnr, updateSessionRules: async (options) => fallback.push(options) } },
    answer: () => ({ error: "__ardia_unshared__" }),
  });
  await old.browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
  await old.browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [2] });
  assert.deepEqual(plain(fallback), [{ removeRuleIds: [1] }, { removeRuleIds: [2] }], "an engine without the calls keeps WebKit's own rules");
  assert.equal(old.sent.filter((m) => m.method === "update").length, 1, "after one refusal WebKit stops asking");
});
