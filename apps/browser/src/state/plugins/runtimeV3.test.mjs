import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { v3Text } from "./fixtures/manifests.mjs";

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated } = await import("./activation.ts");
const { settledStops } = await import("./process.ts");
const { notePluginGesture } = await import("./gestures.ts");
const { mountPluginSurface, usePluginSurfaces } = await import("./surfaces.ts");
const { checkIdle, checkUsage, noteRequest, pausedReason, resumePlugin, usePluginHealth, WATCHDOG } = await import("./watchdog.ts");
const { wantedFor, postToContent, receiveWorldMessage } = await import("./pageWorlds.ts");
const { parseInputUrl, inputUrl, inputModesOf } = await import("./inputModes.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { worldMessagesOf, worldOf, pluginOfWorld } = await import("../../lib/pluginWorlds.ts");
const { reachesLoopback, hostPatternProblem, loopbackPortsOf } = await import("../../lib/pluginNetwork.ts");
const { parseSiteScriptBlocks, siteScriptBlocksJson } = await import("./siteScriptBlocks.ts");
setConsentPeriod(true, "plugins-v3-runtime-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
let nextId = 0;

const NET = {
  manifest: 2,
  name: "net",
  scope: "global",
  title: "Net",
  main: "index.js",
  permissions: { network: ["api.example.com", "localhost:11434"], clipboard: "write", bookmarks: "read", history: "read", notifications: true },
  contributes: { commands: [{ name: "go", title: "Go" }] },
};
const PROVIDER = { manifest: 2, name: "brain", scope: "global", title: "Brain", main: "index.js", provides: ["ai.provider"], contributes: { commands: [{ name: "x", title: "X" }] } };
const CONSUMER = { manifest: 2, name: "asker", scope: "global", title: "Asker", main: "index.js", consumes: ["ai.provider"], contributes: { commands: [{ name: "ask", title: "Ask", inputMode: "ask" }], inputModes: [{ id: "ask", title: "Ask", placeholder: "Ask anything", keywords: ["ai"] }] } };
const LONER = { manifest: 2, name: "loner", scope: "global", title: "Loner", main: "index.js", contributes: { commands: [{ name: "x", title: "X" }] } };
const HYBRID = { manifest: 2, name: "both", scope: "global", title: "Both", main: "index.js", process: { run: ["bin/helper"] }, permissions: { network: "*" }, contributes: { commands: [{ name: "x", title: "X" }] } };
const PAGES = {
  manifest: 2,
  name: "pages",
  scope: "global",
  title: "Pages",
  main: "index.js",
  permissions: { pages: ["https://github.com/*"] },
  contributes: { contentScripts: [{ id: "badge", matches: ["https://github.com/*/pull/*"], js: ["content.js"] }], pageStyles: [{ id: "compact", matches: ["https://github.com/*"], css: "compact.css" }] },
};

function resetHost() {
  for (const key of ["starts", "stops", "replies", "events", "streams", "sockets", "socketSends", "socketCloses", "netCloses"]) host[key].length = 0;
  host.streamResult = null;
  host.socketResult = null;
}

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  resetHost();
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: v3Text(doc) }));
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
  for (let i = 0; i < 40; i++) {
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

const windowId = () => Object.keys(S().windows)[0] ?? S().createWindow({ url: "https://a.example/" });

beforeEach(() => takePluginCounts());

test("a streamed fetch goes to the host with the plugin's hosts, and refuses what the plugin may not reach", async () => {
  await enable(NET);
  const run = await activated("net");
  const ok = await ask("net", "net.fetch.stream", { stream: "f1", url: "https://api.example.com/v1/chat", method: "POST", body: "{}" }, run);
  assert.equal(ok.result.status, 200);
  assert.deepEqual(host.streams.at(-1), { name: "net", run, stream: "f1", url: "https://api.example.com/v1/chat", method: "POST", allowedHosts: ["api.example.com", "localhost:11434"] });
  const local = await ask("net", "net.fetch.stream", { stream: "f2", url: "http://localhost:11434/api/chat" }, run);
  assert.equal(local.result.status, 200, "an explicit local port is reachable over http");
  assert.equal((await ask("net", "net.fetch.stream", { stream: "f3", url: "http://localhost:8080/" }, run)).error.code, "refused");
  assert.equal((await ask("net", "net.fetch.stream", { stream: "f4", url: "https://evil.example.org/" }, run)).error.code, "refused");
  assert.equal((await ask("net", "net.fetch.stream", { stream: "bad id!", url: "https://api.example.com/" }, run)).error.code, "bad_request");
  host.streamResult = { ok: false, reason: "the server couldn't be found" };
  assert.deepEqual((await ask("net", "net.fetch.stream", { stream: "f5", url: "https://api.example.com/" }, run)).error, { code: "failed", message: "the server couldn't be found" });
  assert.deepEqual((await ask("net", "net.fetch.cancel", { stream: "f1" }, run)).result, { ok: true });
  assert.deepEqual(host.streamCancels.at(-1), { name: "net", run, stream: "f1" });
  assert.equal(takePluginCounts().plugin_net_streams, 3);
});

test("a socket connects only to wss on the plugin's hosts or a listed local port, and send and close reach the host", async () => {
  await enable(NET);
  const run = await activated("net");
  assert.deepEqual((await ask("net", "net.ws.connect", { socket: "w1", url: "wss://api.example.com/live", protocols: ["chat"] }, run)).result, { open: true, protocol: "" });
  assert.equal(host.sockets.at(-1).url, "wss://api.example.com/live");
  assert.equal((await ask("net", "net.ws.connect", { socket: "w2", url: "ws://api.example.com/live" }, run)).error.code, "refused");
  assert.equal((await ask("net", "net.ws.connect", { socket: "w3", url: "ws://localhost:11434/" }, run)).result.open, true);
  assert.equal((await ask("net", "net.ws.connect", { socket: "w4", url: "https://api.example.com/" }, run)).error.code, "bad_request");
  assert.equal((await ask("net", "net.ws.connect", { socket: "w5", url: "wss://api.example.com/", protocols: ["a b"] }, run)).error.code, "bad_request");
  assert.deepEqual((await ask("net", "net.ws.send", { socket: "w1", data: "aGk=", binary: true }, run)).result, { ok: true });
  assert.deepEqual(host.socketSends.at(-1), { name: "net", run, socket: "w1", data: "aGk=", binary: true });
  await ask("net", "net.ws.close", { socket: "w1", code: 1, reason: "x".repeat(200) }, run);
  assert.deepEqual([host.socketCloses.at(-1).code, host.socketCloses.at(-1).reason.length], [1000, 123]);
});

test("a consumer calls a provider's service without its permissions; a plugin that doesn't consume it is refused", async () => {
  await enable(PROVIDER, CONSUMER, LONER);
  const brain = await activated("brain", { services: { "ai.provider": ["complete"] } });
  const asker = await activated("asker");
  const loner = await activated("loner");
  const listed = await ask("asker", "services.list", { iface: "ai.provider" }, asker);
  assert.deepEqual(listed.result.providers, [{ plugin: "@test/brain", version: "1.0.0", methods: ["complete"] }]);
  const before = host.events.length;
  const id = ++nextId;
  stub.emitPluginLine({ name: "asker", run: asker, line: JSON.stringify({ id, method: "services.call", params: { iface: "ai.provider", method: "complete", input: { prompt: "hi" } } }) });
  await settle();
  const call = host.events.slice(before).map((e) => JSON.parse(e.line)).find((l) => l.kind === "service");
  assert.deepEqual([call.name, call.method, call.input, call.caller], ["ai.provider", "complete", { prompt: "hi" }, { kind: "plugin", plugin: "asker" }]);
  assert.deepEqual((await ask("brain", "result", { call: call.call, result: { text: "hello" } }, brain)).result, { ok: true });
  await settle();
  const reply = host.replies.map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.deepEqual(reply.result, { text: "hello" });
  assert.equal((await ask("asker", "services.call", { iface: "ai.provider", method: "nope" }, asker)).error.code, "bad_request");
  assert.equal((await ask("loner", "services.call", { iface: "ai.provider", method: "complete" }, loner)).error.code, "refused");
  assert.equal((await ask("loner", "services.provide", { iface: "ai.provider", methods: ["complete"] }, loner)).error.code, "refused", "only a plugin that declares provides may offer it");
});

test("a view patches only what changed, and a patch from a stale revision asks for the whole tree", async () => {
  await enable({ ...LONER, contributes: { ...LONER.contributes, sidebarViews: [{ id: "v", title: "V" }] } });
  const run = await activated("loner");
  await mountPluginSurface("loner", "v#1", "sidebar", windowId(), {}, "v");
  await settle();
  const tree = { type: "Box", props: {}, children: [{ type: "Text", props: {}, children: ["a"] }] };
  const rendered = await ask("loner", "surface.render", { surfaceId: "v#1", tree, rev: 1 }, run);
  assert.deepEqual(rendered.result, { ok: true }, JSON.stringify(rendered.error));
  const ops = [{ op: "replace", path: [0, 0], node: "b" }];
  assert.deepEqual((await ask("loner", "surface.patch", { surfaceId: "v#1", base: 1, rev: 2, ops }, run)).result, { ok: true });
  assert.deepEqual(usePluginSurfaces.getState().trees["loner:v#1"].children[0].children, ["b"]);
  assert.equal((await ask("loner", "surface.patch", { surfaceId: "v#1", base: 1, rev: 3, ops }, run)).error.code, "failed", "base 1 is no longer current");
  assert.equal((await ask("loner", "surface.patch", { surfaceId: "v#1", base: 2, rev: 3, ops: [{ op: "remove", path: [], index: 5, count: 1 }] }, run)).error.code, "bad_request");
  assert.equal((await ask("loner", "surface.patch", { surfaceId: "v#1", base: 2, rev: 3, ops: [{ op: "props", path: [], set: { __proto__: { x: 1 } } }] }, run)).error?.code ?? "ok", "ok");
});

test("a hybrid plugin starts its sidecar beside main, and requests and messages cross only the host's pipe", async () => {
  await enable(HYBRID);
  const run = await activated("both");
  await settle();
  const sidecarStart = host.starts.find((s) => s.sidecar === true);
  assert.ok(sidecarStart, "the sidecar started");
  assert.deepEqual([sidecarStart.name, sidecarStart.run, sidecarStart.network], ["both", ["bin/helper"], true]);
  assert.equal(host.starts.find((s) => s.runtime === "js").network, false, "main's host stays off the network");
  const sidecarRun = host.nextRun;
  const id = ++nextId;
  const before = host.events.length;
  stub.emitPluginLine({ name: "both", run, line: JSON.stringify({ id, method: "sidecar.request", params: { method: "ping", params: { n: 1 } } }) });
  await settle();
  const sent = host.events.slice(before).find((e) => e.name === "both/sidecar");
  const request = JSON.parse(sent.line);
  assert.deepEqual([request.method, request.params], ["ping", { n: 1 }]);
  stub.emitPluginLine({ name: "both/sidecar", run: sidecarRun, line: JSON.stringify({ id: request.id, result: "pong" }) });
  await settle();
  assert.deepEqual(host.replies.map((r) => JSON.parse(r.line)).find((r) => r.id === id).result, "pong");
  stub.emitPluginLine({ name: "both/sidecar", run: sidecarRun, line: JSON.stringify({ event: "message", data: { hi: true } }) });
  await settle();
  assert.deepEqual(JSON.parse(host.events.at(-1).line), { event: "sidecar.message", time: JSON.parse(host.events.at(-1).line).time, data: { message: { hi: true } } });
});

test("browser data and the clipboard need their permissions, and the clipboard a recent use", async () => {
  await enable(NET, LONER);
  const run = await activated("net");
  const loner = await activated("loner");
  assert.equal((await ask("loner", "bookmarks.search", { query: "x" }, loner)).error.code, "refused");
  assert.ok(Array.isArray((await ask("net", "bookmarks.search", { query: "x" }, run)).result.bookmarks));
  assert.equal((await ask("net", "bookmarks.create", { title: "x", url: "https://x.example/" }, run)).error.code, "refused", "read can't write");
  assert.ok(Array.isArray((await ask("net", "history.search", { text: "x" }, run)).result.items));
  assert.equal((await ask("net", "clipboard.writeText", { text: "hi" }, run)).error.code, "refused", "no recent use");
  notePluginGesture("net", windowId());
  assert.deepEqual((await ask("net", "clipboard.writeText", { text: "hi" }, run)).result, { ok: true });
  assert.equal((await ask("net", "clipboard.readText", {}, run)).error.code, "refused", "write doesn't read");
  assert.equal((await ask("net", "fs.pickFiles", {}, run)).error.code, "refused");
  assert.equal((await ask("net", "media.sessions", {}, run)).error.code, "refused");
});

test("the watchdog pauses a runaway plugin, keeps it from restarting, and Resume lets it run again", async () => {
  await enable(LONER);
  await activated("loner");
  const now = 1_000_000;
  for (let i = 0; i < (WATCHDOG.ipcPerSecond + 5) * WATCHDOG.ipcSeconds; i++) noteRequest("loner", consentToken(), now + Math.floor(i / (WATCHDOG.ipcPerSecond + 5)) * 1000);
  assert.equal(pausedReason("loner"), "ipc");
  await settle();
  assert.notEqual(P().processes.loner?.state, "running");
  await assert.rejects(ensurePluginActivated("loner", "test"), /paused/);
  assert.equal(usePluginHealth.getState().rows.loner.status, "paused");
  resumePlugin("loner");
  assert.equal(pausedReason("loner"), null);
  await settledStops();
  await activated("loner");
  const run = P().processes.loner.run;
  checkUsage([{ name: "loner", run, memoryBytes: 999 * 1024 * 1024, cpuMs: 0, streams: 0, sockets: 0 }], consentToken(), now);
  assert.equal(pausedReason("loner"), "memory");
  resumePlugin("loner");
});

test("an on-demand plugin sleeps after its idle time and wakes on its next use", async () => {
  await enable(LONER);
  await activated("loner");
  const since = P().processes.loner.since;
  checkIdle(consentToken(), since + 10_000);
  assert.equal(P().processes.loner.state, "running", "too soon");
  checkIdle(consentToken(), since + 301_000, [{ name: "loner", run: P().processes.loner.run, memoryBytes: 1, cpuMs: 0, streams: 1, sockets: 0 }]);
  assert.equal(P().processes.loner.state, "running", "an open stream keeps it awake");
  checkIdle(consentToken(), since + 301_000);
  await settle();
  assert.equal(P().processes.loner, undefined);
  assert.equal(takePluginCounts().plugin_idle_sleeps, 1);
  await settledStops();
  await activated("loner");
});

test("content scripts and page styles match both their own patterns and permissions.pages, and their bridge refuses tabs without them", async () => {
  await enable(PAGES);
  const m = P().listings.pages.manifest;
  assert.deepEqual(wantedFor(m, "https://github.com/a/b/pull/1").scripts.map((s) => s.id), ["badge"]);
  assert.deepEqual(wantedFor(m, "https://github.com/a/b").scripts, []);
  assert.deepEqual(wantedFor(m, "https://github.com/a/b").styles.map((s) => s.id), ["compact"]);
  assert.deepEqual(wantedFor(m, "https://gitlab.com/a").styles, []);
  assert.equal(postToContent("pages", "no-tab", { hi: 1 }), "That tab has none of this plugin's content scripts.");
  const before = host.events.length;
  receiveWorldMessage("no-tab", worldOf("pages"), "doc-1", JSON.stringify([JSON.stringify({ message: 1 })]), null);
  assert.equal(host.events.length, before, "a message from a tab without the plugin's world goes nowhere");
});

test("plugin worlds, local ports, input modes and the site kill switch parse only what they should", async () => {
  assert.equal(worldOf("pages"), "ardia-plugin:pages");
  assert.equal(worldOf("../x"), null);
  assert.equal(pluginOfWorld("ardia-plugin:pages"), "pages");
  assert.equal(pluginOfWorld("other:pages"), null);
  assert.deepEqual(worldMessagesOf(JSON.stringify([JSON.stringify({ doc: "dtoken1234", scriptId: "a", message: { x: 1 } }), { message: 2 }, "nope", 5])), [{ doc: "dtoken1234", scriptId: "a", message: { x: 1 } }, { doc: null, scriptId: null, message: 2 }]);
  assert.deepEqual(worldMessagesOf(JSON.stringify([{ message: "x".repeat(300 * 1024) }])), [], "an object-form message is held to the size cap by its serialized size");
  assert.deepEqual(worldMessagesOf("{not json"), []);
  assert.equal(hostPatternProblem("localhost:11434"), null);
  assert.ok(!reachesLoopback("localhost", 80, ["localhost"]), "a bare localhost never opens loopback");
  assert.notEqual(hostPatternProblem("10.0.0.1:80"), null);
  assert.deepEqual(loopbackPortsOf(["localhost:1", "127.0.0.1:65535", "localhost:0", "api.example.com"]), [1, 65535]);
  assert.ok(reachesLoopback("127.0.0.1", 11434, ["localhost:11434"]));
  assert.ok(!reachesLoopback("localhost", 11435, ["localhost:11434"]));
  assert.deepEqual(parseInputUrl(inputUrl("asker", "ask", "what is @tab about?")), { plugin: "asker", mode: "ask", query: "what is @tab about?" });
  assert.equal(parseInputUrl("ardia-input:../x?q=1"), null);
  await enable(CONSUMER);
  assert.deepEqual(inputModesOf("asker", P().listings.asker.manifest).map((m) => [m.id, m.keyword, m.command]), [["ask", "ai", "ask"]]);
  assert.deepEqual(parseSiteScriptBlocks(siteScriptBlocksJson({ "https://bank.example": true })), { "https://bank.example": true });
  assert.deepEqual(parseSiteScriptBlocks(JSON.stringify({ version: 1, sites: ["javascript:alert(1)", "https://ok.example", "https://ok.example/path"] })), { "https://ok.example": true });
});
