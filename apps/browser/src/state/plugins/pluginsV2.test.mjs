import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const keychain = new Map();
const keychainRefuses = new Set();
const keychainUnreadable = new Set();
globalThis.acTestNativeModules = {
  ArdiaKeychain: {
    get: async (account) => (keychainUnreadable.has(account) ? null : (keychain.get(account) ?? null)),
    read: async (account) => (keychainUnreadable.has(account) ? { status: "error", reason: "errSecInteractionNotAllowed" } : keychain.has(account) ? { status: "ok", value: keychain.get(account) } : { status: "missing" }),
    set: async (account, secret) => (keychain.set(account, secret), true),
    delete: async (account) => (keychainRefuses.has(account) ? false : (keychain.delete(account), true)),
  },
};

const stub = await import("../../test-native/index.ts");
const { requireNativeModule } = await import("../../test-native/expo.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated, PluginActivationError } = await import("./activation.ts");
const { runPluginCommand, pluginBarActions, shownCommandContext } = await import("./commands.ts");
const { pluginMenuItems, runPluginMenuChoice } = await import("./menus.ts");
const { usePluginSurfaces, resolveQuickPick, resolveInputBox, dispatchPluginSurfaceEvent, mountPluginSurface, unmountPluginSurface, openPluginCommandView, openPluginPopover, openPluginSidePanel, closePluginSidePanel, nextSurfaceInstanceId } = await import("./surfaces.ts");
const { runPluginToolbarItem } = await import("./toolbar.ts");
const { openPluginPanel } = await import("./panels.ts");
const { openPluginPage } = await import("./pages.ts");
const { restartProcess, settledStops, STOPPING_NOTICE_MS } = await import("./process.ts");
const { storageReadOf } = await import("./hostIo.ts");
const { answerMethod } = await import("./channelApi.ts");
const { webViewsOnline } = await import("./store.ts");
const { dropPluginStorage, MAX_STORAGE_BYTES, storageSet, storageGet } = await import("./storage.ts");
const { FETCH_LIMITS } = await import("./channelData.ts");
const { clearPluginSecrets } = await import("./secrets.ts");
const { setPluginSecretRow } = await import("./secretRows.ts");
const { callTool, waitingCalls } = await import("./tools.ts");
const { groupMenuItems, openGroupMenu } = await import("../sidebar/groupMenu.ts");
const { runPluginDecideHook } = await import("./decideHooks.ts");
const { consentLines } = await import("./consent.ts");
const { pluginThemes, loadPluginTheme } = await import("./themes.ts");
const { pluginToolbarItems } = await import("./toolbar.ts");
const { useRegisteredProviders } = await import("../omnibox/providers.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { useToasts } = await import("../app/toasts.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugins-v2-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
let nextId = 0;

const READER = {
  manifest: 2,
  name: "reader",
  title: "Reader",
  icon: "book",
  main: "dist/index.js",
  permissions: { tabs: "read", activePage: true, storage: true, secrets: true, network: ["api.example.com"] },
  contributes: {
    commands: [
      { name: "summarize", title: "Summarize Page", when: "urlScheme == 'https' && !isPinned" },
      { name: "browse", title: "Browse Notes", view: "notes" },
    ],
    menus: { tab: [{ command: "summarize" }], group: [{ command: "summarize", when: "urlHost ~= '*.example.org'" }] },
    toolbar: [{ id: "go", title: "Reader", icon: "book", view: "quick" }],
    sidebarViews: [{ id: "notes", title: "Notes", icon: "note.text" }],
    panels: [
      { id: "default", title: "Reader", mode: "tab", file: "page/index.html" },
      { id: "chat", title: "Chat", mode: "sidecar", view: "chat", retainContext: true },
      { id: "side", title: "Side", mode: "sidecar", view: "side" },
    ],
    omnibox: [{ id: "notes", title: "Notes", keyword: "n" }],
    themes: [{ id: "dusk", title: "Dusk", file: "themes/dusk.json" }],
    settings: { rows: [{ key: "limit", title: "Limit", type: "number", default: 5, min: 1, max: 10 }, { key: "token", title: "API token", type: "secret" }] },
  },
};

const GUARD = { manifest: 2, name: "guard", title: "Guard", main: "index.js", permissions: { tabs: "read" }, contributes: { hooks: ["tab.opening"] } };

function resetHost() {
  for (const key of ["starts", "stops", "replies", "events", "removed", "fetches", "storageWrites", "fileReads"]) host[key].length = 0;
  host.startResult = null;
  host.fetchResult = null;
  host.storageResult = null;
}

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  resetHost();
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
  const before = host.replies.length;
  stub.emitPluginLine({ name, run, line: JSON.stringify({ id, method, params }) });
  return { id, before };
}

async function ask(name, method, params, run) {
  const { id, before } = send(name, method, params, run);
  await settle();
  const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.ok(reply, `a reply to ${method}`);
  return reply;
}

const lines = () => host.events.map((e) => JSON.parse(e.line));

async function activated(name = "reader") {
  const waiting = ensurePluginActivated(name, "test");
  await settle();
  const run = P().processes[name].run;
  assert.deepEqual((await ask(name, "ready", {}, run)).result, { ok: true });
  assert.equal(await waiting, run);
  return run;
}

beforeEach(() => takePluginCounts());

test("a main plugin stays asleep until used; a command starts it in the JS host, waits for ready, then runs its handler", async () => {
  await enable(READER);
  assert.equal(host.starts.length, 0, "nothing starts until the plugin is used");
  const w = S().createWindow({ url: "https://a.example/" });
  const ran = runPluginCommand("reader", "summarize", w, { url: "https://a.example/x?token=1#f", selection: "picked", secret: { no: 1 } });
  await settle();
  const start = host.starts.at(-1);
  assert.equal(start.runtime, "js");
  assert.equal(start.entry, "dist/index.js");
  assert.deepEqual([start.memoryMB, start.network, start.page], [256, false, true]);
  assert.equal(lines().some((e) => e.kind === "command"), false, "no call goes out before ready");
  const run = P().processes.reader.run;
  await ask("reader", "ready", {}, run);
  const call = lines().findLast((e) => e.kind === "command");
  assert.equal(call.name, "summarize");
  assert.equal(call.command, undefined, "commands go out as kind and name");
  assert.deepEqual(call.context, { url: "https://a.example/x", selection: "picked", windowId: w });
  await ask("reader", "result", { call: call.call, result: { message: "Summarized" } }, run);
  await ran;
  assert.equal(useToasts.getState().toasts[w]?.title, "Summarized");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_activations, 1);
  assert.equal(counts.plugin_commands_run, 1);
});

test("waiting for activation fails cleanly when the plugin is turned off, crashes or never gets ready", async () => {
  await enable(READER);
  const off = ensurePluginActivated("reader", "test");
  await settle();
  lifecycle.disablePlugin("reader", consentToken());
  await assert.rejects(off, (e) => e instanceof PluginActivationError && /turned off/.test(e.message));
  await enable(READER);
  const crash = ensurePluginActivated("reader", "test");
  await settle();
  host.startResult = null;
  usePlugins.setState({ processes: { ...P().processes, reader: { state: "failed", reason: "no JS host" } } });
  await assert.rejects(crash, /no JS host/);
  await enable(READER);
  await assert.rejects(ensurePluginActivated("reader", "test", 20), /didn't get ready/);
  await assert.rejects(ensurePluginActivated("nobody", "test"), /no plugin nobody/);
  assert.ok(takePluginCounts().plugin_activation_failures >= 2);
});

test("storage keeps JSON per plugin, serializes writes so none is lost, and needs its permission", async () => {
  await enable(READER);
  const run = await activated();
  const a = send("reader", "storage.set", { key: "a", value: { n: 1 } }, run);
  const b = send("reader", "storage.set", { key: "b", value: [2] }, run);
  await settle();
  for (const sent of [a, b]) assert.deepEqual(host.replies.slice(sent.before).map((r) => JSON.parse(r.line)).find((r) => r.id === sent.id).result, { ok: true });
  assert.deepEqual(JSON.parse(host.storage.reader), { a: { n: 1 }, b: [2] }, "both writes landed");
  assert.deepEqual((await ask("reader", "storage.get", { key: "a" }, run)).result, { found: true, value: { n: 1 } });
  assert.deepEqual((await ask("reader", "storage.keys", {}, run)).result, ["a", "b"]);
  await ask("reader", "storage.delete", { key: "a" }, run);
  assert.deepEqual((await ask("reader", "storage.get", { key: "a" }, run)).result, { found: false });
  await ask("reader", "storage.set", { key: "empty", value: null }, run);
  assert.deepEqual((await ask("reader", "storage.get", { key: "empty" }, run)).result, { found: true, value: null }, "a stored null isn't a missing key");
  assert.equal((await ask("reader", "storage.set", { key: "", value: 1 }, run)).error.code, "bad_request");
  assert.equal((await ask("reader", "storage.set", { key: "big", value: "x".repeat(300 * 1024) }, run)).error.code, "bad_request");
  host.storageResult = { ok: false, reason: "disk full" };
  assert.deepEqual((await ask("reader", "storage.set", { key: "c", value: 1 }, run)).error, { code: "failed", message: "disk full" });
});

test("net.fetch reaches only allowed hosts, through the host, with headers checked", async () => {
  await enable(READER);
  const run = await activated();
  host.fetchResult = { ok: true, status: 201, statusText: "Created", url: "https://api.example.com/v1", headers: { a: "b" }, body: "{}" };
  const ok = await ask("reader", "net.fetch", { url: "https://api.example.com/v1", method: "post", headers: { "Content-Type": "application/json" }, body: "{}" }, run);
  assert.deepEqual(ok.result, { status: 201, statusText: "Created", url: "https://api.example.com/v1", headers: { a: "b" }, body: "{}" });
  assert.deepEqual(host.fetches.at(-1), { url: "https://api.example.com/v1", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 30000, allowedHosts: ["api.example.com"] });
  assert.equal((await ask("reader", "net.fetch", { url: "https://evil.example.com/" }, run)).error.code, "refused");
  assert.equal((await ask("reader", "net.fetch", { url: "file:///etc/passwd" }, run)).error.code, "bad_request");
  assert.deepEqual((await ask("reader", "net.fetch", { url: "http://api.example.com/v1" }, run)).error, { code: "refused", message: "net.fetch reaches only https addresses." }, "plain http never leaves, even to an allowed host");
  assert.equal((await ask("reader", "net.fetch", { url: "https://api.example.com/", headers: { Cookie: "x" } }, run)).error.code, "bad_request");
  assert.equal((await ask("reader", "net.fetch", { url: "https://api.example.com/", method: "GET", body: "x" }, run)).error.code, "bad_request");
  assert.equal(host.fetches.length, 1, "refused requests never reach the host");
  assert.equal(takePluginCounts().plugin_net_refusals, 2);
});

test("secrets live in the Keychain under the plugin's name, and removing the plugin wipes them", async () => {
  keychain.clear();
  await enable(READER);
  const run = await activated();
  assert.deepEqual((await ask("reader", "secrets.set", { key: "token", value: "s3cret" }, run)).result, { ok: true });
  assert.equal(keychain.get("ardia.plugin.reader.token"), "s3cret");
  assert.equal((await ask("reader", "secrets.get", { key: "token" }, run)).result, "s3cret");
  assert.equal((await ask("reader", "secrets.set", { key: "bad.key", value: "x" }, run)).error.code, "bad_request");
  await ask("reader", "secrets.set", { key: "other", value: "y" }, run);
  assert.ok(!JSON.stringify(P().records).includes("s3cret"), "a secret never reaches plugins.json");
  const removed = await lifecycle.removePlugin("reader");
  assert.equal(removed.ok, true);
  assert.deepEqual([...keychain.keys()].filter((k) => k.includes("reader")), [], "every secret and the index are gone");
});

test("surfaces: render needs an open instance and a sane tree; toolbar updates need a declared item", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal((await ask("reader", "surface.render", { surfaceId: "notes", tree: { type: "Text" } }, run)).error.code, "refused", "a declared view with nothing open draws nowhere");
  assert.equal(await mountPluginSurface("reader", "notes", "sidebar", w), true);
  assert.deepEqual((await ask("reader", "surface.render", { surfaceId: "notes", tree: { type: "List", props: { title: "Notes" }, children: ["one"] } }, run)).result, { ok: true });
  assert.deepEqual(usePluginSurfaces.getState().trees["reader:notes"], { type: "List", props: { title: "Notes" }, children: ["one"] });
  assert.equal((await ask("reader", "surface.render", { surfaceId: "someone-elses", tree: { type: "Text" } }, run)).error.code, "refused");
  assert.equal((await ask("reader", "surface.render", { surfaceId: "notes", tree: { type: "<script>" } }, run)).error.code, "bad_request");
  await ask("reader", "toolbar.update", { itemId: "go", update: { badge: 3, tooltip: "3 unread" } }, run);
  assert.deepEqual(pluginToolbarItems(P())[0].state, { badge: 3, tooltip: "3 unread" });
  assert.equal((await ask("reader", "toolbar.update", { itemId: "nope", update: {} }, run)).error.code, "refused");
  await ask("reader", "toolbar.update", { itemId: "go", update: { tone: "destructive" } }, run);
  assert.equal(pluginToolbarItems(P())[0].state.tone, "destructive");
  assert.equal((await ask("reader", "toolbar.update", { itemId: "go", update: { tone: "danger" } }, run)).error.code, "bad_request", "only Ardia's tones");
  assert.deepEqual((await ask("reader", "ui.showToast", { title: "Saved", detail: "3 notes", windowId: w }, run)).result, { ok: true });
  assert.deepEqual([useToasts.getState().toasts[w]?.title, useToasts.getState().toasts[w]?.message], ["Saved", "3 notes"]);
  assert.equal(dispatchPluginSurfaceEvent("reader", "notes", w, "h1", [{ value: 1 }]), true);
  assert.deepEqual(lines().at(-1), { surface: "event", surfaceId: "notes", handlerId: "h1", args: [{ value: 1 }] });
  assert.equal(await mountPluginSurface("reader", "notes#2", "sidebar", w, { width: 300 }, "notes"), true);
  assert.deepEqual(lines().at(-1), { surface: "mount", surfaceId: "notes#2", viewId: "notes", kind: "sidebar", context: { windowId: w, width: 300 } });
  assert.deepEqual((await ask("reader", "surface.render", { surfaceId: "notes#2", tree: { type: "Text", children: ["two"] } }, run)).result, { ok: true }, "a mounted instance of a declared view can render");
  assert.deepEqual(usePluginSurfaces.getState().trees["reader:notes#2"], { type: "Text", props: {}, children: ["two"] });
  unmountPluginSurface("reader", "notes#2", w);
  assert.deepEqual(lines().at(-1), { surface: "unmount", surfaceId: "notes#2" });
  assert.equal(usePluginSurfaces.getState().trees["reader:notes#2"], undefined, "unmounting the last instance drops its tree");
  assert.equal((await ask("reader", "surface.render", { surfaceId: "notes#2", tree: { type: "Text" } }, run)).error.code, "refused", "an unmounted instance can't render");
  assert.ok(usePluginSurfaces.getState().trees["reader:notes"], "the first instance still shows its tree");
  lifecycle.disablePlugin("reader", consentToken());
  assert.equal(usePluginSurfaces.getState().trees["reader:notes"], undefined, "turning it off clears what it drew");
});

test("surface.close closes the plugin's own command view, popover and side panel showing that surface", async () => {
  await enable(READER);
  const run = await activated();
  const [a, b, c] = [0, 1, 2].map(() => S().createWindow({ url: "https://a.example/" }));
  openPluginCommandView(a, { plugin: "reader", command: "browse", viewId: "notes", title: "Notes", icon: "" });
  openPluginCommandView(b, { plugin: "other", command: "browse", viewId: "notes", title: "Notes", icon: "" });
  openPluginPopover(a, "reader", "go", "quick", { x: 0, y: 0, width: 1, height: 1 });
  openPluginSidePanel(c, "reader", "default");
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: "notes" }, run)).result, { ok: true, closed: 1 });
  const s = () => usePluginSurfaces.getState();
  assert.deepEqual([s().commandViews[a], s().commandViews[b]?.plugin, s().popovers[a]?.viewId], [undefined, "other", "quick"], "another plugin's view and other surfaces stay");
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: "quick" }, run)).result, { ok: true, closed: 1 });
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: "default" }, run)).result, { ok: true, closed: 1 });
  assert.deepEqual([s().popovers[a], s().sidePanels[c]], [undefined, undefined]);
  assert.equal((await ask("reader", "surface.close", {}, run)).error.code, "bad_request");
  usePluginSurfaces.setState({ commandViews: {} });
});

test("reading the active page needs the permission, a gesture in the last 30 s and a normal window", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/doc?id=7" });
  const tab = activeTabId(S(), w);
  webviews.set(tab, { evaluate: async () => ({ text: "Body text", selection: "", lang: "en" }) });
  assert.equal((await ask("reader", "tabs.readActivePage", {}, run)).error.code, "refused", "no gesture yet");
  dispatchPluginSurfaceEvent("reader", "notes", w, "read");
  const read = await ask("reader", "tabs.readActivePage", {}, run);
  assert.deepEqual(read.result, { tabId: tab, url: "https://a.example/doc", title: S().tabs[tab].title, text: "Body text", selection: "", lang: "en" });
  webviews.delete(tab);
});

test("quick picks and input boxes wait for the user's answer, one prompt at a time", async () => {
  await enable(READER);
  const run = await activated();
  S().createWindow({ url: "https://a.example/" });
  const { id, before } = send("reader", "ui.showQuickPick", { items: [{ id: "a", title: "A" }, { id: "b", title: "B" }], options: { title: "Pick" } }, run);
  await settle();
  const shown = usePluginSurfaces.getState().quickPick;
  assert.equal(shown.plugin, "reader");
  assert.equal((await ask("reader", "ui.showInputBox", { title: "Name?" }, run)).error.message, "Another plugin prompt is open.");
  resolveQuickPick(shown.id, ["b", "zzz"]);
  await settle();
  assert.deepEqual(host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id).result, { picked: ["b"] });
  assert.equal(usePluginSurfaces.getState().quickPick, null);
});

test("menus: when clauses pick the items, and a choice runs the command", async () => {
  await enable(READER);
  const tab = pluginMenuItems("tab", { when: { urlScheme: "https", isPinned: false } });
  assert.deepEqual(tab, [{ id: "plugin-menu:tab/reader/summarize", title: "Summarize Page", symbol: "puzzlepiece" }]);
  assert.deepEqual(pluginMenuItems("tab", { when: { urlScheme: "http" } }), [], "the command's own when applies too");
  assert.deepEqual(pluginMenuItems("group", { when: { urlScheme: "https", urlHost: "a.example.com" } }), []);
  assert.equal(pluginMenuItems("group", { when: { urlScheme: "https", urlHost: "docs.example.org" } }).length, 1);
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal(await runPluginMenuChoice("plugin-menu:tab/reader/summarize", w, { when: { urlScheme: "http" } }), false, "a stale menu can't run what no longer applies");
  const ran = runPluginMenuChoice("plugin-menu:tab/reader/summarize", w, { when: { urlScheme: "https" } });
  await settle();
  const run = P().processes.reader.run;
  await ask("reader", "ready", {}, run);
  const call = lines().findLast((e) => e.kind === "command");
  assert.equal(call.name, "summarize");
  assert.equal(call.context.from, "menu");
  await ask("reader", "result", { call: call.call, result: null }, run);
  assert.equal(await ran, true);
  assert.equal(takePluginCounts().plugin_menu_runs, 1);
});

test("omnibox providers register for active plugins and only return safe rows", async () => {
  await enable(READER);
  const provider = useRegisteredProviders.getState().list.find((p) => p.id === "plugin:reader:notes");
  assert.ok(provider, "registered");
  assert.equal(provider.keyword, "n");
  const run = await activated();
  const rows = provider.query("hello", new AbortController().signal);
  await settle();
  const call = lines().findLast((e) => e.kind === "omnibox");
  assert.deepEqual([call.name, call.input, call.query], ["notes", "hello", undefined]);
  await ask("reader", "result", { call: call.call, result: [{ title: "Ok", url: "https://ok.example/" }, { title: "Bad", url: "javascript:alert(1)" }, { title: "", url: "https://x.example/" }, { title: "A‮B", url: "https://y.example/", icon: "../x" }] }, run);
  assert.deepEqual(await rows, [{ title: "Ok", url: "https://ok.example/" }, { title: "AB", url: "https://y.example/" }]);
  lifecycle.disablePlugin("reader", consentToken());
  await settle();
  assert.equal(useRegisteredProviders.getState().list.some((p) => p.id === "plugin:reader:notes"), false, "turning it off unregisters it");
});

test("decide hooks start the plugin eagerly and answer within 250 ms, with URLs cut to the plugin's permissions", async () => {
  await enable(GUARD);
  assert.equal(host.starts.at(-1).name, "guard", "a plugin with hooks starts with Ardia");
  const run = P().processes.guard.run;
  await ask("guard", "ready", {}, run);
  const deciding = runPluginDecideHook("tab.opening", { url: "https://a.example/?token=1" }, consentToken());
  await settle();
  const call = lines().findLast((e) => e.kind === "decide");
  assert.equal(call.name, "tab.opening");
  assert.equal(call.input.url, "https://a.example/");
  assert.equal(call.data, undefined);
  await ask("guard", "result", { call: call.call, result: { cancel: true } }, run);
  assert.deepEqual(await deciding, { plugin: "guard", verdict: { cancel: true } });
  const started = Date.now();
  assert.equal(await runPluginDecideHook("tab.opening", { url: "https://b.example/" }, consentToken()), null);
  assert.ok(Date.now() - started < 1000, "a silent plugin never holds up the decision");
  assert.equal(await runPluginDecideHook("tab.closed", {}, consentToken()), null, "only decide events are asked");
});

test("themes list per plugin and load through the approved folder", async () => {
  await enable(READER);
  assert.deepEqual(pluginThemes(P()), [{ plugin: "reader", pluginTitle: "Reader", id: "dusk", title: "Dusk", key: "plugin:reader/dusk" }]);
  host.files["reader/themes/dusk.json"] = "not json";
  const bad = await loadPluginTheme("reader", "dusk", { dark: {}, light: {} });
  assert.equal(bad.ok, false);
  assert.deepEqual(host.fileReads.at(-1), { name: "reader", folderId: "", approved: P().records.reader.approved, path: "themes/dusk.json" });
  assert.equal((await loadPluginTheme("reader", "nope", { dark: {}, light: {} })).ok, false);
});

test("the consent sheet names every v2 reach", async () => {
  await enable(READER);
  const text = consentLines(P().listings.reader.manifest).map((l) => l.text).join("\n");
  for (const words of ["only while you use it", "connect only to api.example.com", "Keychain", "text of the tab you're on", "Keeps its own data", "toolbar: Reader", "sidebar: Notes", "address bar: Notes (n)", "themes: Dusk", "menu you get on tabs and groups", "Summarize Page", "Its pages and views stay offline", "Chat (in a side panel)"]) assert.ok(text.includes(words), words);
  const guard = consentLines({ ...P().listings.reader.manifest, contributes: { ...P().listings.reader.manifest.contributes, hooks: ["tab.opening"] } }).map((l) => l.text).join("\n");
  assert.ok(guard.includes("Can stop or redirect tab.opening"));
});

test("number rows keep numbers in plugins.json, secret rows never", async () => {
  await enable(READER);
  lifecycle.setPluginValue("reader", "limit", 7);
  assert.equal(P().records.reader.values.limit, 7);
  lifecycle.setPluginValue("reader", "limit", 70);
  assert.equal(P().records.reader.values.limit, 7, "out of range is refused");
  lifecycle.setPluginValue("reader", "token", "leak");
  assert.equal(P().records.reader.values.token, undefined);
});

const ANCHOR = { x: 0, y: 0, width: 1, height: 1 };

test("only network \"*\" lets a plugin's web views online; a host list keeps them offline and goes through net.fetch", async () => {
  await enable(READER);
  assert.equal(webViewsOnline(P(), "reader"), false, "a host list can't hold WebKit to those hosts");
  await enable({ ...READER, permissions: { ...READER.permissions, network: "*" } });
  assert.equal(webViewsOnline(P(), "reader"), true);
  await enable({ ...READER, permissions: { ...READER.permissions, network: false } });
  assert.equal(webViewsOnline(P(), "reader"), false);
});

test("nothing of a plugin's opens or reaches it from a private window", async () => {
  await enable(READER);
  await activated();
  const p = S().createWindow({ kind: "private", url: "https://secret.example/" });
  const before = host.events.length;
  assert.equal(await mountPluginSurface("reader", "notes#private", "sidebar", p, {}, "notes"), false);
  assert.equal(dispatchPluginSurfaceEvent("reader", "notes", p, "h1"), false);
  assert.equal(openPluginSidePanel(p, "reader", "chat"), false);
  assert.equal(openPluginPopover(p, "reader", "go", "quick", ANCHOR), false);
  assert.equal(openPluginCommandView(p, { plugin: "reader", command: "browse", viewId: "notes", title: "Notes", icon: "" }), false);
  assert.equal(await runPluginToolbarItem(p, "reader", "go", ANCHOR), false);
  assert.equal(openPluginPanel(p, "reader", "chat").ok, false);
  assert.equal(host.events.length, before, "nothing reaches the plugin");
  const s = usePluginSurfaces.getState();
  assert.deepEqual([s.sidePanels[p], s.popovers[p], s.commandViews[p], s.retainedSidePanels[p]], [undefined, undefined, undefined, undefined]);
});

test("each open surface is its own instance: a unique id, renders by instance or by view, closes apart", async () => {
  await enable(READER);
  const run = await activated();
  const [a, b] = [0, 1].map(() => S().createWindow({ url: "https://a.example/" }));
  const [ia, ib] = [nextSurfaceInstanceId("notes"), nextSurfaceInstanceId("notes")];
  assert.notEqual(ia, ib);
  assert.ok(ia.startsWith("notes#"));
  assert.equal(await mountPluginSurface("reader", ia, "command", a, {}, "notes"), true);
  assert.equal(await mountPluginSurface("reader", ib, "command", b, {}, "notes"), true);
  assert.deepEqual(lines().filter((e) => e.surface === "mount").slice(-2).map((m) => [m.surfaceId, m.viewId, m.context.windowId]), [[ia, "notes", a], [ib, "notes", b]]);
  const trees = () => usePluginSurfaces.getState().trees;
  await ask("reader", "surface.render", { surfaceId: ia, tree: { type: "Text", children: ["a"] } }, run);
  assert.deepEqual([trees()[`reader:${ia}`]?.children, trees()[`reader:${ib}`]], [["a"], undefined], "an instance's tree is its own");
  await ask("reader", "surface.render", { surfaceId: "notes", tree: { type: "Text", children: ["all"] } }, run);
  assert.deepEqual([trees()[`reader:${ia}`].children, trees()[`reader:${ib}`].children], [["all"], ["all"]], "a view id reaches every open instance");
  for (const w of [a, b]) openPluginCommandView(w, { plugin: "reader", command: "browse", viewId: "notes", title: "Notes", icon: "" });
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: ia }, run)).result, { ok: true, closed: 1 });
  assert.deepEqual([usePluginSurfaces.getState().commandViews[a], usePluginSurfaces.getState().commandViews[b]?.viewId], [undefined, "notes"], "closing one instance leaves the other window's");
  unmountPluginSurface("reader", ia, a);
  assert.deepEqual([trees()[`reader:${ia}`], trees()[`reader:${ib}`].children], [undefined, ["all"]]);
  unmountPluginSurface("reader", ib, b);
  usePluginSurfaces.setState({ commandViews: {} });
});

test("removing a plugin closes its storage first: a read held across the removal and the writes queued behind it never reach the host", async () => {
  await enable(READER);
  const run = await activated();
  delete host.storage.reader;
  dropPluginStorage("reader");
  const nativePlugins = requireNativeModule("ArdiaPlugins");
  const realRead = nativePlugins.storageRead;
  const held = [];
  nativePlugins.storageRead = (...args) => new Promise((resolve) => held.push(() => resolve(realRead(...args))));
  try {
    takePluginCounts();
    const first = send("reader", "storage.set", { key: "a", value: 1 }, run);
    const second = send("reader", "storage.set", { key: "b", value: 2 }, run);
    await settle();
    assert.equal(held.length, 1, "the first write is waiting on its read");
    let removal = null;
    const removing = lifecycle.removePlugin("reader").then((r) => (removal = r));
    await settle();
    assert.deepEqual([host.removed, removal], [[], null], "the files stay until the storage queue drains");
    assert.deepEqual((await storageSet("reader", "late", 3)).ok, false, "a request arriving mid-removal is refused at once");
    held.shift()();
    await removing;
    await settle();
    assert.equal(removal.ok, true);
    assert.deepEqual(host.removed, ["reader"]);
    assert.deepEqual(host.storageWrites, [], "nothing writes after removal, so the data folder isn't made again");
    for (const sent of [first, second]) assert.equal(host.replies.slice(sent.before).map((r) => JSON.parse(r.line)).find((r) => r.id === sent.id)?.error?.code ?? "no reply", "failed");
    assert.equal(takePluginCounts().plugin_storage_cancels, 2, "each plugin request dropped by the removal counts once");
    assert.equal(held.length, 0, "no read starts after the removal");
  } finally {
    nativePlugins.storageRead = realRead;
  }
  assert.deepEqual(await storageGet("reader", "a"), { ok: true, value: { found: false } }, "storage opens again once the removal is over");
});

test("storage keeps its 2 MB budget, and storage the host can't read or parse fails cleanly and is never overwritten", async () => {
  assert.equal(MAX_STORAGE_BYTES, 2 * 1024 * 1024);
  await enable(READER);
  const run = await activated();
  host.storage.reader = "{not json";
  dropPluginStorage("reader");
  assert.equal((await ask("reader", "storage.get", { key: "a" }, run)).error.code, "failed");
  assert.equal((await ask("reader", "storage.set", { key: "a", value: 1 }, run)).error.code, "failed");
  assert.equal((await ask("reader", "storage.keys", {}, run)).error.code, "failed");
  assert.deepEqual([host.storage.reader, host.storageWrites.length], ["{not json", 0], "the unreadable file is left alone");
  delete host.storage.reader;
  host.storageReadResult = { status: "error", reason: "locked" };
  dropPluginStorage("reader");
  assert.deepEqual((await ask("reader", "storage.set", { key: "a", value: 1 }, run)).error, { code: "failed", message: "The plugin's storage couldn't be read: locked" });
  assert.equal(host.storageWrites.length, 0, "a read error never turns into an empty store on disk");
  host.storageReadResult = null;
  delete host.storage.reader;
  dropPluginStorage("reader");
  assert.deepEqual((await ask("reader", "storage.get", { key: "a" }, run)).result, { found: false }, "no file is an empty store");
  assert.deepEqual((await ask("reader", "storage.set", { key: "a", value: 1 }, run)).result, { ok: true });
  assert.deepEqual(storageReadOf(null), { status: "missing" });
  assert.deepEqual(storageReadOf("{}"), { status: "ok", text: "{}" });
  assert.deepEqual(storageReadOf({ status: "missing" }), { status: "missing" });
  assert.deepEqual(storageReadOf({ status: "ok", text: "{}" }), { status: "ok", text: "{}" });
  assert.deepEqual(storageReadOf({ status: "error", reason: "locked" }), { status: "error", reason: "locked" });
  assert.equal(storageReadOf(42).status, "error");
});

test("net.fetch request bodies stop at 512 KB, inside the channel's frame", async () => {
  assert.equal(FETCH_LIMITS.bodyBytes, 512 * 1024);
  await enable(READER);
  const run = await activated();
  host.fetchResult = { ok: true, status: 200, statusText: "OK", url: "https://api.example.com/", headers: {}, body: "" };
  const over = await ask("reader", "net.fetch", { url: "https://api.example.com/", method: "POST", body: "x".repeat(512 * 1024 + 1) }, run);
  assert.deepEqual(over.error, { code: "bad_request", message: "body is over 512 KB." });
  assert.equal(host.fetches.length, 0);
  assert.ok((await ask("reader", "net.fetch", { url: "https://api.example.com/", method: "POST", body: "x".repeat(512 * 1024) }, run)).result);
  assert.equal(host.fetches.length, 1);
});

test("a secret the Keychain won't delete stays listed, and removing the plugin says so", async () => {
  keychain.clear();
  keychainRefuses.clear();
  await enable(READER);
  const run = await activated();
  await ask("reader", "secrets.set", { key: "token", value: "s3cret" }, run);
  await ask("reader", "secrets.set", { key: "other", value: "y" }, run);
  keychainRefuses.add("ardia.plugin.reader.token");
  assert.equal((await ask("reader", "secrets.delete", { key: "token" }, run)).error.code, "failed");
  assert.deepEqual(JSON.parse(keychain.get("ardia.plugin-index.reader")), ["token", "other"], "the index keeps a key the Keychain kept");
  const removed = await lifecycle.removePlugin("reader");
  assert.deepEqual([removed.ok, removed.removed], [false, true]);
  assert.match(removed.reason, /1 secret is still in your Keychain/);
  assert.deepEqual(JSON.parse(keychain.get("ardia.plugin-index.reader")), ["token"]);
  assert.equal(keychain.has("ardia.plugin.reader.other"), false);
  keychainRefuses.clear();
  keychain.clear();
});

test("the command bar offers a command only where its when clause holds, and checks again before running", async () => {
  await enable(READER);
  const https = S().createWindow({ url: "https://a.example/" });
  const http = S().createWindow({ url: "http://plain.example/" });
  const ids = (w) => pluginBarActions(P(), w).map((a) => a.id);
  assert.ok(ids(https).includes("plugin:reader/summarize"));
  assert.ok(!ids(http).includes("plugin:reader/summarize"));
  assert.ok(ids(http).includes("plugin:reader/browse"), "a command with no clause shows everywhere");
  assert.equal(await runPluginCommand("reader", "summarize", http), false);
  assert.equal(host.starts.length, 0, "a refused command starts nothing");
});

test("group menus carry plugin items, never in an incognito group, and a choice runs the command with the group", async () => {
  await enable(READER);
  const w = S().createWindow({ url: "https://docs.example.org/" });
  const tab = activeTabId(S(), w);
  const g = S().groupTabs([tab], { name: "Docs", pinned: false });
  const flat = (items) => items.flatMap((i) => [i, ...(i.children ?? [])]);
  const item = flat(groupMenuItems(S(), w, g)).find((i) => i.id === "plugin-menu:group/reader/summarize");
  assert.ok(item, "the group menu shows the plugin's item");
  const shell = stub.shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = async () => "plugin-menu:group/reader/summarize";
  try {
    const opened = openGroupMenu(w, g);
    await settle();
    await ask("reader", "ready", {}, P().processes.reader.run);
    await opened;
    const call = lines().findLast((e) => e.kind === "command");
    assert.deepEqual([call.name, call.context.from, call.context.slot, call.context.groupId], ["summarize", "menu", "group", g]);
  } finally {
    shell.showMenu = real;
  }
});

test("a plugin menu choice counts against the sharing period its menu opened in", async () => {
  await enable(READER);
  const w = S().createWindow({ url: "https://docs.example.org/" });
  const g = S().groupTabs([activeTabId(S(), w)], { name: "Docs", pinned: false });
  const run = await activated("reader");
  const shell = stub.shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  try {
    for (const { sharingAtOpen, expected } of [{ sharingAtOpen: false, expected: 0 }, { sharingAtOpen: true, expected: 1 }]) {
      let pick;
      shell.showMenu = () => new Promise((resolve) => (pick = resolve));
      setConsentPeriod(sharingAtOpen, sharingAtOpen ? "plugins-v2-test" : null);
      takePluginCounts();
      const opened = openGroupMenu(w, g);
      await settle();
      setConsentPeriod(true, "plugins-v2-test");
      pick("plugin-menu:group/reader/summarize");
      await opened;
      await settle();
      const call = lines().findLast((e) => e.kind === "command");
      await ask("reader", "result", { call: call.call, result: null }, run);
      const counts = takePluginCounts();
      assert.deepEqual([counts.plugin_menu_runs, counts.plugin_commands_run], [expected, expected], sharingAtOpen ? "a menu opened while sharing is on counts" : "turning sharing on while the menu is up doesn't count the choice");
    }
  } finally {
    shell.showMenu = real;
    setConsentPeriod(true, "plugins-v2-test");
  }
});

test("a decide request keeps the token its gate took, so one begun while sharing is off counts nothing", async () => {
  await enable(GUARD);
  const run = P().processes.guard.run;
  await ask("guard", "ready", {}, run);
  takePluginCounts();
  const deciding = runPluginDecideHook("tab.opening", { url: "https://a.example/" }, null);
  await settle();
  const call = lines().findLast((e) => e.kind === "decide");
  await ask("guard", "result", { call: call.call, result: null }, run);
  assert.equal(await deciding, null);
  assert.equal(takePluginCounts().plugin_decide_calls, 0, "an explicit null token is kept, not swapped for the current one");
  await runPluginDecideHook("tab.opening", { url: "https://b.example/" }, consentToken());
  assert.equal(takePluginCounts().plugin_decide_calls, 1);
});

test("a retainContext side panel stays mounted hidden when closed; others close outright; a closed window drops them", async () => {
  await enable(READER);
  const w = S().createWindow({ url: "https://a.example/" });
  const s = () => usePluginSurfaces.getState();
  const retained = (win) => (s().retainedSidePanels[win] ?? []).map((p) => p.panelId);
  assert.equal(openPluginSidePanel(w, "reader", "chat"), true);
  assert.deepEqual(retained(w), ["chat"]);
  closePluginSidePanel(w, "reader");
  assert.deepEqual([s().sidePanels[w].panelId, s().sidePanels[w].hidden, retained(w)], ["chat", true, ["chat"]]);
  openPluginSidePanel(w, "reader", "chat");
  assert.deepEqual([s().sidePanels[w].hidden, retained(w)], [undefined, ["chat"]], "reopening shows it again, kept once");
  openPluginSidePanel(w, "reader", "side");
  assert.deepEqual([s().sidePanels[w].panelId, retained(w)], ["side", ["chat"]]);
  closePluginSidePanel(w);
  assert.deepEqual([s().sidePanels[w], retained(w)], [undefined, ["chat"]], "a panel without retainContext closes outright");
  const v = S().createWindow({ url: "https://b.example/" });
  openPluginSidePanel(v, "reader", "chat");
  S().closeWindow(v);
  assert.deepEqual([s().sidePanels[v], s().retainedSidePanels[v]], [undefined, undefined]);
  lifecycle.disablePlugin("reader", consentToken());
  assert.equal(s().retainedSidePanels[w], undefined, "turning the plugin off drops its retained panels");
});

test("main gets plugin.stopping about 120 ms before Ardia stops or restarts it", async () => {
  await enable(READER);
  let run = await activated();
  restartProcess("reader");
  assert.deepEqual([host.events.at(-1).run, JSON.parse(host.events.at(-1).line)], [run, { event: "plugin.stopping", time: JSON.parse(host.events.at(-1).line).time, data: {} }]);
  assert.equal(host.stops.length, 0, "the stop waits for deactivate");
  await new Promise((resolve) => setTimeout(resolve, STOPPING_NOTICE_MS + 30));
  assert.equal(host.stops.length, 1);
  await settle();
  run = await activated();
  lifecycle.disablePlugin("reader", consentToken());
  assert.equal(JSON.parse(host.events.at(-1).line).event, "plugin.stopping");
  assert.equal(host.events.at(-1).run, run);
  await settledStops();
  assert.equal(host.stops.length, 2);
});

test("hello tells a sidecar or v1 helper protocol 1 and main's host protocol 2", async () => {
  await enable(READER);
  const m = P().listings.reader.manifest;
  assert.equal(answerMethod({ name: "reader", run: 1 }, m, "hello", {}).result.protocol, 2);
  assert.equal(answerMethod({ name: "reader", run: 1 }, { ...m, main: null }, "hello", {}).result.protocol, 1);
});

test("the incoming-link hold follows a decide plugin becoming ready and stopping", async () => {
  const { startDecideHooks } = await import("../automation/decideHooks.ts");
  startDecideHooks();
  await enable(GUARD);
  assert.equal(stub.systemSignals.holdsIncomingLinks, false, "not while it isn't ready");
  await ask("guard", "ready", {}, P().processes.guard.run);
  await settle();
  assert.equal(stub.systemSignals.holdsIncomingLinks, true, "ready is enough, with no other change");
  restartProcess("guard");
  await settle();
  assert.equal(stub.systemSignals.holdsIncomingLinks, false);
  lifecycle.disablePlugin("guard", consentToken());
  await settledStops();
});

const TABBER = { manifest: 2, name: "tabber", title: "Tabber", main: "index.js", permissions: { tabs: "write" } };
const reply = (sent) => host.replies.slice(sent.before).map((r) => JSON.parse(r.line)).find((r) => r.id === sent.id);

test("showConfirm with no window to ask in fails before any dialog opens", async () => {
  await enable(READER);
  const run = await activated();
  for (const w of Object.keys(S().windows)) S().closeWindow(w);
  const p = S().createWindow({ kind: "private", url: "https://secret.example/" });
  const dialogs = stub.shellNativeModules.ArdiaDialogs;
  const real = dialogs.confirm;
  let shown = 0;
  dialogs.confirm = async () => (shown++, { confirmed: true, suppressed: false });
  try {
    assert.equal((await ask("reader", "ui.showConfirm", { title: "Delete?" }, run)).error.code, "no_window");
    assert.equal((await ask("reader", "ui.showConfirm", { title: "Delete?", windowId: p }, run)).error.code, "no_window");
    assert.equal(shown, 0, "no app-modal dialog opens");
    const w = S().createWindow({ url: "https://a.example/" });
    assert.deepEqual((await ask("reader", "ui.showConfirm", { title: "Delete?", windowId: w }, run)).result, { confirmed: true });
    assert.equal(shown, 1);
  } finally {
    dialogs.confirm = real;
  }
});

test("surface.close on a command view instance never closes a popover sharing its view id", async () => {
  await enable(READER);
  const run = await activated();
  const a = S().createWindow({ url: "https://a.example/" });
  const instance = nextSurfaceInstanceId("notes");
  assert.equal(await mountPluginSurface("reader", instance, "command", a, {}, "notes"), true);
  openPluginCommandView(a, { plugin: "reader", command: "browse", viewId: "notes", title: "Notes", icon: "" });
  openPluginPopover(a, "reader", "go", "notes", ANCHOR);
  const s = () => usePluginSurfaces.getState();
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: instance }, run)).result, { ok: true, closed: 1 });
  assert.deepEqual([s().commandViews[a], s().popovers[a]?.viewId], [undefined, "notes"], "only the instance's own kind closes");
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: instance }, run)).result, { ok: true, closed: 0 });
  assert.equal(s().popovers[a]?.viewId, "notes");
  unmountPluginSurface("reader", instance, a);
  usePluginSurfaces.setState({ popovers: {}, commandViews: {} });
});

test("net.fetch refuses a response whose JSON reply would overflow the channel frame", async () => {
  await enable(READER);
  const run = await activated();
  host.fetchResult = { ok: true, status: 200, statusText: "OK", url: "https://api.example.com/", headers: {}, body: "\n".repeat(700 * 1024) };
  assert.deepEqual((await ask("reader", "net.fetch", { url: "https://api.example.com/" }, run)).error, { code: "failed", message: "The response is too large for the plugin channel." });
  host.fetchResult = { ok: true, status: 200, statusText: "OK", url: "https://api.example.com/", headers: {}, body: "x".repeat(700 * 1024) };
  assert.equal((await ask("reader", "net.fetch", { url: "https://api.example.com/" }, run)).result.body.length, 700 * 1024);
});

test("an empty storage file is a read error, never an empty store that gets overwritten", async () => {
  await enable(READER);
  const run = await activated();
  host.storage.reader = "";
  dropPluginStorage("reader");
  assert.equal((await ask("reader", "storage.get", { key: "a" }, run)).error.code, "failed");
  assert.equal((await ask("reader", "storage.set", { key: "a", value: 1 }, run)).error.code, "failed");
  assert.deepEqual([host.storage.reader, host.storageWrites.length], ["", 0]);
  delete host.storage.reader;
  dropPluginStorage("reader");
});

test("an unreadable Keychain index is kept, and secret writes and removal fail instead of replacing it", async () => {
  keychain.clear();
  await enable(READER);
  const run = await activated();
  for (const broken of ["{oops", '{"a":1}']) {
    keychain.set("ardia.plugin-index.reader", broken);
    keychain.set("ardia.plugin.reader.token", "s3cret");
    assert.equal((await ask("reader", "secrets.set", { key: "token", value: "new" }, run)).error.code, "failed");
    assert.equal((await ask("reader", "secrets.delete", { key: "token" }, run)).error.code, "failed");
    assert.deepEqual([keychain.get("ardia.plugin-index.reader"), keychain.get("ardia.plugin.reader.token")], [broken, "s3cret"], broken);
  }
  const removed = await lifecycle.removePlugin("reader");
  assert.deepEqual([removed.ok, removed.removed], [false, true]);
  assert.match(removed.reason, /its secrets may be still in your Keychain/);
  assert.equal(keychain.get("ardia.plugin-index.reader"), '{"a":1}', "the index survives the uninstall");
  keychain.clear();
});

test("a process stop drops hidden retained side panels, so they don't remount on the next run", async () => {
  await enable(READER);
  await activated();
  const [w, v] = [0, 1].map(() => S().createWindow({ url: "https://a.example/" }));
  const s = () => usePluginSurfaces.getState();
  openPluginSidePanel(w, "reader", "chat");
  const instance = nextSurfaceInstanceId("chat");
  assert.equal(await mountPluginSurface("reader", instance, "panel", w, { panelId: "chat" }, "chat"), true);
  closePluginSidePanel(w, "reader");
  assert.equal(s().sidePanels[w].hidden, true);
  openPluginSidePanel(v, "reader", "chat");
  restartProcess("reader");
  assert.deepEqual([s().sidePanels[w], s().retainedSidePanels[w]], [undefined, undefined], "the hidden retained panel goes");
  assert.deepEqual([s().sidePanels[v]?.panelId, (s().retainedSidePanels[v] ?? []).map((p) => p.panelId)], ["chat", ["chat"]], "a shown one stays");
  await new Promise((resolve) => setTimeout(resolve, STOPPING_NOTICE_MS + 30));
  await settle();
  const before = host.events.length;
  await activated();
  assert.equal(host.events.slice(before).map((e) => JSON.parse(e.line)).some((e) => e.surface === "mount" && e.surfaceId === instance), false);
  lifecycle.disablePlugin("reader", consentToken());
});

test("two quick restarts stop only the old run, never the newer one", async () => {
  await enable(READER);
  const first = await activated();
  restartProcess("reader");
  restartProcess("reader");
  await new Promise((resolve) => setTimeout(resolve, STOPPING_NOTICE_MS + 60));
  await settle();
  const state = P().processes.reader;
  assert.equal(state.state, "running");
  assert.notEqual(state.run, first);
  assert.ok(host.stops.length >= 1);
  assert.deepEqual(host.stops.map((x) => x.run).filter((r) => r !== first), [], "every stop names the old run");
  await new Promise((resolve) => setTimeout(resolve, STOPPING_NOTICE_MS + 30));
  assert.equal(host.stops.filter((x) => x.run !== first).length, 0);
  lifecycle.disablePlugin("reader", consentToken());
  await settledStops();
  assert.equal(host.stops.at(-1).run, state.run, "a stop later names the run it ends");
});

test("closing a window cancels its pending input box or quick pick, so later prompts aren't blocked", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/" });
  const box = send("reader", "ui.showInputBox", { title: "Name?", windowId: w }, run);
  await settle();
  assert.equal(usePluginSurfaces.getState().inputBox?.windowId, w);
  S().closeWindow(w);
  await settle();
  assert.deepEqual(reply(box).result, { value: null });
  assert.equal(usePluginSurfaces.getState().inputBox, null);
  const v = S().createWindow({ url: "https://a.example/" });
  const pick = send("reader", "ui.showQuickPick", { items: [{ id: "a", title: "A" }], windowId: v }, run);
  await settle();
  assert.equal(usePluginSurfaces.getState().quickPick?.windowId, v);
  S().closeWindow(v);
  await settle();
  assert.deepEqual(reply(pick).result, { picked: null });
  const u = S().createWindow({ url: "https://a.example/" });
  const again = send("reader", "ui.showInputBox", { title: "Again?", windowId: u }, run);
  await settle();
  const shown = usePluginSurfaces.getState().inputBox;
  assert.equal(shown?.windowId, u, "a new prompt opens");
  resolveInputBox(shown.id, null);
  await settle();
  assert.deepEqual(reply(again).result, { value: null });
});

test("readActivePage refuses once the tab changes or navigates after the gesture", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/doc?id=7" });
  const tab = activeTabId(S(), w);
  webviews.set(tab, { evaluate: async () => ({ text: "Body text", selection: "", lang: "en" }) });
  dispatchPluginSurfaceEvent("reader", "notes", w, "read");
  S().updateTab(tab, { url: "https://a.example/doc?id=7#later" });
  assert.equal((await ask("reader", "tabs.readActivePage", {}, run)).result.tabId, tab, "a fragment change is the same page");
  S().updateTab(tab, { url: "https://a.example/other" });
  assert.equal((await ask("reader", "tabs.readActivePage", {}, run)).error.code, "refused", "navigating ends the gesture's reach");
  dispatchPluginSurfaceEvent("reader", "notes", w, "read");
  const other = S().newTab(w, { url: "https://b.example/" });
  S().activate(other);
  webviews.set(other, { evaluate: async () => ({ text: "Other", selection: "", lang: "en" }) });
  assert.equal((await ask("reader", "tabs.readActivePage", {}, run)).error.code, "refused", "switching tabs ends it");
  const ran = runPluginCommand("reader", "summarize", w, { tabId: tab });
  await settle();
  assert.equal((await ask("reader", "tabs.readActivePage", {}, run)).error.code, "refused", "a gesture on a background tab doesn't reach the active one");
  const call = lines().findLast((e) => e.kind === "command");
  await ask("reader", "result", { call: call.call, result: null }, run);
  await ran;
  webviews.delete(tab);
  webviews.delete(other);
});

test("tabs: write may apply open, tab.close and tab.activate without workspace, and gets no full URLs", async () => {
  await enable(TABBER);
  const run = await activated("tabber");
  const w = S().createWindow({ url: "https://a.example/" });
  const first = activeTabId(S(), w);
  const opened = await ask("tabber", "apply", { ops: [{ op: "open", urls: ["https://b.example/x?token=1#f"], window: w }] }, run);
  assert.equal(opened.result.ok, true);
  const tab = opened.result.tabs[0];
  assert.equal(tab.url, "https://b.example/x");
  assert.ok(!JSON.stringify(opened.result).includes("token=1"), "no full URL leaks");
  assert.equal((await ask("tabber", "apply", { ops: [{ op: "tab.activate", tab: first }] }, run)).result.ok, true);
  assert.equal(activeTabId(S(), w), first);
  assert.equal((await ask("tabber", "apply", { ops: [{ op: "tab.close", tabs: [tab.id] }] }, run)).result.ok, true);
  assert.equal(S().tabs[tab.id], undefined);
  assert.equal((await ask("tabber", "apply", { ops: [{ op: "tab.pin", tabs: [first] }] }, run)).error.code, "refused");
  assert.equal((await ask("tabber", "apply", { ops: [{ op: "open", urls: ["https://c.example/"], window: w, profile: "default" }] }, run)).error.code, "refused");
  assert.equal((await ask("tabber", "workspace", {}, run)).error.code, "refused");
});

const TWIN = { ...READER, contributes: { ...READER.contributes, panels: [...READER.contributes.panels, { id: "twin", title: "Twin", mode: "sidecar", view: "chat", retainContext: true }] } };

async function twinPanels() {
  await enable(TWIN);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/" });
  openPluginSidePanel(w, "reader", "chat");
  const hidden = nextSurfaceInstanceId("chat");
  assert.equal(await mountPluginSurface("reader", hidden, "panel", w, { panelId: "chat" }, "chat"), true);
  openPluginSidePanel(w, "reader", "twin");
  const shown = nextSurfaceInstanceId("chat");
  assert.equal(await mountPluginSurface("reader", shown, "panel", w, { panelId: "twin" }, "chat"), true);
  const s = usePluginSurfaces.getState();
  assert.deepEqual([s.sidePanels[w].panelId, s.retainedSidePanels[w].map((p) => p.panelId)], ["twin", ["chat", "twin"]]);
  return { run, w, hidden, shown };
}

test("showConfirm asks for a sheet only, and fails with no_window when no visible window can show it", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/" });
  const dialogs = stub.shellNativeModules.ArdiaDialogs;
  const real = dialogs.confirm;
  const asked = [];
  dialogs.confirm = async (options) => (asked.push(options), { confirmed: false, suppressed: false, unavailable: true });
  try {
    assert.deepEqual((await ask("reader", "ui.showConfirm", { title: "Delete?", windowId: w }, run)).error, { code: "no_window", message: "No visible window to show the dialog." });
    assert.deepEqual(asked.map((o) => [o.windowId, o.sheetOnly]), [[w, true]]);
    dialogs.confirm = async (options) => (asked.push(options), { confirmed: true, suppressed: false });
    assert.deepEqual((await ask("reader", "ui.showConfirm", { title: "Delete?", windowId: w }, run)).result, { confirmed: true });
  } finally {
    dialogs.confirm = real;
  }
});

test("surface.close on a retained side panel instance never closes the shown panel sharing its view id", async () => {
  const { run, w, hidden, shown } = await twinPanels();
  const s = () => usePluginSurfaces.getState();
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: hidden }, run)).result, { ok: true, closed: 0 });
  assert.deepEqual([s().sidePanels[w].panelId, s().sidePanels[w].hidden], ["twin", undefined], "the shown twin stays open");
  assert.deepEqual((await ask("reader", "surface.close", { surfaceId: shown }, run)).result, { ok: true, closed: 1 });
  assert.deepEqual([s().sidePanels[w].panelId, s().sidePanels[w].hidden], ["twin", true], "its own instance closes it");
  unmountPluginSurface("reader", hidden, w);
  unmountPluginSurface("reader", shown, w);
  lifecycle.disablePlugin("reader", consentToken());
});

test("a process stop drops only the hidden retained panel's mount and tree, never a shown panel sharing its view id", async () => {
  const { run, w, hidden, shown } = await twinPanels();
  const s = () => usePluginSurfaces.getState();
  await ask("reader", "surface.render", { surfaceId: hidden, tree: { type: "Text", children: ["hidden"] } }, run);
  await ask("reader", "surface.render", { surfaceId: shown, tree: { type: "Text", children: ["shown"] } }, run);
  restartProcess("reader");
  assert.equal(s().trees[`reader:${hidden}`], undefined, "the hidden panel's tree goes");
  assert.deepEqual(s().trees[`reader:${shown}`]?.children, ["shown"], "the shown panel keeps its tree");
  assert.deepEqual([s().sidePanels[w].panelId, s().retainedSidePanels[w].map((p) => p.panelId)], ["twin", ["twin"]]);
  await new Promise((resolve) => setTimeout(resolve, STOPPING_NOTICE_MS + 30));
  await settle();
  const before = host.events.length;
  await activated();
  const mounts = host.events.slice(before).map((e) => JSON.parse(e.line)).filter((e) => e.surface === "mount").map((e) => e.surfaceId);
  assert.deepEqual([mounts.includes(hidden), mounts.includes(shown)], [false, true]);
  unmountPluginSurface("reader", shown, w);
  lifecycle.disablePlugin("reader", consentToken());
});

test("a Keychain that can't be read fails secret reads, writes, deletes and removal, and leaves the index alone", async () => {
  keychain.clear();
  await enable(READER);
  const run = await activated();
  const index = "ardia.plugin-index.reader";
  keychain.set(index, '["token"]');
  keychain.set("ardia.plugin.reader.token", "s3cret");
  keychainUnreadable.add(index);
  try {
    assert.equal((await ask("reader", "secrets.set", { key: "other", value: "y" }, run)).error.code, "failed");
    assert.equal((await ask("reader", "secrets.delete", { key: "token" }, run)).error.code, "failed");
    assert.equal((await clearPluginSecrets("reader")).ok, false);
    const removed = await lifecycle.removePlugin("reader");
    assert.deepEqual([removed.ok, removed.removed], [false, true]);
    assert.match(removed.reason, /its secrets may be still in your Keychain/);
    assert.deepEqual([keychain.get(index), keychain.get("ardia.plugin.reader.token"), keychain.has("ardia.plugin.reader.other")], ['["token"]', "s3cret", false]);
  } finally {
    keychainUnreadable.clear();
    keychain.clear();
  }
});

test("a secret the Keychain can't read is a failure, and a missing one is null", async () => {
  keychain.clear();
  await enable(READER);
  const run = await activated();
  assert.equal((await ask("reader", "secrets.get", { key: "token" }, run)).result, null);
  keychain.set("ardia.plugin.reader.token", "s3cret");
  keychainUnreadable.add("ardia.plugin.reader.token");
  try {
    assert.equal((await ask("reader", "secrets.get", { key: "token" }, run)).error.code, "failed");
  } finally {
    keychainUnreadable.clear();
    keychain.clear();
  }
});

test("readActivePage refuses when the page navigates or the tab switches while its text is being read", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/doc" });
  const tab = activeTabId(S(), w);
  let release = () => {};
  webviews.set(tab, { evaluate: () => new Promise((resolve) => (release = () => resolve({ text: "Body text", selection: "", lang: "en" }))) });
  const pending = async (change) => {
    dispatchPluginSurfaceEvent("reader", "notes", w, "read");
    const sent = send("reader", "tabs.readActivePage", {}, run);
    await settle();
    change();
    release();
    await settle();
    return reply(sent);
  };
  assert.equal((await pending(() => S().updateTab(tab, { url: "https://a.example/doc#later" }))).result.text, "Body text", "a fragment change is the same page");
  assert.equal((await pending(() => S().updateTab(tab, { url: "https://a.example/other" }))).error.code, "refused", "navigating mid-read refuses");
  const other = S().newTab(w, { url: "https://b.example/" });
  S().activate(tab);
  assert.equal((await pending(() => S().activate(other))).error.code, "refused", "switching tabs mid-read refuses");
  webviews.delete(tab);
});

test("readActivePage refuses a switch away and back or a reload while reading, and a fragment change still reads", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/doc" });
  const tab = activeTabId(S(), w);
  const other = S().newTab(w, { url: "https://b.example/" });
  S().activate(tab);
  let release = () => {};
  webviews.set(tab, { evaluate: () => new Promise((resolve) => (release = () => resolve({ text: "Body text", selection: "", lang: "en" }))) });
  const pending = async (change) => {
    dispatchPluginSurfaceEvent("reader", "notes", w, "read");
    const sent = send("reader", "tabs.readActivePage", {}, run);
    await settle();
    change();
    release();
    await settle();
    return reply(sent);
  };
  const switched = await pending(() => {
    S().activate(other);
    S().activate(tab);
  });
  assert.equal(switched.error?.code, "refused", "switching away and back mid-read refuses");
  const reloaded = await pending(() => S().updateLive(tab, { isLoading: true }));
  assert.equal(reloaded.error?.code, "refused", "a reload at the same URL mid-read refuses");
  S().updateLive(tab, { isLoading: false });
  const moved = await pending(() => S().updateTab(tab, { url: "https://a.example/doc#section" }));
  assert.equal(moved.result?.text, "Body text", "a fragment change is the same page");
  webviews.delete(tab);
  lifecycle.disablePlugin("reader", consentToken());
});

test("a retained side panel keeps its generation across close and reopen, and a restart's drop gives the reopened one a newer generation", async () => {
  await enable(READER);
  await activated();
  const w = S().createWindow({ url: "https://a.example/" });
  const s = () => usePluginSurfaces.getState();
  openPluginSidePanel(w, "reader", "chat");
  const first = s().sidePanels[w].generation;
  closePluginSidePanel(w, "reader");
  openPluginSidePanel(w, "reader", "chat");
  assert.equal(s().sidePanels[w].generation, first, "unhiding a retained panel keeps its instance");
  assert.equal(s().retainedSidePanels[w][0].generation, first);
  openPluginSidePanel(w, "reader", "chat");
  assert.equal(s().sidePanels[w].generation, first, "opening the shown panel again keeps its instance");
  closePluginSidePanel(w, "reader");
  restartProcess("reader");
  assert.equal(s().sidePanels[w], undefined, "the restart drops the hidden retained panel");
  openPluginSidePanel(w, "reader", "chat");
  assert.ok(s().sidePanels[w].generation > first, "the reopened panel is a new instance");
  assert.equal(s().retainedSidePanels[w][0].generation, s().sidePanels[w].generation);
  await new Promise((resolve) => setTimeout(resolve, STOPPING_NOTICE_MS + 30));
  await settle();
  lifecycle.disablePlugin("reader", consentToken());
});

test("a storage or secret write started while sharing is off isn't counted when sharing turns on before it finishes", async () => {
  keychain.clear();
  await enable(READER);
  const run = await activated();
  const nativePlugins = requireNativeModule("ArdiaPlugins");
  const realWrite = nativePlugins.storageWrite;
  const realSet = globalThis.acTestNativeModules.ArdiaKeychain.set;
  const held = [];
  const hold = (real) => (...args) => new Promise((resolve) => held.push(() => resolve(real(...args))));
  nativePlugins.storageWrite = hold(realWrite);
  globalThis.acTestNativeModules.ArdiaKeychain.set = hold(realSet);
  try {
    takePluginCounts();
    setConsentPeriod(false, null);
    const stored = send("reader", "storage.set", { key: "a", value: 1 }, run);
    const secret = send("reader", "secrets.set", { key: "token", value: "s3cret" }, run);
    await settle();
    assert.equal(held.length, 2, "both writes are waiting on the host");
    setConsentPeriod(true, "plugins-v2-test-later");
    while (held.length) {
      held.shift()();
      await settle();
    }
    for (const sent of [stored, secret]) assert.deepEqual(host.replies.slice(sent.before).map((r) => JSON.parse(r.line)).find((r) => r.id === sent.id).result, { ok: true });
    const counts = takePluginCounts();
    assert.equal(counts.plugin_storage_writes, 0);
    assert.equal(counts.plugin_secret_writes, 0);
  } finally {
    nativePlugins.storageWrite = realWrite;
    globalThis.acTestNativeModules.ArdiaKeychain.set = realSet;
    setConsentPeriod(true, "plugins-v2-test");
  }
  assert.deepEqual((await ask("reader", "storage.set", { key: "b", value: 2 }, run)).result, { ok: true });
  assert.deepEqual((await ask("reader", "secrets.set", { key: "other", value: "y" }, run)).result, { ok: true });
  const counted = takePluginCounts();
  assert.deepEqual([counted.plugin_storage_writes, counted.plugin_secret_writes], [1, 1], "writes started while sharing is on still count");
  lifecycle.disablePlugin("reader", consentToken());
});

const ASKER = { manifest: 2, name: "asker", title: "Asker", main: "index.js", permissions: {}, contributes: { tools: [{ name: "noop", title: "Noop" }] } };
const LAZY = { manifest: 2, name: "lazy", title: "Lazy", main: "index.js", permissions: {}, contributes: { tools: [{ name: "echo", title: "Echo" }] } };

const echoLinesTo = (run) => host.events.filter((e) => e.name === "lazy" && e.run === run && JSON.parse(e.line).tool === "echo");

test("a plugin's tool call waiting on another plugin's activation is cancelled when the caller stops or restarts, and never reaches the callee", async () => {
  await enable(ASKER, LAZY);
  await activated("asker");
  for (const stop of [() => restartProcess("asker"), () => lifecycle.disablePlugin("asker", consentToken())]) {
    if (P().processes.lazy) restartProcess("lazy");
    await settledStops();
    await settle();
    assert.equal(P().processes.asker?.state, "running", "the caller is running when it calls");
    takePluginCounts();
    let outcome = null;
    const calling = callTool("lazy", "echo", {}, { kind: "plugin", plugin: "asker" }).then((o) => (outcome = o));
    await settle();
    assert.equal(outcome, null, "the call waits for lazy to get ready");
    const lazyRun = P().processes.lazy.run;
    assert.ok(lazyRun > 0, "lazy is starting for the call");
    stop();
    await settle();
    assert.ok(outcome, "the caller stopping settles the call before lazy is ready");
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /asker, which asked, stopped/);
    assert.deepEqual((await ask("lazy", "ready", {}, lazyRun)).result, { ok: true });
    await settle();
    await calling;
    assert.deepEqual(echoLinesTo(lazyRun), [], "the stale call never goes out once lazy is ready");
    const counts = takePluginCounts();
    assert.deepEqual([counts.plugin_tool_calls, counts.plugin_tool_failures], [0, 0]);
  }
  lifecycle.disablePlugin("lazy", consentToken());
});

test("a tool call never reaches a target stopped or restarted after it got ready but before the call went out", async () => {
  await enable(LAZY);
  for (const stop of [() => restartProcess("lazy"), () => lifecycle.disablePlugin("lazy", consentToken())]) {
    if (P().processes.lazy) restartProcess("lazy");
    await settledStops();
    await settle();
    takePluginCounts();
    const calling = callTool("lazy", "echo", {}, { kind: "socket" });
    await settle();
    const lazyRun = P().processes.lazy.run;
    send("lazy", "ready", {}, lazyRun);
    stop();
    const outcome = await calling;
    await settle();
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /lazy/);
    assert.deepEqual(echoLinesTo(lazyRun), [], "the call never goes out to the stopping run");
    assert.equal(takePluginCounts().plugin_tool_calls, 0);
  }
  lifecycle.disablePlugin("lazy", consentToken());
  await settledStops();
});

test("a tool call to a lazy plugin keeps the consent it began with while the plugin gets ready", async () => {
  await enable(LAZY);
  const cases = [
    { name: "begun while sharing is off", begin: () => setConsentPeriod(false, null), during: () => setConsentPeriod(true, "plugins-v2-test-later") },
    { name: "sharing reset off and on during activation", begin: () => setConsentPeriod(true, "plugins-v2-test-before"), during: () => (setConsentPeriod(false, null), setConsentPeriod(true, "plugins-v2-test-after")) },
  ];
  try {
    for (const { name, begin, during } of cases) {
      if (P().processes.lazy) restartProcess("lazy");
      await settledStops();
      await settle();
      takePluginCounts();
      begin();
      const calling = callTool("lazy", "echo", {}, { kind: "socket" });
      await settle();
      const lazyRun = P().processes.lazy.run;
      assert.ok(lazyRun > 0, `${name}: lazy is starting for the call`);
      assert.deepEqual(echoLinesTo(lazyRun), [], `${name}: the call waits for lazy to get ready`);
      during();
      assert.deepEqual((await ask("lazy", "ready", {}, lazyRun)).result, { ok: true });
      await settle();
      const toolCall = echoLinesTo(lazyRun).map((e) => JSON.parse(e.line)).at(-1);
      assert.ok(toolCall, `${name}: the call goes out once lazy is ready`);
      await ask("lazy", "result", { call: toolCall.call, error: "nope" }, lazyRun);
      assert.equal((await calling).ok, false);
      const counts = takePluginCounts();
      assert.deepEqual([counts.plugin_tool_calls, counts.plugin_tool_failures], [0, 0], name);
    }
  } finally {
    setConsentPeriod(true, "plugins-v2-test");
  }
  lifecycle.disablePlugin("lazy", consentToken());
});

test("only failed tool calls count as plugin_tool_failures; failed commands and omnibox queries don't", async () => {
  await enable(READER, LAZY);
  const provider = useRegisteredProviders.getState().list.find((p) => p.id === "plugin:reader:notes");
  const run = await activated();
  takePluginCounts();
  const rows = provider.query("hello", new AbortController().signal);
  await settle();
  const query = lines().findLast((e) => e.kind === "omnibox");
  await ask("reader", "result", { call: query.call, error: "no notes" }, run);
  await rows.catch(() => null);
  const w = S().createWindow({ url: "https://a.example/" });
  const ran = runPluginCommand("reader", "summarize", w, { url: "https://a.example/x" });
  await settle();
  const command = lines().findLast((e) => e.kind === "command");
  await ask("reader", "result", { call: command.call, error: "it broke" }, run);
  await ran;
  let counts = takePluginCounts();
  assert.equal(counts.plugin_tool_failures, 0, "a failed command or omnibox query isn't a tool failure");
  assert.equal(counts.plugin_tool_calls, 0);
  const lazyRun = await activated("lazy");
  takePluginCounts();
  const calling = callTool("lazy", "echo", {}, { kind: "socket" });
  await settle();
  const toolCall = echoLinesTo(lazyRun).map((e) => JSON.parse(e.line)).at(-1);
  await ask("lazy", "result", { call: toolCall.call, error: "nope" }, lazyRun);
  assert.equal((await calling).ok, false);
  counts = takePluginCounts();
  assert.deepEqual([counts.plugin_tool_calls, counts.plugin_tool_failures], [1, 1], "a failed tool call is counted");
  lifecycle.disablePlugin("reader", consentToken());
  lifecycle.disablePlugin("lazy", consentToken());
});

test("saving a secret row in Settings counts plugin_secret_writes under the consent it began with", async () => {
  keychain.clear();
  await enable(READER);
  takePluginCounts();
  assert.deepEqual(await setPluginSecretRow("reader", "token", "s3cret"), { ok: true, value: true });
  assert.equal(keychain.get("ardia.plugin.reader.token"), "s3cret");
  assert.equal(takePluginCounts().plugin_secret_writes, 1, "a save while sharing is on counts once");
  assert.deepEqual(await setPluginSecretRow("reader", "token", null), { ok: true, value: true });
  assert.equal((await setPluginSecretRow("reader", "limit", "x")).ok, false);
  assert.equal(takePluginCounts().plugin_secret_writes, 0, "clearing a row or a refused save isn't a write");
  const realSet = globalThis.acTestNativeModules.ArdiaKeychain.set;
  const held = [];
  globalThis.acTestNativeModules.ArdiaKeychain.set = (...args) => new Promise((resolve) => held.push(() => resolve(realSet(...args))));
  try {
    setConsentPeriod(false, null);
    const saving = setPluginSecretRow("reader", "token", "later");
    await settle();
    setConsentPeriod(true, "plugins-v2-test-later");
    while (held.length) {
      held.shift()();
      await settle();
    }
    assert.deepEqual(await saving, { ok: true, value: true });
    assert.equal(takePluginCounts().plugin_secret_writes, 0, "a save begun while sharing was off isn't counted");
  } finally {
    globalThis.acTestNativeModules.ArdiaKeychain.set = realSet;
    setConsentPeriod(true, "plugins-v2-test");
  }
  keychain.clear();
  lifecycle.disablePlugin("reader", consentToken());
});

test("a surface event sent with gesture: false reaches the plugin but never grants or refreshes readActivePage", async () => {
  await enable(READER);
  const run = await activated();
  const w = S().createWindow({ url: "https://a.example/doc" });
  const tab = activeTabId(S(), w);
  webviews.set(tab, { evaluate: async () => ({ text: "Body text", selection: "", lang: "en" }) });
  try {
    assert.equal(dispatchPluginSurfaceEvent("reader", "notes", w, "picked", [{ id: 1 }], { gesture: false }), true);
    assert.deepEqual(lines().at(-1), { surface: "event", surfaceId: "notes", handlerId: "picked", args: [{ id: 1 }] });
    assert.equal((await ask("reader", "tabs.readActivePage", {}, run)).error.code, "refused", "an automatic callback is no gesture");
    const realNow = Date.now;
    try {
      dispatchPluginSurfaceEvent("reader", "notes", w, "read");
      const clicked = realNow();
      Date.now = () => clicked + 20_000;
      dispatchPluginSurfaceEvent("reader", "notes", w, "picked", [], { gesture: false });
      Date.now = () => clicked + 31_000;
      assert.equal((await ask("reader", "tabs.readActivePage", {}, run)).error.code, "refused", "an automatic callback doesn't extend the gesture's 30 s");
    } finally {
      Date.now = realNow;
    }
  } finally {
    webviews.delete(tab);
  }
});

test("opening a file-backed panel wakes a lazy main plugin so the page can talk to it; a view panel waits for its mount", async () => {
  const BOARD = { ...READER, contributes: { ...READER.contributes, panels: [...READER.contributes.panels, { id: "board", title: "Board", mode: "sidecar", file: "board/index.html" }] } };
  await enable(BOARD);
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal(openPluginPanel(w, "reader", "side").ok, true);
  await settle();
  assert.equal(host.starts.length, 0, "a view-backed side panel starts the plugin when its surface mounts, not on open");
  assert.equal(openPluginPanel(w, "reader", "board").ok, true);
  await settle();
  assert.equal(host.starts.length, 1, "the file-backed side panel starts main");
  const run = P().processes.reader.run;
  assert.deepEqual((await ask("reader", "ready", {}, run)).result, { ok: true });
  assert.equal(takePluginCounts().plugin_activations, 1);
  assert.equal(openPluginPanel(w, "reader", "board").ok, true);
  await settle();
  assert.equal(host.starts.length, 1, "a ready plugin isn't started again");
  closePluginSidePanel(w);
});

test("a permission request from a Peek never reaches a plugin's decide hook", async () => {
  const { startDecideHooks } = await import("../automation/decideHooks.ts");
  const { permissionGate } = await import("../site/permissionGate.ts");
  startDecideHooks();
  await enable({ ...GUARD, contributes: { hooks: ["tab.opening", "permission.requested"] } });
  const run = P().processes.guard.run;
  await ask("guard", "ready", {}, run);
  await settle();
  const w = S().createWindow({ url: "https://a.example/" });
  const shown = activeTabId(S(), w);
  const peek = S().openPeek(shown, "https://peek.example/");
  const decides = () => lines().filter((e) => e.kind === "decide").length;
  const before = decides();
  const signal = new AbortController().signal;
  assert.equal(await permissionGate()({ id: "p1", tabId: peek, origin: "https://peek.example", permissions: ["camera"] }, signal), "ask");
  await settle();
  assert.equal(decides(), before, "nothing about a Peek is sent to the plugin");
  const asking = permissionGate()({ id: "p2", tabId: shown, origin: "https://a.example", permissions: ["camera"] }, signal);
  await settle();
  const call = lines().findLast((e) => e.kind === "decide");
  assert.equal(decides(), before + 1, "the page behind the Peek is still asked about");
  assert.equal(call.name, "permission.requested");
  await ask("guard", "result", { call: call.call, result: { permission: "deny" } }, run);
  assert.equal(await asking, "deny");
  lifecycle.disablePlugin("guard", consentToken());
  await settledStops();
});

test("opening a plugin's file page directly, as Open Page and open: tab commands do, wakes a lazy main", async () => {
  await enable(READER);
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal(host.starts.length, 0, "a lazy plugin isn't running before its page opens");
  assert.ok(openPluginPage(w, "reader"));
  await settle();
  assert.equal(host.starts.length, 1, "the file page starts main so it can talk to it");
  await ask("reader", "ready", {}, P().processes.reader.run);
  assert.ok(openPluginPage(w, "reader"));
  await settle();
  assert.equal(host.starts.length, 1, "a ready plugin isn't started again");
});

test("a command's context shows tab and group titles only to a plugin with the tabs permission, like their addresses", () => {
  const context = { url: "https://secret.example/doc?id=1", title: "Q3 layoffs draft", tabId: "t1", windowId: "w1", tabCount: 3 };
  assert.deepEqual(shownCommandContext({ tabs: false }, context), { tabId: "t1", windowId: "w1", tabCount: 3 });
  assert.deepEqual(shownCommandContext({ tabs: "read" }, context), { url: "https://secret.example/doc", title: "Q3 layoffs draft", tabId: "t1", windowId: "w1", tabCount: 3 });
  assert.deepEqual(shownCommandContext({ tabs: false }, { groupId: "g1", title: "Hiring" }), { groupId: "g1" });
});

test("a control-socket caller is the socket inside Ardia and still \"cli\" on the wire, for protocol 2 as for protocol 1", async () => {
  await enable(LAZY);
  const lazyRun = await activated("lazy");
  const calling = callTool("lazy", "echo", {}, { kind: "socket" });
  await settle();
  const toolCall = echoLinesTo(lazyRun).map((e) => JSON.parse(e.line)).at(-1);
  assert.deepEqual(toolCall.caller, { kind: "cli" });
  await ask("lazy", "result", { call: toolCall.call, result: { ok: 1 } }, lazyRun);
  assert.deepEqual(await calling, { ok: true, result: { ok: 1 } });
  lifecycle.disablePlugin("lazy", consentToken());
  await settledStops();
});

test("programs.status and programs.relink answer a plugin about its own programs only", async () => {
  const TOOLS = { manifest: 2, name: "tooly", title: "Tooly", main: "index.js", permissions: {}, contributes: { programs: [{ name: "tooly", path: "bin/tooly", example: "tooly go" }] } };
  host.linkResult = { ok: true, linked: [], refused: { tooly: "/home/.local/bin/tooly is someone else's" }, binDir: "/home/.local/bin" };
  await enable(TOOLS);
  await settle();
  const m = P().listings.tooly.manifest;
  const caller = { name: "tooly", run: P().processes.tooly?.run ?? 1 };
  assert.deepEqual(answerMethod(caller, m, "programs.status", {}).result, { state: "failed", linked: [], failed: [{ name: "tooly", reason: "/home/.local/bin/tooly is someone else's" }], binDir: "/home/.local/bin" });
  host.linkResult = null;
  assert.deepEqual(answerMethod(caller, m, "programs.relink", {}), { result: { ok: true } });
  await settle();
  assert.deepEqual(answerMethod(caller, m, "programs.status", {}).result, { state: "linked", linked: ["tooly"], failed: [], binDir: "/home/.local/bin" });
  await enable(READER);
  const reader = P().listings.reader.manifest;
  assert.deepEqual(answerMethod({ name: "reader", run: 1 }, reader, "programs.status", {}).result, { state: "none", linked: [], failed: [], binDir: null });
  assert.equal(answerMethod({ name: "reader", run: 1 }, reader, "programs.relink", {}).error.code, "refused");
  lifecycle.disablePlugin("tooly", consentToken());
  lifecycle.disablePlugin("reader", consentToken());
  await settledStops();
});

test("an omnibox query cancelled while its lazy plugin starts never goes out, and one cancelled while waiting frees its slot", async () => {
  await enable(READER);
  const provider = useRegisteredProviders.getState().list.find((p) => p.id === "plugin:reader:notes");
  const early = new AbortController();
  const first = provider.query("he", early.signal);
  early.abort();
  const run = await activated();
  assert.deepEqual(await first, []);
  await settle();
  assert.equal(lines().filter((e) => e.kind === "omnibox").length, 0, "a query cancelled during startup is never sent");
  const late = new AbortController();
  const second = provider.query("hel", late.signal);
  await settle();
  const sent = lines().findLast((e) => e.kind === "omnibox");
  assert.equal(sent.input, "hel");
  const before = waitingCalls();
  late.abort();
  assert.deepEqual(await second, []);
  assert.equal(waitingCalls(), before - 1, "the cancelled call no longer holds a slot");
  assert.deepEqual(lines().at(-1), { call: sent.call, cancel: true }, "the plugin is told to stop");
  await ask("reader", "result", { call: sent.call, result: [{ title: "Late", url: "https://late.example/" }] }, run);
  lifecycle.disablePlugin("reader", consentToken());
});
