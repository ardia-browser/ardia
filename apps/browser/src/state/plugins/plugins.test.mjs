import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest, needsReview } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { pluginBarActions, runPluginAction } = await import("./commands.ts");
const { pageContextOf, pageViewUrl, shownContext, openPluginPage } = await import("./pages.ts");
const { barActions } = await import("../omnibox/barActions.ts");
const { isInternalTab } = await import("../pages/urls.ts");
const { processExited, restartProcess, CRASH_LIMIT } = await import("./process.ts");
const { callTool } = await import("./tools.ts");
const { pluginSocketMethod } = await import("./socketMethods.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { consentLines } = await import("./consent.ts");
const { useToasts } = await import("../app/toasts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { setQuitting } = await import("../app/quit.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const { logConsent } = await import("../telemetry/consoleConsent.ts");
setConsentPeriod(true, "plugins-test");

const FIXTURE = readFileSync(new URL("../../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8");
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const host = stub.pluginHost;
let nextId = 0;

after(() => lifecycle.disablePlugin("example"));

function resetHost() {
  for (const key of ["starts", "stops", "replies", "events", "removed"]) host[key].length = 0;
  host.startResult = null;
}

async function install(text = FIXTURE, name = "example") {
  host.folders = [{ name, status: "ok", text }];
  await lifecycle.rescanPlugins(consentToken());
}

async function enabled() {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  resetHost();
  await install();
  assert.ok(lifecycle.requestPluginConsent("example"));
  const { hash } = P().consent;
  assert.ok(lifecycle.enablePlugin("example", hash));
  await settle();
  return P().processes.example.run;
}

function helper(method, params, run) {
  const id = ++nextId;
  const before = host.replies.length;
  stub.emitPluginLine({ name: "example", run, line: JSON.stringify({ id, method, params }) });
  return { id, before };
}

async function ask(method, params, run) {
  const { id, before } = helper(method, params, run);
  await settle();
  const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.ok(reply, `a reply to ${method}`);
  return reply;
}

beforeEach(() => takePluginCounts());

test("an installed plugin stays off until its consent is accepted, then starts its helper sandboxed without network", async () => {
  S().hydrate({});
  startPlugins();
  resetHost();
  await install();
  assert.equal(activeManifest(P(), "example"), null);
  assert.equal(host.starts.length, 0);
  assert.equal(lifecycle.enablePlugin("example", "0".repeat(64)), false, "a stale hash never turns it on");
  const run = await enabled();
  assert.ok(run > 0);
  assert.deepEqual(host.starts.at(-1), { name: "example", run: ["/usr/bin/python3", "helper.py"], memoryMB: 256, network: false, folderId: "", approved: P().records.example.approved, page: true, launch: host.starts.at(-1).launch });
  assert.equal(typeof host.starts.at(-1).launch, "number", "each start carries the launch its lines must name");
  assert.equal(P().processes.example.state, "running");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_enables, 1);
  assert.equal(counts.plugin_process_starts, 1);
});

test("the consent sheet names every reach the plugin gets", () => {
  const lines = consentLines(P().listings.example.manifest).map((l) => l.text).join("\n");
  for (const words of ["/usr/bin/python3 helper.py", "can't connect to anything or accept connections", "title of your tabs", "tab.activated", "Runs Ardia commands", "commandBarStart", "ardia://example", "handed the tab you're on", "Say Hello", "Offers tools"]) assert.ok(lines.includes(words), words);
});

test("settings defaults apply on enable and go back on disable, unless changed since", async () => {
  S().hydrate({});
  const before = S().settings.commandBarStart;
  await enabled();
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 5 } });
  lifecycle.disablePlugin("example");
  assert.deepEqual(S().settings.commandBarStart, before);
  await enabled();
  S().updateSettings({ commandBarStart: { openTabs: { limit: 3 } } });
  lifecycle.disablePlugin("example");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 3 } }, "a value changed since stays");
});

test("config.json wins over a plugin's defaults", async () => {
  stub.configFolder.files.set("config.json", JSON.stringify({ settings: { commandBarStart: { openTabs: { limit: 2 } } } }));
  try {
    await enabled();
    assert.notDeepEqual(S().settings.commandBarStart, { openTabs: { limit: 5 } });
    assert.deepEqual(P().records.example.applied, {});
  } finally {
    stub.configFolder.files.delete("config.json");
    lifecycle.disablePlugin("example");
  }
});

test("the helper's channel: hello, values, permissions and hooks", async () => {
  const run = await enabled();
  const hello = await ask("hello", {}, run);
  assert.equal(hello.result.plugin, "example");
  assert.deepEqual(hello.result.values, { greeting: "Hello", loud: false, mood: "calm", side: "right" });
  assert.equal((await ask("subscribe", { events: ["window.closed"] }, run)).error.code, "refused");
  assert.deepEqual((await ask("subscribe", { events: ["*"] }, run)).result, { ok: true });
  assert.ok(Array.isArray((await ask("windows", {}, run)).result));
  assert.equal((await ask("page.serve", {}, run)).error.code, "unknown_method", "pages are never served by a helper");
  assert.equal((await ask("nope", {}, run)).error.code, "unknown_method");
  lifecycle.setPluginValue("example", "greeting", "Hi");
  const sent = host.events.map((e) => JSON.parse(e.line)).filter((e) => e.event === "plugin.values");
  assert.equal(sent.at(-1).data.values.greeting, "Hi");
  lifecycle.setPluginValue("example", "mood", "furious");
  assert.equal(P().records.example.values.mood, "calm", "a value outside the row's choices is refused");
});

test("hook events reach a subscribed helper, with minimized URLs", async () => {
  const run = await enabled();
  await ask("subscribe", { events: ["tab.opened"] }, run);
  const from = host.events.length;
  const w = S().createWindow({ url: "https://a.example/page?secret=1#x" });
  await settle();
  const opened = host.events.slice(from).map((e) => JSON.parse(e.line)).filter((e) => e.event === "tab.opened");
  assert.ok(opened.length >= 1, "tab.opened arrived");
  assert.ok(opened.every((e) => !e.data.url.includes("secret")));
  S().closeWindow?.(w);
});

test("a command calls the plugin's tool and shows its message; the result goes back to the caller", async () => {
  const run = await enabled();
  const actions = pluginBarActions(P()).map((a) => a.id);
  assert.deepEqual(actions, ["plugin:example/:page", "plugin:example/say-hello", "plugin:example/new-tab", "plugin:example/beside"]);
  const w = S().createWindow({ url: "https://a.example/" });
  const ran = runPluginAction("plugin:example/say-hello", w);
  await settle();
  const call = host.events.map((e) => JSON.parse(e.line)).findLast((e) => e.call && e.tool === "hello");
  assert.deepEqual(call.caller, { kind: "command" });
  const answered = await ask("result", { call: call.call, result: { message: "Hello there" } }, run);
  assert.deepEqual(answered.result, { ok: true });
  await ran;
  assert.equal(useToasts.getState().toasts[w]?.title, "Hello there");
  assert.equal((await ask("result", { call: call.call, result: 1 }, run)).error.code, "bad_request", "a second answer is refused");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_commands_run, 1);
  assert.equal(counts.plugin_tool_calls, 1);
});

test("tools: the CLI and other plugins call them; unknown tools and stopped helpers fail clearly", async () => {
  const run = await enabled();
  const pending = pluginSocketMethod("plugins.call", { plugin: "example", tool: "seen", input: {} });
  await settle();
  const call = host.events.map((e) => JSON.parse(e.line)).findLast((e) => e.call && e.tool === "seen");
  assert.deepEqual(call.caller, { kind: "cli" }, "a socket caller is still \"cli\" on the wire");
  await ask("result", { call: call.call, result: { events: [] } }, run);
  assert.deepEqual(await pending, { result: { events: [] } });
  assert.equal((await callTool("example", "missing", {}, { kind: "socket" })).code, "bad_request");
  assert.equal((await callTool("other", "hello", {}, { kind: "socket" })).code, "refused");
  const { id, before } = helper("tools.call", { plugin: "example", tool: "hello" }, run);
  await settle();
  const nested = host.events.map((e) => JSON.parse(e.line)).findLast((e) => e.call && e.tool === "hello");
  assert.deepEqual(nested.caller, { kind: "plugin", plugin: "example" });
  await ask("result", { call: nested.call, error: "no greeting" }, run);
  const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.deepEqual(reply.error, { code: "failed", message: "no greeting" });
});

test("a crashing helper restarts with backoff, then stays stopped", async () => {
  const run = await enabled();
  processExited({ name: "example", run, status: 1, signal: null, overMemory: false }, 0);
  assert.equal(P().processes.example.state, "waiting");
  let state = P().processes.example;
  let now = 0;
  for (let i = 1; i < CRASH_LIMIT; i++) {
    usePlugins.setState({ processes: { ...P().processes, example: { state: "running", run: run + 100 + i, since: now } } });
    processExited({ name: "example", run: run + 100 + i, status: null, signal: 9, overMemory: i === 2 }, (now += 1000));
    state = P().processes.example;
  }
  assert.equal(state.state, "crashed");
  assert.equal(takePluginCounts().plugin_process_crashes, CRASH_LIMIT);
  lifecycle.disablePlugin("example");
});

test("a clean exit isn't restarted, and an old run's exit is ignored", async () => {
  const run = await enabled();
  processExited({ name: "example", run: run - 1, status: 1, signal: null, overMemory: false });
  assert.equal(P().processes.example.state, "running");
  processExited({ name: "example", run, status: 0, signal: null, overMemory: false });
  assert.equal(P().processes.example.state, "exited");
});

test("a changed manifest stops everything until reviewed; disabling withdraws commands, page and helper", async () => {
  await enabled();
  const w = S().createWindow({ url: "https://a.example/" });
  const page = openPluginPage(w, "example");
  assert.equal(pageViewUrl(P(), "example"), "ardia-plugin://example/page/index.html");
  const changed = JSON.parse(FIXTURE);
  changed.permissions.push("network");
  await install(JSON.stringify(changed));
  assert.ok(needsReview(P(), "example"));
  assert.equal(activeManifest(P(), "example"), null);
  assert.equal(P().processes.example, undefined);
  assert.ok(host.stops.some((s) => s.name === "example"));
  assert.equal(pageViewUrl(P(), "example"), null, "a changed plugin's page shows that it's off");
  assert.ok(isInternalTab(S().tabs[page]), "its tab stays an internal page, never a Chrome page");
  assert.deepEqual(pluginBarActions(P()), []);
  assert.ok(lifecycle.requestPluginConsent("example"));
  assert.ok(lifecycle.enablePlugin("example", P().consent.hash));
  await settle();
  assert.equal(host.starts.at(-1).network, true);
  lifecycle.disablePlugin("example");
  assert.equal(P().processes.example, undefined);
  assert.deepEqual(pluginBarActions(P()), []);
});

test("problems keep a plugin from loading; a folder whose name differs from the manifest is reported", async () => {
  await install(FIXTURE, "renamed");
  assert.equal(P().listings.renamed.manifest, null);
  assert.ok(P().listings.renamed.problems.some((p) => p.includes("its folder is renamed")));
  host.folders = [{ name: "broken", status: "tooBig" }];
  await lifecycle.rescanPlugins(consentToken());
  assert.deepEqual(P().listings.broken.problems, ["plugin.json is over 1 MB"]);
});

test("socket methods list, enable (through the sheet), disable and remove", async () => {
  await enabled();
  const list = pluginSocketMethod("plugins", {}).result;
  assert.equal(list[0].name, "example");
  assert.equal(list[0].active, true);
  assert.deepEqual(list[0].contributes, ["settings", "commands", "page", "process", "programs", "hooks", "tools"]);
  assert.deepEqual(await pluginSocketMethod("plugins.disable", { name: "example" }), { result: { ok: true } });
  assert.deepEqual(pluginSocketMethod("plugins.enable", { name: "example" }), { result: { waiting: true } });
  assert.equal(activeManifest(P(), "example"), null, "enabling from the CLI only opens the sheet");
  lifecycle.dismissPluginConsent();
  assert.deepEqual(await pluginSocketMethod("plugins.remove", { name: "example" }), { result: { ok: true } });
  assert.deepEqual(host.removed, ["example"]);
  assert.equal(P().listings.example, undefined);
  assert.equal(P().records.example, undefined);
});

test("a helper can't reach through another plugin's tools to a permission it wasn't granted", async () => {
  const run = await enabled();
  const other = JSON.parse(FIXTURE);
  other.name = "other";
  other.permissions = ["tabs", "commands", "network"];
  host.folders = [{ name: "example", status: "ok", text: FIXTURE }, { name: "other", status: "ok", text: JSON.stringify(other) }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("other"));
  assert.ok(lifecycle.enablePlugin("other", P().consent.hash));
  await settle();
  const refused = await ask("tools.call", { plugin: "other", tool: "hello" }, run);
  assert.equal(refused.error.code, "refused");
  assert.match(refused.error.message, /network/);
  lifecycle.disablePlugin("other");
});

test("the page is a tab at ardia://<name>; a command opens it beside the current tab, handing it that tab", async () => {
  await enabled();
  const w = S().createWindow({ url: "https://a.example/read?id=7#top" });
  const reading = S().windows[w].tabIds[0];
  S().updateTab(reading, { url: "https://a.example/read?id=7#top", title: "Reading" });
  takePluginCounts();
  await runPluginAction("plugin:example/beside", w);
  const split = Object.values(S().splits ?? {}).find((sp) => JSON.stringify(sp).includes(reading));
  const page = S().windows[w].tabIds.find((id) => S().tabs[id].url === "ardia://example");
  assert.ok(page, "a tab at ardia://example");
  assert.ok(isInternalTab(S().tabs[page]));
  assert.ok(split && JSON.stringify(split).includes(page), "the page and the tab share a split");
  const context = pageContextOf(page);
  assert.deepEqual(context, { tabId: reading, url: "https://a.example/read?id=7#top", title: "Reading" });
  assert.equal(shownContext(P(), "example", context).url, "https://a.example/read", "without fullUrls the page gets the URL without its query");
  assert.equal(pageViewUrl(P(), "example"), "ardia-plugin://example/page/index.html", "the context never rides in the page's URL");
  const counts = takePluginCounts();
  assert.equal(counts.plugin_split_opens, 1);
  assert.equal(counts.plugin_page_opens, 1);
  lifecycle.setPluginValue("example", "side", "left");
  assert.equal(P().records.example.values.side, "left");
  assert.equal(openPluginPage(w, "example"), page, "opening again goes to the same tab");
  lifecycle.disablePlugin("example");
});

test("two plugins setting the same setting: whichever leaves, the other's value or the original comes back", async () => {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const original = S().settings.commandBarStart;
  const second = JSON.parse(FIXTURE);
  second.name = "second";
  second.settings.defaults = { commandBarStart: { openTabs: { limit: 2 } } };
  host.folders = [{ name: "example", status: "ok", text: FIXTURE }, { name: "second", status: "ok", text: JSON.stringify(second) }];
  await lifecycle.rescanPlugins(consentToken());
  const on = (name) => (assert.ok(lifecycle.requestPluginConsent(name)), assert.ok(lifecycle.enablePlugin(name, P().consent.hash)));
  on("example");
  on("second");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 2 } });
  lifecycle.disablePlugin("example");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 2 } }, "the plugin still on keeps its value");
  lifecycle.disablePlugin("second");
  assert.deepEqual(S().settings.commandBarStart, original, "the value from before either plugin comes back, not the first plugin's");
});

test("a plugin can't set settings that need their own approval", async () => {
  const doc = JSON.parse(FIXTURE);
  doc.settings.defaults = { launchActions: ["newTab"] };
  await install(JSON.stringify(doc));
  assert.equal(P().listings.example.manifest, null);
  assert.ok(P().listings.example.problems.some((p) => p.includes("launchActions needs its own approval")));
});

test("pages take a path: each path is its own tab, and a helper opens them with page.open", async () => {
  const run = await enabled();
  const w = S().createWindow({ url: "https://a.example/" });
  const history = openPluginPage(w, "example", { path: "/history" });
  const chat = openPluginPage(w, "example", { path: "/chats/42?draft=1" });
  assert.notEqual(history, chat);
  assert.equal(S().tabs[chat].url, "ardia://example/chats/42?draft=1");
  assert.ok(isInternalTab(S().tabs[chat]));
  assert.equal(openPluginPage(w, "example", { path: "/history" }), history, "the same path goes back to its tab");
  assert.equal(openPluginPage(w, "example", { path: "/../x" }), null);
  assert.match(pageViewUrl(P(), "example", "/chats/42?draft=1"), /\?ardiaPath=%2Fchats%2F42%3Fdraft%3D1$/);
  const opened = await ask("page.open", { path: "/chats/7", split: true, side: "left" }, run);
  assert.ok(opened.result.tabId);
  assert.equal(S().tabs[opened.result.tabId].url, "ardia://example/chats/7");
  assert.equal((await ask("page.open", { path: "nope path" }, run)).error.code, "bad_request");
  lifecycle.disablePlugin("example");
});

test("a plugin folder replaced on disk needs a new approval, even with the same plugin.json", async () => {
  host.folders = [{ name: "example", status: "ok", text: FIXTURE, folderId: "1:100" }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("example") && lifecycle.enablePlugin("example", P().consent.hash));
  await settle();
  assert.deepEqual([host.starts.at(-1).folderId, host.starts.at(-1).approved], ["1:100", P().records.example.approved], "the helper starts bound to the folder and manifest you approved");
  host.folders = [{ name: "example", status: "ok", text: FIXTURE, folderId: "1:200" }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(needsReview(P(), "example"), "a new folder identity is a change");
  assert.equal(activeManifest(P(), "example"), null);
  lifecycle.disablePlugin("example");
});

test("two plugins setting the same value: turning the first off keeps it while the second is on", async () => {
  S().hydrate({});
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const original = S().settings.commandBarStart;
  const twin = JSON.parse(FIXTURE);
  twin.name = "twin";
  host.folders = [{ name: "example", status: "ok", text: FIXTURE }, { name: "twin", status: "ok", text: JSON.stringify(twin) }];
  await lifecycle.rescanPlugins(consentToken());
  for (const name of ["example", "twin"]) assert.ok(lifecycle.requestPluginConsent(name) && lifecycle.enablePlugin(name, P().consent.hash));
  lifecycle.disablePlugin("example");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 5 } });
  lifecycle.disablePlugin("twin");
  assert.deepEqual(S().settings.commandBarStart, original);
});

test("a stopped helper's requests are ignored and its pending calls fail at once", async () => {
  const run = await enabled();
  const pending = callTool("example", "seen", {}, { kind: "socket" });
  await settle();
  lifecycle.disablePlugin("example");
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /stopped/);
  const before = host.replies.length;
  stub.emitPluginLine({ name: "example", run, line: JSON.stringify({ id: 1, method: "run", params: { command: "newTab" } }) });
  await settle();
  assert.equal(host.replies.length, before, "nothing answers, nothing runs");
});

test("plugin commands stay out of private windows and never hand a private tab to a page", async () => {
  await enabled();
  const normal = S().createWindow({ url: "https://a.example/" });
  assert.ok(barActions(S(), normal).some((a) => a.id.startsWith("plugin:example/")));
  const w = S().createWindow({ kind: "private", url: "https://secret.example/a" });
  const secret = S().windows[w].tabIds[0];
  S().updateTab(secret, { url: "https://secret.example/a", title: "Secret" });
  assert.equal(barActions(S(), w).some((a) => a.id.startsWith("plugin:")), false, "no plugin entries in a private window");
  const tabs = Object.keys(S().tabs).length;
  await runPluginAction("plugin:example/beside", w);
  assert.equal(Object.keys(S().tabs).length, tabs, "running one there opens nothing");
  assert.equal(openPluginPage(w, "example", { split: true, context: true }), null);
  lifecycle.disablePlugin("example");
});

test("a page's context belongs to the plugin, the address and the approval it was handed to", async () => {
  const full = JSON.parse(FIXTURE);
  full.permissions = ["tabs", "fullUrls", "commands"];
  await install(JSON.stringify(full));
  assert.ok(lifecycle.requestPluginConsent("example") && lifecycle.enablePlugin("example", P().consent.hash));
  const w = S().createWindow({ url: "https://a.example/read?token=1" });
  const reading = S().windows[w].tabIds[0];
  S().updateTab(reading, { url: "https://a.example/read?token=1", title: "Reading" });
  await runPluginAction("plugin:example/beside", w);
  const page = S().windows[w].tabIds.find((id) => S().tabs[id].url === "ardia://example");
  assert.equal(pageContextOf(page)?.url, "https://a.example/read?token=1");
  await install(FIXTURE);
  assert.ok(lifecycle.requestPluginConsent("example") && lifecycle.enablePlugin("example", P().consent.hash));
  assert.equal(pageContextOf(page), null, "approving a manifest with fewer permissions doesn't replay the old context");
  S().activate(reading);
  await runPluginAction("plugin:example/beside", w);
  assert.ok(pageContextOf(page));
  S().updateTab(page, { url: "ardia://other" });
  assert.equal(pageContextOf(page), null, "a page that leaves for another address loses it");
  S().updateTab(page, { url: "ardia://example" });
  assert.equal(pageContextOf(page), null, "and coming back doesn't bring it back");
  const anyContext = { tabId: reading, url: "https://a.example/read?token=1", title: "Reading" };
  assert.doesNotMatch(shownContext(P(), "example", anyContext).url, /token=1/, "the context is cut to the plugin's own permissions");
  lifecycle.disablePlugin("example");
});

test("a command named page doesn't collide with the page's own entry", async () => {
  const doc = JSON.parse(FIXTURE);
  doc.commands.push({ name: "page", title: "Say Page", tool: "hello" });
  await install(JSON.stringify(doc));
  assert.ok(lifecycle.requestPluginConsent("example") && lifecycle.enablePlugin("example", P().consent.hash));
  await settle();
  const ids = pluginBarActions(P()).map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "every entry has its own id");
  const w = S().createWindow({ url: "https://a.example/" });
  const tabs = Object.keys(S().tabs).length;
  const calls = host.events.length;
  void runPluginAction("plugin:example/page", w);
  await settle();
  assert.equal(Object.keys(S().tabs).length, tabs, "the command doesn't open the page");
  assert.ok(host.events.slice(calls).some((e) => JSON.parse(e.line).tool === "hello"), "it calls its tool");
  lifecycle.disablePlugin("example");
});

test("defaults unwind in the order they were applied, even when a later plugin sets the value from before", async () => {
  S().hydrate({});
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const original = S().settings.commandBarStart;
  const dark = JSON.parse(FIXTURE);
  dark.name = "dark";
  dark.settings.defaults = { commandBarStart: { openTabs: { limit: 2 } } };
  const light = JSON.parse(FIXTURE);
  light.name = "light";
  light.settings.defaults = { commandBarStart: original };
  host.folders = [{ name: "dark", status: "ok", text: JSON.stringify(dark) }, { name: "light", status: "ok", text: JSON.stringify(light) }];
  await lifecycle.rescanPlugins(consentToken());
  for (const name of ["dark", "light"]) assert.ok(lifecycle.requestPluginConsent(name) && lifecycle.enablePlugin(name, P().consent.hash));
  assert.deepEqual(S().settings.commandBarStart, original);
  lifecycle.disablePlugin("light");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 2 } }, "the plugin still on gets its value back");
  lifecycle.disablePlugin("dark");
  assert.deepEqual(S().settings.commandBarStart, original, "and once both are off, the value from before either");
});

test("turning a plugin off never overwrites what config.json now sets, even to the plugin's own value", async () => {
  await enabled();
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 5 } });
  stub.configFolder.files.set("config.json", JSON.stringify({ settings: { commandBarStart: { openTabs: { limit: 5 } } } }));
  try {
    lifecycle.disablePlugin("example");
    assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 5 } }, "config.json's value stays");
  } finally {
    stub.configFolder.files.delete("config.json");
  }
});

test("two quick restarts start the helper once", async () => {
  await enabled();
  const starts = host.starts.length;
  restartProcess("example");
  restartProcess("example");
  await settle();
  assert.equal(host.starts.length - starts, 1, "one new helper");
  assert.equal(P().processes.example.state, "running");
  lifecycle.disablePlugin("example");
});

test("when plugins.json can't be saved, turning a plugin on or off changes no settings", async () => {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const original = S().settings.commandBarStart;
  await install();
  assert.ok(lifecycle.requestPluginConsent("example"));
  const { hash } = P().consent;
  stub.refusedWrites.on = true;
  try {
    assert.equal(lifecycle.enablePlugin("example", hash), false);
    assert.deepEqual(S().settings.commandBarStart, original, "a failed enable leaves the setting as it was");
  } finally {
    stub.refusedWrites.on = false;
  }
  assert.ok(lifecycle.enablePlugin("example", hash));
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 5 } });
  stub.refusedWrites.on = true;
  try {
    assert.equal(lifecycle.disablePlugin("example"), false);
    assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 5 } }, "a failed disable keeps the plugin's value it can still restore");
  } finally {
    stub.refusedWrites.on = false;
  }
  assert.ok(lifecycle.disablePlugin("example"));
  assert.deepEqual(S().settings.commandBarStart, original);
});

test("approving a plugin's changed manifest takes its old default out of the stack", async () => {
  S().hydrate({});
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const original = S().settings.commandBarStart;
  const make = (name, limit) => {
    const doc = JSON.parse(FIXTURE);
    doc.name = name;
    doc.settings.defaults = { commandBarStart: { openTabs: { limit } } };
    return { name, status: "ok", text: JSON.stringify(doc) };
  };
  host.folders = [make("first", 2), make("second", 3)];
  await lifecycle.rescanPlugins(consentToken());
  for (const name of ["first", "second"]) assert.ok(lifecycle.requestPluginConsent(name) && lifecycle.enablePlugin(name, P().consent.hash));
  host.folders = [make("first", 4), make("second", 3)];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("first") && lifecycle.enablePlugin("first", P().consent.hash));
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 4 } });
  lifecycle.disablePlugin("first");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 3 } });
  lifecycle.disablePlugin("second");
  assert.deepEqual(S().settings.commandBarStart, original, "the first manifest's old value never comes back");
});

test("a plugin named like an Object property gets its own record", async () => {
  S().hydrate({});
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const doc = JSON.parse(FIXTURE);
  doc.name = "constructor";
  host.folders = [{ name: "constructor", status: "ok", text: JSON.stringify(doc) }];
  await lifecycle.rescanPlugins(consentToken());
  lifecycle.setPluginValue("constructor", "loud", true);
  assert.deepEqual(P().records.constructor.applied, {}, "a whole record, not Object's constructor");
  assert.ok(lifecycle.requestPluginConsent("constructor") && lifecycle.enablePlugin("constructor", P().consent.hash));
  lifecycle.disablePlugin("constructor");
});

test("a value you chose between two plugins comes back when both leave, in either order", async () => {
  S().hydrate({});
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const make = (name, limit) => {
    const doc = JSON.parse(FIXTURE);
    doc.name = name;
    doc.settings.defaults = { commandBarStart: { openTabs: { limit } } };
    return { name, status: "ok", text: JSON.stringify(doc) };
  };
  host.folders = [make("first", 2), make("second", 3)];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("first") && lifecycle.enablePlugin("first", P().consent.hash));
  S().updateSettings({ commandBarStart: { openTabs: { limit: 7 } } });
  assert.ok(lifecycle.requestPluginConsent("second") && lifecycle.enablePlugin("second", P().consent.hash));
  lifecycle.disablePlugin("first");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 3 } });
  lifecycle.disablePlugin("second");
  assert.deepEqual(S().settings.commandBarStart, { openTabs: { limit: 7 } }, "your own value, not the one from before the first plugin");
});

test("removing stops when turning the plugin off can't be saved, and nothing turns it on while it goes", async () => {
  await enabled();
  const hash = P().records.example.approved;
  stub.refusedWrites.on = true;
  try {
    const failed = await lifecycle.removePlugin("example");
    assert.equal(failed.ok, false);
    assert.deepEqual(host.removed, [], "its files stay");
    assert.ok(activeManifest(P(), "example"), "and it stays on");
  } finally {
    stub.refusedWrites.on = false;
  }
  let release;
  host.removeGate = new Promise((resolve) => (release = resolve));
  try {
    const removing = lifecycle.removePlugin("example");
    await settle();
    assert.equal(lifecycle.enablePlugin("example", hash), false, "a removal in progress can't be undone by turning it on");
    release();
    assert.deepEqual(await removing, { ok: true });
  } finally {
    host.removeGate = null;
  }
});

test("a page opens a tab only by asking its helper, which needs the commands permission", async () => {
  const run = await enabled();
  const w = S().createWindow({ url: "https://a.example/" });
  const before = Object.keys(S().tabs).length;
  const opened = await ask("open", { urls: ["https://b.example/from-the-page"] }, run);
  assert.ok(opened.result, JSON.stringify(opened));
  assert.ok(Object.values(S().tabs).some((t) => t.url === "https://b.example/from-the-page"));
  assert.equal(Object.keys(S().tabs).length, before + 1);
  const bare = JSON.parse(FIXTURE);
  bare.permissions = ["tabs"];
  bare.commands = bare.commands.filter((c) => !c.tool || c.tool !== "newtab");
  await install(JSON.stringify(bare));
  assert.ok(lifecycle.requestPluginConsent("example") && lifecycle.enablePlugin("example", P().consent.hash));
  await settle();
  assert.equal((await ask("open", { urls: ["https://c.example/"] }, P().processes.example.run)).error.code, "refused");
  lifecycle.disablePlugin("example");
  void w;
});

test("open takes only http and https URLs, at most ten, refusing everything else before anything opens", async () => {
  const run = await enabled();
  S().createWindow({ url: "https://a.example/" });
  const bad = ["file:///etc/passwd", "/abs/path", "ardia:settings", "ardia://settings", "chrome://history", "about:blank", "javascript:alert(1)", "ardia-plugin://example/page/index.html", "data:text/html,hi", "https://user:pass@b.example/", "https://user@b.example/", " https://b.example/", "https://b.example/\u0000", "https://b.example/\n", "HTTPS:b.example", "https:\\\\b.example", "https://", "ht\ttps://b.example/", "https://b.example/ x", 7, "https://b.example:99999/", "https://b.example:0/", "https://b.example:65536/", "https://b\u00fccher.example/", "https://b.example/\u00a0", "https://b.example/\u2028", "https://b.example/\ud800", "https://[::1/", "https://[::ffff:zz]/", "https://exa%6Dple.com/", "https://b.example\\x/", "https://b.example/\u0085", "https://1.2.3/", "https:///b.example/", `https://b.example/${"a".repeat(2048)}`];
  for (const url of bad) {
    const tabs = Object.keys(S().tabs).length;
    const reply = await ask("open", { urls: [url] }, run);
    assert.equal(reply.error?.code, "bad_request", JSON.stringify(url));
    assert.equal(Object.keys(S().tabs).length, tabs, `nothing opened for ${JSON.stringify(url)}`);
  }
  assert.equal((await ask("open", { urls: Array.from({ length: 11 }, (_, i) => `https://b.example/${i}`) }, run)).error?.code, "bad_request", "at most ten a call");
  const fine = await ask("open", { urls: ["HTTPS://B.example/Mixed?q=1#f", "http://c.example/"] }, run);
  assert.equal(fine.result?.ok, true, JSON.stringify(fine));
  lifecycle.disablePlugin("example");
});

test("open parses the whole address and opens the normalised one, the same address a WHATWG parser reads", async () => {
  const run = await enabled();
  S().createWindow({ url: "https://a.example/" });
  const good = {
    "HTTPS://B.example:443/Mixed?q=1#f": "https://b.example/Mixed?q=1#f",
    "https://b.example/caf\u00e9": "https://b.example/caf%C3%A9",
    "https://b.example/?q=caf\u00e9#\u00e9": "https://b.example/?q=caf%C3%A9#%C3%A9",
    "https://[::1]:8443/x": "https://[::1]:8443/x",
    "https://[0:0:0:0:0:0:0:1]/": "https://[::1]/",
    "https://[2001:DB8::A]/": "https://[2001:db8::a]/",
    "https://b.example./": "https://b.example./",
    "https://b.example:99/": "https://b.example:99/",
    "https://b.example/%2e%2e/x%zz%00?%ff": "https://b.example/%2e%2e/x%zz%00?%ff",
    "https://xn--bcher-kva.example/": "https://xn--bcher-kva.example/",
    "https://b.example": "https://b.example/",
  };
  for (const [raw, expected] of Object.entries(good)) {
    const reply = await ask("open", { urls: [raw] }, run);
    assert.equal(reply.result?.ok, true, `${JSON.stringify(raw)}: ${JSON.stringify(reply)}`);
    const opened = S().tabs[reply.result.tabs[0]];
    assert.equal(opened.url, expected, JSON.stringify(raw));
    assert.equal(new URL(expected).href, new URL(raw).href, `${JSON.stringify(raw)} means the same address after normalising`);
  }
  const port = await ask("open", { urls: ["https://b.example/", "https://b.example:99999/"] }, run);
  assert.equal(port.error?.code, "bad_request");
  assert.match(port.error.message, /^urls\[1\] .*port/);
  assert.match((await ask("open", { urls: ["https://b\u00fccher.example/"] }, run)).error.message, /punycode/);
  assert.match((await ask("open", { urls: ["https://b.example/a b"] }, run)).error.message, /space/);
  assert.match((await ask("open", { urls: ["https://b.example\\x/"] }, run)).error.message, /backslash/);
  assert.match((await ask("open", { urls: ["https://b.example/\u0007"] }, run)).error.message, /control character/);
  lifecycle.disablePlugin("example");
});

test("open answers only with whether it worked and the tabs it created", async () => {
  const run = await enabled();
  S().createWindow({ url: "https://a.example/" });
  const reply = await ask("open", { urls: ["https://b.example/one"] }, run);
  const created = Object.values(S().tabs).filter((t) => t.url === "https://b.example/one").map((t) => t.id);
  assert.deepEqual(reply.result, { ok: true, tabs: created }, "no snapshots, no other tab's id or URL");
  lifecycle.disablePlugin("example");
});

async function withPendingStop(run) {
  let release;
  host.stopGate = new Promise((resolve) => (release = resolve));
  try {
    return await run();
  } finally {
    release();
    host.stopGate = null;
    await settle();
  }
}

const tabCount = () => Object.keys(S().tabs).length;
const recordValues = (name) => P().records[name]?.values;

test("Restart stops accepting the retiring run before it asks for the stop, so a queued open never runs", async () => {
  const run = await enabled();
  S().createWindow({ url: "https://a.example/" });
  const before = tabCount();
  await withPendingStop(async () => {
    helper("open", { urls: ["https://b.example/queued"] }, run);
    restartProcess("example");
    assert.ok(host.stops.length > 0, "the native stop was asked for");
    assert.notEqual(P().processes.example.state, "running", "the retiring run isn't the running one while its stop is pending");
    await settle();
    helper("open", { urls: ["https://b.example/after"] }, run);
    await settle();
    assert.equal(tabCount(), before, "neither the queued open nor a later one from the retiring run opened a tab");
  });
  assert.equal(P().processes.example.state, "running");
  assert.notEqual(P().processes.example.run, run);
  lifecycle.disablePlugin("example");
});

test("a start replaced while it was pending never has its helper's lines taken, whenever Ardia hears it was replaced", async () => {
  await enabled();
  S().createWindow({ url: "https://a.example/" });
  const before = tabCount();
  let release;
  host.startGate = new Promise((resolve) => (release = resolve));
  try {
    restartProcess("example");
    await settle();
    const retired = { run: host.nextRun, launch: host.starts.at(-1).launch };
    restartProcess("example");
    await settle();
    const current = { run: host.nextRun, launch: host.starts.at(-1).launch };
    assert.notEqual(current.launch, retired.launch);
    const asked = ++nextId;
    stub.emitPluginLine({ name: "example", run: retired.run, launch: retired.launch, line: JSON.stringify({ id: asked, method: "open", params: { urls: ["https://b.example/from-the-retired-start"] } }) });
    await settle();
    assert.equal(tabCount(), before, "the retired start's request is refused before its start settles");
    const hello = ++nextId;
    stub.emitPluginLine({ name: "example", run: current.run, launch: current.launch, line: JSON.stringify({ id: hello, method: "hello", params: {} }) });
    await settle();
    assert.ok(host.replies.some((r) => r.run === current.run && JSON.parse(r.line).id === hello), "the current start's early hello is answered at once");
    release();
    await settle();
    assert.equal(P().processes.example.run, current.run);
    assert.equal(tabCount(), before);
    assert.ok(!host.replies.some((r) => JSON.parse(r.line).id === asked), "the retired run never gets an answer");
  } finally {
    host.startGate = null;
    release?.();
  }
  assert.equal((await ask("open", { urls: ["https://b.example/current"] }, P().processes.example.run)).result?.ok, true);
  lifecycle.disablePlugin("example");
});

test("turning off and removing stop accepting the run before the native stop finishes", async () => {
  for (const end of [() => lifecycle.disablePlugin("example"), () => void lifecycle.removePlugin("example")]) {
    const run = await enabled();
    S().createWindow({ url: "https://a.example/" });
    const before = tabCount();
    await withPendingStop(async () => {
      helper("open", { urls: ["https://b.example/queued"] }, run);
      end();
      await settle();
      helper("open", { urls: ["https://b.example/after"] }, run);
      await settle();
      assert.equal(tabCount(), before);
    });
  }
  host.folders = [];
});

test("while Ardia is quitting no helper request is taken, and a cancelled quit takes them again", async () => {
  const run = await enabled();
  S().createWindow({ url: "https://a.example/" });
  const before = tabCount();
  setQuitting(true);
  try {
    helper("open", { urls: ["https://b.example/quitting"] }, run);
    await settle();
    assert.equal(tabCount(), before);
  } finally {
    setQuitting(false);
  }
  assert.equal((await ask("open", { urls: ["https://b.example/cancelled"] }, run)).result?.ok, true);
  lifecycle.disablePlugin("example");
});

async function scanWarningTokens(run) {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => void (String(args[0]).includes("couldn't list the plugins folder") && seen.push(logConsent()));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return seen;
}

test("a removal's follow-up scan reports in the period the removal began in", async () => {
  await enabled();
  setConsentPeriod(false, "plugins-test-off");
  const begun = consentToken();
  let release;
  host.removeGate = new Promise((resolve) => (release = resolve));
  try {
    const seen = await scanWarningTokens(async () => {
      const removing = lifecycle.removePlugin("example");
      await settle();
      setConsentPeriod(true, "plugins-test-on-again");
      host.listFails = true;
      release();
      await removing;
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], begun, "the warning carries the token taken when the removal began, not the newer period's");
  } finally {
    host.removeGate = null;
    host.listFails = false;
    setConsentPeriod(true, "plugins-test");
  }
});

test("a rescan asked for while one runs reports with the token of the change that asked for it", async () => {
  S().hydrate({});
  startPlugins();
  await install();
  let release;
  host.listGate = new Promise((resolve) => (release = resolve));
  try {
    const first = consentToken();
    const seen = await scanWarningTokens(async () => {
      const scanning = lifecycle.rescanPlugins(first);
      setConsentPeriod(true, "plugins-test-later");
      assert.notEqual(consentToken(), first);
      void lifecycle.rescanPlugins(consentToken());
      host.listFails = true;
      release();
      await scanning;
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0], first);
    assert.equal(seen[1], consentToken(), "the queued scan reports in the period of the change that asked for it");
  } finally {
    host.listGate = null;
    host.listFails = false;
    setConsentPeriod(true, "plugins-test");
  }
});

test("a disable reported to the ardia command, and a removal, wait until plugins.json is on disk", async () => {
  await enabled();
  stub.refusedWrites.landingFails = true;
  try {
    const removal = await lifecycle.removePlugin("example");
    assert.equal(removal.ok, false, "nothing is deleted while the disable that must precede it isn't saved");
    assert.match(removal.reason, /plugins.json couldn't be saved/);
    assert.deepEqual(host.removed, []);
  } finally {
    stub.refusedWrites.landingFails = false;
  }
  await enabled();
  stub.refusedWrites.landingFails = true;
  try {
    const reply = await pluginSocketMethod("plugins.disable", { name: "example" });
    assert.equal(reply.error?.code, "failed", "the command isn't told the plugin is off for good");
  } finally {
    stub.refusedWrites.landingFails = false;
  }
  await enabled();
  assert.deepEqual(await pluginSocketMethod("plugins.disable", { name: "example" }), { result: { ok: true } });
});

test("when a helper that called another plugin's tools stops, its waiting calls are released and cancelled", async () => {
  await enabled();
  const second = JSON.parse(FIXTURE);
  second.name = "second";
  host.folders = [{ name: "example", status: "ok", text: FIXTURE }, { name: "second", status: "ok", text: JSON.stringify(second) }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("second") && lifecycle.enablePlugin("second", P().consent.hash));
  await settle();
  const caller = P().processes.example.run;
  const callee = P().processes.second.run;
  for (let i = 0; i < 16; i++) helper("tools.call", { plugin: "second", tool: "seen", input: {} }, caller);
  await settle();
  const full = await Promise.race([callTool("second", "seen", {}, { kind: "socket" }), settle().then(() => null)]);
  assert.match(full?.message ?? "", /too many calls/, "the caller's 16 calls fill second's slots");
  const sentBefore = host.events.length;
  restartProcess("example");
  await settle();
  const cancels = host.events.slice(sentBefore).filter((e) => e.name === "second" && e.run === callee && JSON.parse(e.line).cancel === true);
  assert.equal(cancels.length, 16, "second is told to stop each call its caller can no longer take");
  const after = await Promise.race([callTool("second", "seen", {}, { kind: "socket" }), settle().then(() => null)]);
  assert.equal(after, null, "a new call is waiting on second, not refused");
  lifecycle.disablePlugin("second");
  lifecycle.disablePlugin("example");
  host.folders = [{ name: "example", status: "ok", text: FIXTURE }];
  await lifecycle.rescanPlugins(consentToken());
});

test("a removal whose last plugins.json write fails says the files are gone, and a later scan drops the record", async () => {
  await enabled();
  lifecycle.setPluginValue("example", "greeting", "Hi");
  let release;
  host.removeGate = new Promise((resolve) => (release = resolve));
  let result;
  try {
    const removal = lifecycle.removePlugin("example").then((r) => (result = r));
    await settle();
    stub.refusedWrites.on = true;
    release();
    await removal;
  } finally {
    host.removeGate = null;
    stub.refusedWrites.on = false;
  }
  assert.equal(result.ok, false, "not reported as a clean removal");
  assert.equal(result.removed, true, "but it says the files are gone");
  assert.deepEqual(host.removed, ["example"]);
  assert.ok(P().records.example, "the record is still there while plugins.json can't be written");
  await lifecycle.rescanPlugins(consentToken());
  assert.equal(P().records.example, undefined, "the next scan that can save drops it");
  await install();
  assert.equal(recordValues("example"), undefined, "a new install doesn't inherit the removed plugin's values");
});

test("a plugin whose folder was deleted by hand can still be turned off, which restores its defaults", async () => {
  const original = S().settings.commandBarStart;
  await enabled();
  assert.notDeepEqual(S().settings.commandBarStart, original);
  host.folders = [];
  await lifecycle.rescanPlugins(consentToken());
  assert.equal(P().listings.example, undefined);
  assert.deepEqual(await pluginSocketMethod("plugins.disable", { name: "example" }), { result: { ok: true } });
  assert.deepEqual(S().settings.commandBarStart, original);
  assert.equal(pluginSocketMethod("plugins.disable", { name: "constructor" }).error?.code, "bad_request", "only a plugin's own name counts");
  await install();
});

test("an open queued when its run ends never runs", async () => {
  const run = await enabled();
  S().createWindow({ url: "https://a.example/" });
  const before = Object.keys(S().tabs).length;
  helper("open", { urls: ["https://b.example/late"] }, run);
  stub.emitPluginExit({ name: "example", run, status: 0, signal: null, overMemory: false });
  await settle();
  assert.equal(Object.keys(S().tabs).length, before, "the run that asked has ended, so nothing opens");
  lifecycle.disablePlugin("example");
});

test("a tool call that fails after sharing changed isn't counted in the new period", async () => {
  const run = await enabled();
  takePluginCounts();
  const outcome = callTool("example", "seen", {}, { kind: "socket" });
  await settle();
  setConsentPeriod(true, "plugins-test-next");
  try {
    lifecycle.disablePlugin("example");
    assert.equal((await outcome).ok, false);
    const counts = takePluginCounts();
    assert.equal(counts.plugin_tool_calls, 1, "the call was counted when it began");
    assert.equal(counts.plugin_tool_failures, 0, "its failure carries the old period's token, so it stays local");
  } finally {
    setConsentPeriod(true, "plugins-test");
  }
  void run;
});
