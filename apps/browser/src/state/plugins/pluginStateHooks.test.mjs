import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const stub = await import("../../test-native/index.ts");
const { requireNativeModule } = await import("../../test-native/expo.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated } = await import("./activation.ts");
const { settledStops } = await import("./process.ts");
const { flushStateEvents, stateSubscriberCount } = await import("./stateEvents.ts");
const { packFrames, takeRound, wireLine, STATE_EVENT_BUDGET_BYTES, STATE_ROUND_BYTES } = await import("./stateEventPacking.ts");
const NATIVE_LINE_CAP = 262144;
const DROP_MARKER = (n) => `"dropped":${n},`.length;
const wireBytes = (line) => new TextEncoder().encode(line).length + 1;
const { HOSTILE_STRINGS, HOSTILE_VALUES } = await import("../../../../../scripts/security/hostile-inputs.mjs");
const { showDownloadProgress } = await import("../downloads/progress.ts");
const { reportPageCommits } = await import("../../platform/tabs.ts");
const { notePluginStateCommit } = await import("./stateCommits.ts");
const { consentLines } = await import("./consent.ts");
const { redactedDownloads, pluginStateUrl } = await import("./pluginEventRedaction.ts");
const { readManifest } = await import("../../lib/pluginManifest.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-state-hooks-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const native = requireNativeModule("ArdiaPlugins");
const nativeEvent = native.event;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
let nextId = 0;

const ALL_TOPICS = ["tabs", "workspace", "navigation", "downloads"];
const ALL_INTENTS = ["tabs.group", "tabs.ungroup", "tabs.move", "tabs.pin", "tabs.unpin", "tabs.mute", "tabs.unmute", "tabs.activate", "groups.update"];

const plugin = (name, permissions) => ({ manifest: 2, name, title: name, main: "index.js", permissions, contributes: { commands: [{ name: "go", title: "Go" }] } });
const WATCHER = plugin("watcher", { tabs: "read", state: { events: ALL_TOPICS } });
const FULL = plugin("full", { tabs: "read", fullUrls: true, state: { events: ["tabs", "navigation", "downloads"] } });
const DOWNLOADS_ONLY = plugin("fetcher", { state: { events: ["downloads"] } });
const ACTOR = plugin("actor", { tabs: "write", state: { intents: ALL_INTENTS } });
const NARROW = plugin("narrow", { tabs: "write", state: { events: ["tabs"], intents: ["tabs.pin"] } });
const PLAIN = plugin("plain", { tabs: "write" });

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const key of ["starts", "stops", "replies", "events"]) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: JSON.stringify(doc) }));
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
  await settle();
  const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.ok(reply, `a reply to ${method}`);
  return reply;
}

async function activated(name) {
  const waiting = ensurePluginActivated(name, "test");
  await settle();
  const run = P().processes[name].run;
  assert.deepEqual((await ask(name, "ready", {}, run)).result, { ok: true });
  assert.equal(await waiting, run);
  return run;
}

const stateEvents = (name, topic) =>
  host.events
    .filter((e) => e.name === name)
    .map((e) => JSON.parse(e.line))
    .filter((e) => e.event === `state.${topic}`)
    .map((e) => e.data);

async function subscribed(doc, topics, setup = () => {}) {
  await enable(doc);
  setup();
  const run = await activated(doc.name);
  assert.deepEqual((await ask(doc.name, "state.subscribe", { topics }, run)).result, { ok: true, topics });
  flushStateEvents();
  return run;
}

beforeEach(() => takePluginCounts());
afterEach(() => {
  native.event = nativeEvent;
});

const download = (fields) => ({ url: "https://files.example/a.zip?token=s3cret#x", filename: "a.zip", path: "/Users/me/Downloads/a.zip", state: "downloading", paused: false, received: 1, total: 10, speed: 0, mimeType: "application/zip", profile: "", startTime: 1, ...fields });

test("the manifest gates every topic and intent, and needs tabs for tab topics and tabs: write for intents", () => {
  const problems = (permissions) => readManifest(JSON.stringify(plugin("p", permissions))).problems;
  assert.deepEqual(problems({ tabs: "read", state: { events: ["tabs"] } }), []);
  assert.deepEqual(problems({ state: { events: ["downloads"] } }), []);
  assert.match(problems({ state: { events: ["tabs"] } }).join("\n"), /state\.events: tabs needs tabs/);
  assert.match(problems({ state: { events: ["navigation"] } }).join("\n"), /navigation needs tabs/);
  assert.match(problems({ tabs: "read", state: { intents: ["tabs.pin"] } }).join("\n"), /intents need tabs: write/);
  for (const name of ["plugins.json", "consent.approve", "secrets.set", "permissions.grant", "settings.update", "profiles.update", "updates.pin", "keychain.write", "__proto__", "constructor"]) {
    assert.match(problems({ tabs: "write", state: { intents: [name] } }).join("\n"), /state\.intents\[0\] must be one of/, name);
    assert.match(problems({ tabs: "read", state: { events: [name] } }).join("\n"), /state\.events\[0\] must be one of/, name);
  }
  assert.match(problems({ tabs: "write", state: { intents: ["tabs.pin"], writes: ["plugins"] } }).join("\n"), /writes/);
  assert.match(problems({ tabs: "write", state: true }).join("\n"), /permissions\.state must be an object/);
});

test("the consent sheet names what a plugin hears and which changes it may make", () => {
  const lines = (doc) => consentLines(readManifest(JSON.stringify(doc)).manifest).map((l) => l.text).join("\n");
  assert.match(lines(WATCHER), /Hears when your tabs change, when your windows and groups change, when a tab goes to a new page, when a download starts/);
  assert.match(lines(WATCHER), /Never private windows, private downloads or where a file was saved/);
  assert.match(lines(ACTOR), /Can group tabs, ungroup tabs, move tabs, pin tabs/);
  assert.doesNotMatch(lines(PLAIN), /Hears when|Can group/);
});

test("an unpermitted subscription is refused whole and subscribes to nothing", async () => {
  await enable(NARROW);
  const run = await activated("narrow");
  const refused = await ask("narrow", "state.subscribe", { topics: ["tabs", "navigation"] }, run);
  assert.equal(refused.error.code, "refused");
  assert.match(refused.error.message, /navigation/);
  assert.equal(stateSubscriberCount(), 0);
  assert.equal((await ask("narrow", "state.subscribe", { topics: ["plugins"] }, run)).error.code, "bad_request");
  assert.equal((await ask("narrow", "state.subscribe", { topics: "tabs" }, run)).error.code, "bad_request");
  assert.equal((await ask("narrow", "state.subscribe", { topics: ["tabs"], fullUrls: true }, run)).error.code, "bad_request");
  assert.equal(takePluginCounts().plugin_state_subscribe_refusals, 1);
  await enable(PLAIN);
  const plainRun = await activated("plain");
  assert.equal((await ask("plain", "state.subscribe", { topics: ["tabs"] }, plainRun)).error.code, "refused");
  assert.equal((await ask("plain", "state.intent", { intent: "tabs.pin", args: { tabs: ["x"] } }, plainRun)).error.code, "refused");
});

test("tab events leave out private windows, incognito tabs, file and internal pages, queries and credentials", async () => {
  await enable(WATCHER);
  const w = S().createWindow({ url: "https://bank.example/statement?account=42#row" });
  const local = S().newTab(w, { url: "file:///Users/me/secret-plan.txt" });
  const settings = S().newTab(w, { url: "ardia://history" });
  const creds = S().newTab(w, { url: "https://user:hunter2@login.example/" });
  const blank = S().newTab(w, { url: "about:blank" });
  const priv = S().createWindow({ kind: "private", url: "https://private.example/?q=hidden" });
  const run = await activated("watcher");
  assert.deepEqual((await ask("watcher", "state.subscribe", { topics: ["tabs"] }, run)).result, { ok: true, topics: ["tabs"] });
  flushStateEvents();
  const [first, ...rest] = stateEvents("watcher", "tabs");
  assert.equal(rest.length, 0);
  assert.equal(first.initial, true);
  const shown = JSON.stringify(first);
  for (const secret of ["account=42", "#row", "secret-plan", "file:", "ardia://", "hunter2", "user:", "private.example", "hidden", "about:blank"]) assert.ok(!shown.includes(secret), secret);
  assert.ok(first.tabs.every((t) => t.windowId === w), "no private window's tabs");
  assert.ok(!first.tabs.some((t) => S().tabs[t.id]?.windowId === priv));
  const byId = Object.fromEntries(first.tabs.map((t) => [t.id, t]));
  assert.equal(byId[local].url, null);
  assert.equal(byId[local].title, null);
  assert.equal(byId[settings].url, null);
  assert.equal(byId[creds].url, null);
  assert.equal(byId[blank].url, null);
  assert.equal(first.tabs.find((t) => t.url?.startsWith("https://bank.example")).url, "https://bank.example/statement");
});

test("with fullUrls a tab's address keeps its query but never its fragment or a query that looks like a secret", async () => {
  await enable(FULL);
  const w = S().createWindow({ url: "https://news.example/a?page=2#top" });
  S().newTab(w, { url: "https://api.example/cb?access_token=abc&x=1" });
  const run = await activated("full");
  await ask("full", "state.subscribe", { topics: ["tabs"] }, run);
  flushStateEvents();
  const urls = stateEvents("full", "tabs")[0].tabs.map((t) => t.url).sort();
  assert.deepEqual(urls, ["https://api.example/cb", "https://news.example/a?page=2"]);
});

test("events arrive after the commit, coalesced, as diffs: one change, one small event", async () => {
  let w;
  const run = await subscribed(WATCHER, ["tabs", "navigation", "workspace"], () => (w = S().createWindow({ url: "https://a.example/" })));
  host.events.length = 0;
  const before = host.events.length;
  const tab = S().newTab(w, { url: "https://b.example/one" });
  for (let i = 0; i < 50; i++) S().updateTab(tab, { url: `https://b.example/page${i}?secret=${i}` });
  assert.equal(host.events.length, before, "nothing is sent inside the commit");
  flushStateEvents();
  const tabs = stateEvents("watcher", "tabs");
  assert.equal(tabs.length, 1, "fifty commits coalesce into one event");
  const changed = Object.fromEntries(tabs[0].tabs.map((t) => [t.id, t]));
  assert.equal(changed[tab].url, "https://b.example/page49");
  assert.deepEqual(Object.keys(changed).sort(), [tab, ...Object.keys(changed).filter((id) => id !== tab)].sort());
  assert.ok(Object.values(changed).every((t) => t.id === tab || t.active === false), "only the new tab, and the one it took over from");
  assert.equal(tabs[0].initial, undefined);
  assert.deepEqual(stateEvents("watcher", "navigation"), [], "an address written to the store isn't a commit");
  assert.ok(!JSON.stringify(host.events).includes("secret="));
  host.events.length = 0;
  S().closeTab(tab);
  flushStateEvents();
  const closed = stateEvents("watcher", "tabs")[0];
  assert.deepEqual(closed.removed, [tab]);
  assert.ok(closed.tabs.every((t) => t.id !== tab));
  host.events.length = 0;
  flushStateEvents();
  assert.equal(host.events.length, 0, "no change, no event");
  assert.equal((await ask("watcher", "state.subscribe", { topics: [] }, run)).result.ok, true);
  assert.equal(stateSubscriberCount(), 0);
});

test("navigation comes from the engine's commits: a pending address never emits, a same-address commit does", async () => {
  let w, priv;
  await subscribed(WATCHER, ["navigation"], () => {
    w = S().createWindow({ url: "https://a.example/" });
    priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  });
  host.events.length = 0;
  const tab = activeTabId(S(), w);
  const at = Date.now() + 1000;
  S().navigate(tab, "https://pending.example/typed");
  S().updateTab(tab, { url: "https://pending.example/written" });
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation"), [], "a navigation that hasn't committed is never reported");
  notePluginStateCommit(tab, "https://a.example/", at);
  flushStateEvents();
  notePluginStateCommit(tab, "https://a.example/", at + 1);
  flushStateEvents();
  notePluginStateCommit(tab, "https://a.example/", at + 1);
  flushStateEvents();
  notePluginStateCommit(tab, "https://a.example/#part", at + 1);
  flushStateEvents();
  const commits = stateEvents("watcher", "navigation").flatMap((e) => e.commits);
  assert.deepEqual(commits.map((c) => [c.tabId, c.url, c.sameDocument]), [
    [tab, "https://a.example/", false],
    [tab, "https://a.example/", false],
    [tab, "https://a.example/", true],
  ], "a reload of the same address is a commit; a repeated report isn't");
  host.events.length = 0;
  notePluginStateCommit(tab, "file:///etc/passwd", at + 2);
  notePluginStateCommit(tab, "ardia://downloads", at + 3);
  notePluginStateCommit(tab, "https://user:pw@login.example/", at + 4);
  notePluginStateCommit(activeTabId(S(), priv), "https://p.example/secret", at + 5);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation"), [], "no file, internal, credentialed or private commit");
  notePluginStateCommit(tab, "https://b.example/1", at + 6);
  notePluginStateCommit(tab, "https://b.example/2", at + 7);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation").flatMap((e) => e.commits).map((c) => c.url), ["https://b.example/2"], "commits coalesce per tab");
});

test("download events leave out private downloads, where files were saved, and addresses the plugin can't see", async () => {
  const seed = () => {
    const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
    S().upsertDownload(download({ id: "d1" }));
    S().upsertDownload(download({ id: "d2", offTheRecord: true, profile: S().windows[priv].profileId, filename: "private-thing.zip" }));
  };
  await subscribed(DOWNLOADS_ONLY, ["downloads"], seed);
  const [event] = stateEvents("fetcher", "downloads");
  assert.equal(event.initial, true);
  assert.deepEqual(event.downloads.map((d) => d.id), ["d1"]);
  assert.equal(event.downloads[0].url, null, "no tabs permission, no address");
  assert.equal(event.downloads[0].filename, "a.zip");
  const text = JSON.stringify(event);
  for (const secret of ["/Users/me", "Downloads/", "private-thing", "s3cret", "files.example"]) assert.ok(!text.includes(secret), secret);
  host.events.length = 0;
  S().upsertDownload(download({ id: "d1", state: "finished", received: 10 }));
  flushStateEvents();
  assert.deepEqual(stateEvents("fetcher", "downloads").map((e) => e.downloads.map((d) => [d.id, d.state])), [[["d1", "finished"]]]);
  const hidden = redactedDownloads({ ...S(), downloads: [download({ id: "p1", offTheRecord: true, profile: "x" }), download({ id: "p2", profile: "incognito:1@default" })] }, { full: true, urls: true });
  assert.deepEqual(hidden, []);
  await subscribed(FULL, ["downloads"], seed);
  const [full] = stateEvents("full", "downloads");
  assert.equal(full.downloads.find((d) => d.id === "d1").url, "https://files.example/a.zip");
});

test("workspace events list eligible windows and groups only", async () => {
  await enable(ACTOR, WATCHER);
  const w = S().createWindow({ url: "https://a.example/" });
  const b = S().newTab(w, { url: "https://b.example/" });
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const actor = await activated("actor");
  const watcher = await activated("watcher");
  await ask("watcher", "state.subscribe", { topics: ["workspace"] }, watcher);
  flushStateEvents();
  const [first] = stateEvents("watcher", "workspace");
  assert.equal(first.initial, true);
  assert.ok(first.windows.some((x) => x.id === w));
  assert.ok(!first.windows.some((x) => x.id === priv));
  host.events.length = 0;
  const grouped = await ask("actor", "state.intent", { intent: "tabs.group", args: { tabs: [b], name: "Reading", color: "blue" } }, actor);
  assert.equal(grouped.result.ok, true);
  flushStateEvents();
  const [change] = stateEvents("watcher", "workspace");
  assert.deepEqual(change.groups.map((g) => [g.id, g.name, g.color, g.tabIds]), [[grouped.result.group, "Reading", "blue", [b]]]);
});

test("intents change tabs through Ardia's own operations, in normal windows only", async () => {
  await enable(ACTOR);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const b = S().newTab(w, { url: "https://b.example/" });
  const c = S().newTab(w, { url: "https://c.example/" });
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const privTab = activeTabId(S(), priv);
  const run = await activated("actor");
  const intent = (name, args) => ask("actor", "state.intent", { intent: name, args }, run);
  const grouped = await intent("tabs.group", { tabs: [a, b], name: "Pair" });
  assert.equal(grouped.result.ok, true);
  const group = grouped.result.group;
  assert.deepEqual(S().groups[group].tabIds.slice().sort(), [a, b].sort());
  assert.equal((await intent("groups.update", { group, name: "Renamed", collapsed: true })).result.ok, true);
  assert.equal(S().groups[group].name, "Renamed");
  assert.equal((await intent("tabs.pin", { tabs: [c] })).result.ok, true);
  assert.notEqual(S().tabs[c].pin, null);
  assert.equal((await intent("tabs.unpin", { tabs: [c] })).result.ok, true);
  assert.equal((await intent("tabs.mute", { tabs: [c] })).result.ok, true);
  assert.equal(S().tabs[c].muted, true);
  assert.equal((await intent("tabs.move", { tabs: [c], before: a })).result.ok, true);
  assert.equal((await intent("tabs.ungroup", { group })).result.ok, true);
  assert.equal(S().groups[group], undefined);
  for (const [name, args] of [
    ["tabs.pin", { tabs: [privTab] }],
    ["tabs.mute", { tabs: [privTab] }],
    ["tabs.group", { tabs: [a, privTab] }],
    ["tabs.move", { tabs: [a], window: priv }],
    ["tabs.move", { tabs: [privTab], window: w }],
    ["tabs.activate", { tab: privTab }],
  ]) {
    const reply = await intent(name, args);
    assert.equal(reply.error.code, "refused", `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(S().tabs[privTab].pin, null);
  assert.equal(S().tabs[privTab].muted, false);
  assert.equal(S().tabs[privTab].windowId, priv);
  const counts = takePluginCounts();
  assert.equal(counts.plugin_state_intents, 7);
  assert.equal(counts.plugin_state_intent_refusals, 6);
});

test("no intent reaches a security-sensitive slice, whatever it is called or carries", async () => {
  await enable(ACTOR);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const run = await activated("actor");
  const recordsBefore = JSON.stringify(P().records);
  const settingsBefore = JSON.stringify(S().settings);
  const profilesBefore = JSON.stringify(S().profiles);
  const SENSITIVE = ["plugins.json", "plugins.enable", "plugins.approve", "consent.approve", "consent.grant", "permissions.grant", "permissions.set", "secrets.set", "keychain.set", "settings.update", "settings.set", "profiles.update", "profiles.create", "updates.pin", "official.pin", "workspace.apply", "apply", "__proto__", "constructor", "toString", "hasOwnProperty", "tabs.close", "tabs.open", "", null, 1, ["tabs.pin"], { intent: "tabs.pin" }];
  for (const intent of SENSITIVE) {
    const reply = await ask("actor", "state.intent", { intent, args: { tabs: [a], key: "approved", value: "*" } }, run);
    assert.equal(reply.error.code, "bad_request", JSON.stringify(intent));
  }
  for (const extra of ['"profile":"default"', '"urls":["https://evil.example/"]', '"approved":true', '"permissions":{"control":true}', '"__proto__":{"as":"tile"}', '"constructor":"x"', '"toString":"x"']) {
    const args = JSON.parse(`{"tabs":[${JSON.stringify(a)}],${extra}}`);
    assert.equal((await ask("actor", "state.intent", { intent: "tabs.pin", args }, run)).error.code, "bad_request", extra);
  }
  assert.equal((await ask("actor", "state.intent", { intent: "tabs.pin", args: { tabs: [a] }, profile: "default" }, run)).error.code, "bad_request");
  assert.equal(JSON.stringify(P().records), recordsBefore);
  assert.equal(JSON.stringify(S().settings), settingsBefore);
  assert.equal(JSON.stringify(S().profiles), profilesBefore);
  assert.equal(S().tabs[a].pin, null);
});

test("a plugin that lost an intent can't use it, and one granted only some intents gets only those", async () => {
  await enable(NARROW);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const run = await activated("narrow");
  assert.equal((await ask("narrow", "state.intent", { intent: "tabs.group", args: { tabs: [a] } }, run)).error.code, "refused");
  assert.equal((await ask("narrow", "state.intent", { intent: "tabs.pin", args: { tabs: [a] } }, run)).result.ok, true);
  lifecycle.disablePlugin("narrow", consentToken());
  await settledStops();
  const before = host.replies.length;
  stub.emitPluginLine({ name: "narrow", run, line: JSON.stringify({ id: ++nextId, method: "state.intent", params: { intent: "tabs.unpin", args: { tabs: [a] } } }) });
  await settle();
  assert.equal(host.replies.length, before, "a stopped run is not heard");
  assert.notEqual(S().tabs[a].pin, null);
});

test("a slow, hung or throwing plugin never blocks or breaks a commit", async () => {
  let w;
  await subscribed(WATCHER, ["tabs", "navigation", "workspace", "downloads"], () => (w = S().createWindow({ url: "https://a.example/" })));
  let sends = 0;
  native.event = () => {
    sends++;
    throw new Error("the plugin's channel is full");
  };
  const started = performance.now();
  const tabs = [];
  for (let i = 0; i < 200; i++) tabs.push(S().newTab(w, { url: `https://t${i}.example/` }));
  for (const id of tabs.slice(0, 100)) S().activate(id);
  const elapsed = performance.now() - started;
  assert.equal(sends, 0, "no plugin work runs inside a commit");
  assert.equal(tabs.every((id) => S().tabs[id]), true);
  assert.ok(elapsed < 5000, `commits stayed fast (${elapsed} ms)`);
  assert.doesNotThrow(() => flushStateEvents());
  assert.ok(sends > 0, "the flush ran and its failure was contained");
  native.event = nativeEvent;
  host.events.length = 0;
  S().closeTab(tabs[0]);
  flushStateEvents();
  const [resent] = stateEvents("watcher", "tabs");
  assert.ok(resent.tabs.length >= 199, "a failed send is sent again whole, not lost");
  assert.ok(takePluginCounts().plugin_state_events_dropped >= 1);
});

test("a big window arrives in parts sized by encoded bytes, and only the first is initial", async () => {
  const wide = "\u{1F600}".repeat(240);
  await subscribed(WATCHER, ["tabs"], () => {
    const w = S().createWindow({ url: "https://a.example/" });
    for (let i = 0; i < 600; i++) S().updateTab(S().newTab(w, { url: `https://n${i}.example/` }), { title: `${wide}${i}` });
  });
  const lines = host.events.filter((e) => e.name === "watcher" && JSON.parse(e.line).event === "state.tabs").map((e) => e.line);
  assert.ok(lines.length > 1, "split into parts");
  for (const line of lines) assert.ok(wireBytes(line) + DROP_MARKER(1e12) <= NATIVE_LINE_CAP, "each part, newline and a dropped marker included, fits the native cap");
  const parts = lines.map((l) => JSON.parse(l).data);
  assert.equal(parts[0].initial, true);
  assert.ok(parts.slice(1).every((p) => p.initial === undefined));
  assert.equal(parts.reduce((n, p) => n + p.tabs.length, 0), 601);
});

test("packFrames measures the whole wire line with room for more and a dropped marker, keeps every row, and sends nothing when nothing changed", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ key: `t${i}`, field: "tabs", value: { id: `t${i}`, title: "\u00e9".repeat(100) } }));
  const removed = [{ key: "\u0000removed:x", field: "removed", value: "x" }, { key: "\u0000removed:y", field: "removed", value: "y" }];
  const frames = packFrames("tabs", ["tabs", "removed"], [...rows, ...removed], { initial: true, budget: 2048 });
  assert.ok(frames.length > 1);
  for (const f of frames) {
    const worst = wireBytes(wireLine("tabs", 9_999_999_999_999, { ...f.data, more: true })) + DROP_MARKER(1e12);
    assert.ok(worst <= 2048, `${worst} bytes`);
    assert.ok(f.bytes <= 2048);
  }
  assert.deepEqual(frames.flatMap((f) => f.data.tabs).map((r) => r.id), rows.map((r) => r.key));
  assert.deepEqual(frames.flatMap((f) => f.data.removed), ["x", "y"]);
  assert.deepEqual(frames.flatMap((f) => f.completes), [...rows.map((r) => r.key), ...removed.map((r) => r.key)]);
  assert.equal(frames[0].data.initial, true);
  assert.deepEqual(packFrames("tabs", ["tabs", "removed"], [], { initial: false }), []);
  assert.deepEqual(packFrames("tabs", ["tabs", "removed"], [], { initial: true }).map((f) => f.data), [{ initial: true, tabs: [], removed: [] }]);
});

const hugeGroup = (count) => ({ id: "g1", windowId: "w1", name: "Huge", color: "blue", icon: null, collapsed: false, pinned: false, parentId: null, tabIds: Array.from({ length: count }, (_, i) => `tab-${"x".repeat(20)}-${i}`) });

test("a group with more tab ids than one event holds arrives in pages, each under the native cap even with a dropped marker", () => {
  const group = hugeGroup(30000);
  const frames = packFrames("workspace", ["windows", "groups", "removedWindows", "removedGroups"], [{ key: "g:g1", field: "groups", value: group }], { initial: true });
  assert.ok(frames.length > 1, "split");
  for (const f of frames) assert.ok(wireBytes(wireLine("workspace", 9_999_999_999_999, { ...f.data, more: true })) + DROP_MARKER(1e12) <= NATIVE_LINE_CAP);
  assert.ok(frames.every((f) => f.bytes <= STATE_EVENT_BUDGET_BYTES));
  const pages = frames.flatMap((f) => f.data.groups);
  assert.ok(pages.every((p, i) => p.id === "g1" && p.tabIdsPage.index === i && p.tabIdsPage.count === pages.length));
  assert.deepEqual(pages.flatMap((p) => p.tabIds), group.tabIds);
  assert.deepEqual(frames.flatMap((f) => f.completes), ["g:g1"], "the group counts as sent only with its last page");
  assert.equal(frames.at(-1).completes[0], "g:g1");
});

test("a multi-megabyte group goes out over rounds of at most 1 MB, pages split across rounds, with more on every round but the last", () => {
  const group = hugeGroup(200000);
  const frames = packFrames("workspace", ["windows", "groups", "removedWindows", "removedGroups"], [{ key: "g:g1", field: "groups", value: group }], { initial: true });
  const total = frames.reduce((n, f) => n + f.bytes, 0);
  assert.ok(total > 4 * 1024 * 1024, `${total} bytes: bigger than the native queue`);
  const outbox = [...frames];
  const rounds = [];
  while (outbox.length) rounds.push(takeRound(outbox));
  assert.ok(rounds.length >= 5);
  for (const round of rounds) assert.ok(round.reduce((n, r) => n + r.frame.bytes, 0) <= STATE_ROUND_BYTES, "each round fits its budget");
  rounds.forEach((round, i) => {
    assert.equal(round.at(-1).more, i < rounds.length - 1, `round ${i}`);
    assert.ok(round.slice(0, -1).every((r) => !r.more));
  });
  assert.deepEqual(rounds.flat().flatMap((r) => r.frame.data.groups).flatMap((p) => p.tabIds), group.tabIds);
});

test("a snapshot bigger than one flush's round goes out over several flushes, never all at once", async () => {
  const long = "a".repeat(8000);
  await subscribed(WATCHER, ["tabs"], () => {
    const w = S().createWindow({ url: "https://a.example/" });
    for (let i = 0; i < 200; i++) S().newTab(w, { url: `https://n${i}.example/${long}` });
  });
  const first = host.events.filter((e) => e.name === "watcher").map((e) => e.line);
  const firstBytes = first.reduce((n, line) => n + wireBytes(line), 0);
  assert.ok(firstBytes <= STATE_ROUND_BYTES, `${firstBytes} bytes in one flush`);
  const parts = first.map((l) => JSON.parse(l).data);
  assert.equal(parts[0].initial, true);
  assert.equal(parts.at(-1).more, true, "the last part says more follows");
  host.events.length = 0;
  flushStateEvents();
  const rest = stateEvents("watcher", "tabs");
  assert.ok(rest.length >= 1);
  assert.ok(rest.every((p) => p.initial === undefined));
  const ids = new Set([...parts, ...rest].flatMap((p) => p.tabs.map((t) => t.id)));
  assert.equal(ids.size, 201, "every tab arrives exactly once across the rounds");
  host.events.length = 0;
  flushStateEvents();
  assert.equal(host.events.length, 0, "nothing left once it's all out");
});

test("subscribing while a page is still loading never reports the older committed page as a new commit", async () => {
  let w;
  await subscribed(WATCHER, ["navigation"], () => (w = S().createWindow({ url: "https://old.example/" })));
  host.events.length = 0;
  const tab = activeTabId(S(), w);
  S().navigate(tab, "https://pending.example/");
  const committedBefore = Date.now() - 5000;
  notePluginStateCommit(tab, "https://old.example/", committedBefore);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation"), [], "the first report only sets the baseline");
  notePluginStateCommit(tab, "https://old.example/", committedBefore);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation"), []);
  notePluginStateCommit(tab, "https://pending.example/", Date.now() + 10);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation").flatMap((e) => e.commits).map((c) => [c.url, c.sameDocument]), [["https://pending.example/", false]]);
});

test("a pinned tab never moves to another window, even beside a pinned tab there", async () => {
  await enable(ACTOR);
  const w1 = S().createWindow({ url: "https://a.example/" });
  const p1 = S().newTab(w1, { url: "https://p1.example/" });
  S().pinTabs([p1], true, true);
  const w2 = S().createWindow({ url: "https://b.example/" });
  const p2 = S().newTab(w2, { url: "https://p2.example/" });
  S().pinTabs([p2], true, true);
  assert.equal(S().tabs[p1].profileId, S().tabs[p2].profileId, "same profile, so only the window differs");
  const run = await activated("actor");
  const reply = await ask("actor", "state.intent", { intent: "tabs.move", args: { tabs: [p1], before: p2 } }, run);
  assert.equal(reply.error?.code, "refused");
  assert.match(reply.error.message, /within their own window/);
  assert.equal(S().tabs[p1].windowId, w1);
  assert.notEqual(S().tabs[p1].pin, null);
  const p3 = S().newTab(w1, { url: "https://p3.example/" });
  S().pinTabs([p3], true, true);
  assert.equal((await ask("actor", "state.intent", { intent: "tabs.move", args: { tabs: [p1], before: p3 } }, run)).result?.ok, true, "within its own window it may move");
});

test("resync after the channel dropped events sends every subscribed topic whole again", async () => {
  let w;
  const run = await subscribed(WATCHER, ["tabs", "workspace"], () => (w = S().createWindow({ url: "https://a.example/" })));
  S().newTab(w, { url: "https://b.example/" });
  flushStateEvents();
  host.events.length = 0;
  flushStateEvents();
  assert.equal(host.events.length, 0);
  assert.deepEqual((await ask("watcher", "state.subscribe", { topics: ["tabs", "workspace"], resync: true }, run)).result, { ok: true, topics: ["tabs", "workspace"] });
  flushStateEvents();
  const tabs = stateEvents("watcher", "tabs");
  assert.equal(tabs[0].initial, true);
  assert.equal(tabs[0].tabs.length, 2);
  assert.equal(stateEvents("watcher", "workspace")[0].initial, true);
  assert.equal((await ask("watcher", "state.subscribe", { topics: ["tabs"], resync: "yes" }, run)).error.code, "bad_request");
  assert.equal(takePluginCounts().plugin_state_resyncs, 1);
});

test("focusing a private window never shows in a public window's focus", async () => {
  let a, b, priv;
  await subscribed(WATCHER, ["workspace"], () => {
    a = S().createWindow({ url: "https://a.example/" });
    b = S().createWindow({ url: "https://b.example/" });
    priv = S().createWindow({ kind: "private", url: "https://p.example/" });
    S().setFocusedWindow(a);
  });
  const focusedOf = (event) => Object.fromEntries(event.windows.map((x) => [x.id, x.focused]));
  assert.deepEqual(focusedOf(stateEvents("watcher", "workspace")[0]), { [a]: true, [b]: false });
  host.events.length = 0;
  S().setFocusedWindow(priv);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "workspace"), [], "nothing changes when a private window takes focus");
  S().setFocusedWindow(b);
  flushStateEvents();
  assert.deepEqual(focusedOf(stateEvents("watcher", "workspace")[0]), { [a]: false, [b]: true });
});

test("percent-encoded or malformed secret query names are cut from tabs, navigation and downloads", async () => {
  const urls = ["https://a.example/cb?%74oken=s3cret", "https://a.example/cb?%61pi_key=x", "https://a.example/cb?q=%E0%A4%A", "https://a.example/cb?%2574oken=y"];
  let w, tabs;
  await subscribed(FULL, ["tabs", "navigation", "downloads"], () => {
    w = S().createWindow({ url: "https://start.example/" });
    tabs = urls.map((url) => S().newTab(w, { url }));
    urls.forEach((url, i) => S().upsertDownload(download({ id: `enc${i}`, url })));
  });
  urls.forEach((url, i) => notePluginStateCommit(tabs[i], url, Date.now() + 1000 + i));
  flushStateEvents();
  const sent = JSON.stringify(host.events.filter((e) => e.name === "full").map((e) => JSON.parse(e.line)));
  for (const leak of ["s3cret", "%74oken", "%61pi_key", "%E0%A4%A", "%2574oken"]) assert.ok(!sent.includes(leak), leak);
  assert.ok(stateEvents("full", "tabs")[0].tabs.some((t) => t.url === "https://a.example/cb"));
  assert.ok(stateEvents("full", "navigation").flatMap((e) => e.commits).every((c) => c.url === "https://a.example/cb"));
  assert.ok(stateEvents("full", "downloads")[0].downloads.every((d) => d.url === "https://a.example/cb" || !d.id.startsWith("enc")));
});

test("tabs.mute and tabs.unmute change only the tab, never the muted sites in settings", async () => {
  await enable(ACTOR);
  const w = S().createWindow({ url: "https://loud.example/" });
  const loud = activeTabId(S(), w);
  const quiet = S().newTab(w, { url: "https://quiet.example/" });
  S().updateSettings({ mutedSites: ["loud.example"] });
  const run = await activated("actor");
  const sites = () => JSON.stringify(S().settings.mutedSites);
  const before = sites();
  const refused = await ask("actor", "state.intent", { intent: "tabs.unmute", args: { tabs: [loud] } }, run);
  assert.equal(refused.error.code, "refused");
  assert.match(refused.error.message, /muted in Ardia's settings/);
  assert.equal(sites(), before);
  assert.equal((await ask("actor", "state.intent", { intent: "tabs.mute", args: { tabs: [quiet, loud] } }, run)).result.ok, true);
  assert.equal(S().tabs[quiet].muted, true);
  assert.equal(sites(), before);
  assert.equal((await ask("actor", "state.intent", { intent: "tabs.unmute", args: { tabs: [quiet] } }, run)).result.ok, true);
  assert.equal(S().tabs[quiet].muted, false);
  assert.equal(sites(), before, "the synced muted sites never change");
  S().updateSettings({ mutedSites: [] });
});

test("tabs.move and tabs.group never change a tab's profile or whether it is pinned", async () => {
  await enable(ACTOR);
  const work = S().createProfile({ name: "Work" });
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const b = S().newTab(w, { url: "https://b.example/" });
  const pinned = S().newTab(w, { url: "https://pinned.example/" });
  S().pinTabs([pinned], true, true);
  const ww = S().createWindow({ url: "https://work.example/", profileId: work });
  const workTab = activeTabId(S(), ww);
  const run = await activated("actor");
  const intent = (name, args) => ask("actor", "state.intent", { intent: name, args }, run);
  const snapshot = () => JSON.stringify([a, b, pinned, workTab].map((id) => [S().tabs[id].profileId, S().tabs[id].windowId, S().tabs[id].pin]));
  const before = snapshot();
  for (const [name, args, why] of [
    ["tabs.move", { tabs: [a], before: workTab }, /another profile/],
    ["tabs.move", { tabs: [a], window: ww }, /another profile/],
    ["tabs.move", { tabs: [workTab], before: a }, /another profile/],
    ["tabs.move", { tabs: [a], before: pinned }, /pin or unpin/],
    ["tabs.move", { tabs: [pinned], before: b }, /pin or unpin/],
    ["tabs.move", { tabs: [pinned], group: null }, /pin or unpin/],
    ["tabs.group", { tabs: [a, workTab] }, /another window or profile/],
    ["tabs.group", { tabs: [a, pinned] }, /only unpinned/],
  ]) {
    const reply = await intent(name, args);
    assert.equal(reply.error?.code, "refused", `${name} ${JSON.stringify(args)}`);
    assert.match(reply.error.message, why);
    assert.equal(snapshot(), before, `${name} ${JSON.stringify(args)} changed nothing`);
  }
  assert.equal((await intent("tabs.move", { tabs: [b], before: a })).result.ok, true);
  assert.equal(S().tabs[b].pin, null);
  assert.equal(S().tabs[b].profileId, S().tabs[a].profileId);
});

test("resync can name just the topics to send whole again", async () => {
  let w;
  const run = await subscribed(WATCHER, ["tabs", "workspace"], () => (w = S().createWindow({ url: "https://a.example/" })));
  host.events.length = 0;
  assert.equal((await ask("watcher", "state.subscribe", { topics: ["tabs", "workspace"], resync: ["tabs"] }, run)).result.ok, true);
  flushStateEvents();
  assert.equal(stateEvents("watcher", "tabs")[0]?.initial, true);
  assert.deepEqual(stateEvents("watcher", "workspace"), [], "only the named topic");
  assert.equal((await ask("watcher", "state.subscribe", { topics: ["tabs"], resync: ["plugins"] }, run)).error.code, "bad_request");
  assert.ok(w);
});

test("an intent whose group is gone by the time it runs is refused, never matched to another group by name", async () => {
  await enable(ACTOR);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const b = S().newTab(w, { url: "https://b.example/" });
  const run = await activated("actor");
  const first = (await ask("actor", "state.intent", { intent: "tabs.group", args: { tabs: [a], name: "First" } }, run)).result.group;
  const second = (await ask("actor", "state.intent", { intent: "tabs.group", args: { tabs: [b], name: first } }, run)).result.group;
  assert.equal(S().groups[second].name, first, "a group named after the other's id");
  S().ungroup(first);
  assert.equal(S().groups[first], undefined);
  const reply = await ask("actor", "state.intent", { intent: "groups.update", args: { group: first, name: "Renamed" } }, run);
  assert.equal(reply.error?.code, "refused");
  assert.equal(S().groups[second].name, first, "the other group kept its name");
});

test("hostile text in an intent never reaches the store as anything but plain text, and plain text still applies", async () => {
  await enable(ACTOR);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const run = await activated("actor");
  const group = (await ask("actor", "state.intent", { intent: "tabs.group", args: { tabs: [a], name: "Start" } }, run)).result.group;
  const guarded = () => JSON.stringify([S().settings, S().profiles, P().records]);
  const before = guarded();
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;
  for (const { value } of HOSTILE_STRINGS) {
    for (const args of [{ group, name: value }, { group, icon: value }]) {
      const reply = await ask("actor", "state.intent", { intent: "groups.update", args }, run);
      const g = S().groups[group];
      assert.ok(g, "the group survives");
      assert.doesNotMatch(g.name, UNSAFE, JSON.stringify(value).slice(0, 80));
      assert.ok(g.name.length <= 200);
      if (reply.result) assert.ok(args.name === undefined || g.name === value.trim(), "what was accepted is what was stored");
    }
  }
  assert.equal(guarded(), before, "no setting, profile or plugin record changed");
  assert.equal((await ask("actor", "state.intent", { intent: "groups.update", args: { group, name: "Reading list" } }, run)).result.ok, true);
  assert.equal(S().groups[group].name, "Reading list", "a plain name applies");
});

test("a refused commit-report registration is tried again on the next delivery", async () => {
  let w;
  let from = 0;
  await subscribed(WATCHER, ["navigation"], () => {
    w = S().createWindow({ url: "https://a.example/" });
    from = stub.commitReports.length;
    stub.commitReportFailures.next = 1;
  });
  await settle();
  assert.equal(stub.commitReportFailures.next, 0, "the first registration was refused");
  S().newTab(w, { url: "https://b.example/" });
  flushStateEvents();
  await settle();
  const asked = stub.commitReports.slice(from).filter((on) => on === true).length;
  assert.ok(asked >= 2, `asked ${asked} times`);
  host.events.length = 0;
  notePluginStateCommit(activeTabId(S(), w), "https://c.example/", Date.now() + 1000);
  flushStateEvents();
  assert.equal(stateEvents("watcher", "navigation").flatMap((e) => e.commits).length, 1);
});

test("a navigation that happened while sharing was off is never counted in a later sharing period", async () => {
  let w;
  await subscribed(WATCHER, ["navigation"], () => (w = S().createWindow({ url: "https://a.example/" })));
  setConsentPeriod(false, "plugin-state-off");
  notePluginStateCommit(activeTabId(S(), w), "https://quiet.example/", Date.now() + 1000);
  setConsentPeriod(true, "plugin-state-back-on");
  takePluginCounts();
  host.events.length = 0;
  flushStateEvents();
  assert.equal(stateEvents("watcher", "navigation").length, 1, "the event itself still goes out");
  assert.equal(takePluginCounts().plugin_state_events, 0, "but it isn't counted in the new period");
  setConsentPeriod(true, "plugin-state-hooks-test");
});

test("a held snapshot still finishes with a part without more when its unsent rows disappear first", async () => {
  const long = "a".repeat(8000);
  let w, made;
  await subscribed(WATCHER, ["tabs"], () => {
    w = S().createWindow({ url: "https://a.example/" });
    made = Array.from({ length: 200 }, (_, i) => S().newTab(w, { url: `https://n${i}.example/${long}` }));
  });
  assert.equal(stateEvents("watcher", "tabs").at(-1).more, true);
  for (const id of made) S().closeTab(id);
  host.events.length = 0;
  for (let i = 0; i < 6 && !host.events.length; i++) flushStateEvents();
  const parts = stateEvents("watcher", "tabs");
  assert.ok(parts.length >= 1);
  assert.equal(parts.at(-1).more, undefined, "the round closes");
  host.events.length = 0;
  for (let i = 0; i < 6; i++) flushStateEvents();
  const after = stateEvents("watcher", "tabs");
  assert.deepEqual(new Set(after.flatMap((p) => p.removed)), new Set(made), "and the closed tabs are then removed");
});

test("navigation telemetry counts only frames holding a commit made while sharing was on", async () => {
  const long = "p".repeat(8000);
  let w, tabs;
  await subscribed(WATCHER, ["navigation"], () => {
    w = S().createWindow({ url: "https://a.example/" });
    tabs = Array.from({ length: 41 }, (_, i) => S().newTab(w, { url: `https://t${i}.example/` }));
  });
  host.events.length = 0;
  const at = Date.now() + 1000;
  setConsentPeriod(false, "plugin-state-off-40");
  for (let i = 0; i < 40; i++) notePluginStateCommit(tabs[i], `https://t${i}.example/${long}`, at + i);
  setConsentPeriod(true, "plugin-state-on-1");
  notePluginStateCommit(tabs[40], "https://t40.example/on", at + 100);
  takePluginCounts();
  flushStateEvents();
  const frames = stateEvents("watcher", "navigation");
  assert.ok(frames.length >= 2, `${frames.length} frames`);
  assert.equal(frames.flatMap((f) => f.commits).length, 41);
  const onlyOff = frames.filter((f) => !f.commits.some((c) => c.url === "https://t40.example/on")).length;
  assert.ok(onlyOff >= 1, "at least one frame holds only off-period commits");
  assert.equal(takePluginCounts().plugin_state_events, frames.length - onlyOff, "only frames with an in-period commit count");
  setConsentPeriod(true, "plugin-state-hooks-test");
});

test("a navigation subscriber never gets commits made before it joined", async () => {
  await enable(WATCHER, FULL);
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = activeTabId(S(), w);
  const watcher = await activated("watcher");
  const full = await activated("full");
  await ask("watcher", "state.subscribe", { topics: ["navigation"] }, watcher);
  notePluginStateCommit(tab, "https://before.example/", Date.now() + 1000);
  host.events.length = 0;
  await ask("full", "state.subscribe", { topics: ["navigation"] }, full);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation").flatMap((e) => e.commits).map((c) => c.url), ["https://before.example/"]);
  assert.deepEqual(stateEvents("full", "navigation"), [], "queued before it joined");
  host.events.length = 0;
  notePluginStateCommit(tab, "https://after.example/", Date.now() + 2000);
  flushStateEvents();
  assert.deepEqual(stateEvents("full", "navigation").flatMap((e) => e.commits).map((c) => c.url), ["https://after.example/"]);
  assert.deepEqual(stateEvents("watcher", "navigation").flatMap((e) => e.commits).map((c) => c.url), ["https://after.example/"]);
});

test("a refused commit-report registration is retried on a timer even with nothing else happening", async () => {
  let from = 0;
  await subscribed(WATCHER, ["navigation"], () => {
    S().createWindow({ url: "https://a.example/" });
    from = stub.commitReports.length;
    stub.commitReportFailures.next = 2;
  });
  await settle();
  const askedNow = () => stub.commitReports.slice(from).filter((on) => on === true).length;
  assert.equal(stub.commitReportFailures.next, 0, "both the registration and the delivery's retry were refused");
  const before = askedNow();
  const deadline = Date.now() + 3000;
  while (askedNow() <= before && Date.now() < deadline) await settle();
  assert.ok(askedNow() > before, `the timer asked again with nothing else happening: ${JSON.stringify(stub.commitReports.slice(from))}`);
});

test("hostile topics, resync values and request keys never change a subscription or send an event they don't allow", async () => {
  await enable(NARROW);
  const w = S().createWindow({ url: "https://a.example/" });
  const run = await activated("narrow");
  const subscribe = (params) => ask("narrow", "state.subscribe", params, run);
  for (const { value } of HOSTILE_VALUES) {
    for (const params of [{ topics: [value] }, { topics: value }, { topics: ["tabs"], resync: value }, { topics: ["tabs", value] }]) {
      const reply = await subscribe(params);
      const resyncOk = params.resync === undefined || typeof params.resync === "boolean" || (Array.isArray(params.resync) && params.resync.length <= ALL_TOPICS.length && params.resync.every((t) => ALL_TOPICS.includes(t)));
      const allowed = Array.isArray(params.topics) && params.topics.every((t) => t === "tabs") && resyncOk;
      if (allowed) {
        assert.ok(reply.result?.ok, JSON.stringify(params).slice(0, 120));
        assert.equal((await subscribe({ topics: [] })).result?.ok, true);
      } else assert.ok(reply.error, JSON.stringify(params).slice(0, 120));
      assert.equal(stateSubscriberCount(), 0, `nothing left subscribed by ${JSON.stringify(params).slice(0, 120)}`);
    }
    if (typeof value === "string" && value !== "topics" && value !== "resync") {
      const params = JSON.parse(`{"topics":["tabs"],${JSON.stringify(value)}:1}`);
      assert.equal((await subscribe(params)).error?.code, "bad_request", JSON.stringify(value).slice(0, 80));
      assert.equal(stateSubscriberCount(), 0);
    }
  }
  host.events.length = 0;
  flushStateEvents();
  assert.deepEqual(host.events.filter((e) => e.name === "narrow" && JSON.parse(e.line).event?.startsWith("state.")), [], "no event went out for a refused request");
  assert.deepEqual((await subscribe({ topics: ["tabs"] })).result, { ok: true, topics: ["tabs"] }, "a plain request still works");
  flushStateEvents();
  assert.equal(stateEvents("narrow", "tabs")[0]?.initial, true);
  assert.ok(w);
});

test("download progress reaches subscribers before the download finishes", async () => {
  await subscribed(DOWNLOADS_ONLY, ["downloads"], () => S().upsertDownload(download({ id: "live", received: 0, total: 0 })));
  host.events.length = 0;
  showDownloadProgress(download({ id: "live", received: 10, total: 100 }));
  flushStateEvents();
  assert.deepEqual(stateEvents("fetcher", "downloads").flatMap((e) => e.downloads).map((d) => [d.id, d.received, d.total]), [["live", 10, 100]]);
  host.events.length = 0;
  showDownloadProgress(download({ id: "live", received: 50, total: 100 }));
  flushStateEvents();
  assert.deepEqual(stateEvents("fetcher", "downloads").flatMap((e) => e.downloads).map((d) => [d.id, d.received, d.total]), [["live", 50, 100]]);
});

test("joining while another reader already has commit reports on keeps real baselines, so in-page changes still arrive", async () => {
  let w;
  await enable(WATCHER);
  w = S().createWindow({ url: "https://doc.example/page" });
  const tab = activeTabId(S(), w);
  await reportPageCommits("pageBars", true);
  const committed = Date.now() - 60_000;
  notePluginStateCommit(tab, "https://doc.example/page", committed);
  const run = await activated("watcher");
  await ask("watcher", "state.subscribe", { topics: ["navigation"] }, run);
  flushStateEvents();
  host.events.length = 0;
  notePluginStateCommit(tab, "https://doc.example/page#first", committed);
  flushStateEvents();
  notePluginStateCommit(tab, "https://doc.example/page#second", committed);
  flushStateEvents();
  notePluginStateCommit(tab, "https://doc.example/page#second", committed);
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation").flatMap((e) => e.commits).map((c) => [c.url, c.sameDocument]), [
    ["https://doc.example/page", true],
    ["https://doc.example/page", true],
  ], "both in-page changes arrive, fragments cut as always, and the repeat doesn't");
  await reportPageCommits("pageBars", false);
});

test("leaving and coming back while another reader keeps commit reports on still delivers the first in-page change", async () => {
  await enable(WATCHER);
  const w = S().createWindow({ url: "https://doc.example/page" });
  const tab = activeTabId(S(), w);
  await reportPageCommits("pageBars", true);
  const committed = Date.now() - 60_000;
  notePluginStateCommit(tab, "https://doc.example/page", committed);
  const run = await activated("watcher");
  assert.equal((await ask("watcher", "state.subscribe", { topics: ["navigation"] }, run)).result.ok, true);
  flushStateEvents();
  assert.equal((await ask("watcher", "state.subscribe", { topics: [] }, run)).result.ok, true);
  assert.equal(stateSubscriberCount(), 0);
  assert.equal((await ask("watcher", "state.subscribe", { topics: ["navigation"] }, run)).result.ok, true);
  flushStateEvents();
  host.events.length = 0;
  notePluginStateCommit(tab, "https://doc.example/page#first", committed);
  flushStateEvents();
  const commits = stateEvents("watcher", "navigation").flatMap((e) => e.commits);
  assert.equal(commits.length, 1, "the first in-page change after coming back arrives");
  assert.equal(commits[0].sameDocument, true);
  await reportPageCommits("pageBars", false);
});

test("subscriptions end with the run", async () => {
  await subscribed(WATCHER, ["tabs"]);
  assert.equal(stateSubscriberCount(), 1);
  lifecycle.disablePlugin("watcher", consentToken());
  await settledStops();
  assert.equal(stateSubscriberCount(), 0);
});
