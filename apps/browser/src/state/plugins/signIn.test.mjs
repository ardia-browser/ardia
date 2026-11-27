import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated } = await import("./activation.ts");
const { settledStops, restartProcess } = await import("./process.ts");
const { consentLines } = await import("./consent.ts");
const { updateWithin } = await import("./officialUpdate.ts");
const { readManifest } = await import("../../lib/pluginManifest.ts");
const { signInCallbackOf, signInRedirect, signInSessionCount, signInTimeoutOf, signInUrlOf, signInStateOf, SIGN_IN_LIMITS } = await import("./channelSignIn.ts");
const { isEligibleTab } = await import("../automation/automationWindows.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-sign-in-test");

const S = () => useBrowser.getState();
const show = (value) => {
  try {
    return JSON.stringify(value)?.slice(0, 120) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const native = stub.pluginSignIn;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
let nextId = 0;

const MAIL = { manifest: 2, name: "mail", title: "Mail", main: "dist/index.js", permissions: { signIn: true } };
const OTHER = { manifest: 2, name: "other", title: "Other", main: "dist/index.js", permissions: { signIn: true } };
const BARE = { manifest: 2, name: "bare", title: "Bare", main: "dist/index.js", permissions: {} };
const WATCHER = { manifest: 2, name: "watcher", title: "Watcher", main: "dist/index.js", permissions: { tabs: "write", fullUrls: true }, contributes: { hooks: ["tab.opened", "tab.navigated", "tab.activated", "tab.closed", "tab.opening"] } };
const CALLBACK = "http://127.0.0.1:53682/cb";
const STATE = "Zq81_mNw-4Lp0aXc";
const AUTH = `https://accounts.example/o/oauth2/auth?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcb&state=${STATE}`;
const START = { url: AUTH, callback: CALLBACK, state: STATE };
const REAL = `/cb?code=x&state=${STATE}`;

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const name of Object.keys(P().records)) lifecycle.updateRecord(name, () => null, consentToken());
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

const replyTo = (id) => host.replies.map((r) => JSON.parse(r.line)).find((r) => r.id === id);

function send(name, method, params, run) {
  const id = ++nextId;
  stub.emitPluginLine({ name, run, line: JSON.stringify({ id, method, params }) });
  return id;
}

async function ask(name, method, params, run) {
  const id = send(name, method, params, run);
  await settle();
  const reply = replyTo(id);
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

function windowWithPage() {
  const w = S().createWindow({ url: "ardia://mail" });
  const page = activeTabId(S(), w);
  return { w, page };
}

async function started(name = "mail", params = START) {
  const run = await activated(name);
  const before = Object.keys(S().tabs);
  const id = send(name, "signIn.start", params, run);
  await settle();
  const tabId = Object.keys(S().tabs).find((t) => !before.includes(t));
  return { run, id, tabId, listen: native.listens.at(-1) };
}

beforeEach(() => {
  native.reset();
  takePluginCounts();
});

test("start binds first, then opens the sign-in page in a new foreground tab of the frontmost normal window, in its profile", async () => {
  await enable(MAIL);
  const { w, page } = windowWithPage();
  const { id, tabId, listen } = await started();
  assert.ok(tabId, "a tab opened");
  assert.equal(S().tabs[tabId].windowId, w);
  assert.equal(S().tabs[tabId].profileId, S().windows[w].profileId);
  assert.equal(S().tabs[tabId].url, AUTH);
  assert.equal(activeTabId(S(), w), tabId);
  assert.deepEqual({ host: listen.host, port: listen.port, path: listen.path, state: listen.state }, { host: "127.0.0.1", port: 53682, path: "/cb", state: STATE });
  assert.equal(listen.deadlineMs, SIGN_IN_LIMITS.defaultTimeoutMs + SIGN_IN_LIMITS.nativeMarginMs, "native has its own deadline");
  assert.equal(replyTo(id), undefined);
  assert.notEqual(page, tabId);
  assert.equal(takePluginCounts().plugin_sign_in_started, 1);
});

test("the redirect with the session's state resolves the full URL, closes the tab and goes back to the page", async () => {
  await enable(MAIL);
  const { w, page } = windowWithPage();
  const { id, tabId, listen } = await started();
  native.emitCallback(listen.id, REAL);
  await settle();
  assert.deepEqual(replyTo(id).result, { url: `http://127.0.0.1:53682${REAL}` });
  assert.equal(S().tabs[tabId], undefined);
  assert.equal(activeTabId(S(), w), page);
  assert.ok(native.stops.includes(listen.id));
  assert.equal(signInSessionCount(), 0);
  assert.equal(takePluginCounts().plugin_sign_in_completed, 1);
});

test("a forged callback without the state, or for another path or session, is ignored and the real one still resolves", async () => {
  await enable(MAIL);
  windowWithPage();
  const { id, tabId, listen } = await started();
  for (const target of [`/cb?st%61te=evil&state=${STATE}`, `/cb?state=${STATE}&%73tate=${STATE}`, `/cb?st%ZZte=1&state=${STATE}`, "/cb?code=forged", `/cb?code=x&state=${STATE}x`, `/cb?state=${STATE}&state=${STATE}`, `/other?state=${STATE}`, `cb?state=${STATE}`, `/cb?code=x y&state=${STATE}`, `/cb?state=${STATE}#f`]) native.emitCallback(listen.id, target);
  native.emitCallback("s999999", REAL);
  await settle();
  assert.equal(replyTo(id), undefined);
  assert.ok(S().tabs[tabId], "the tab stays open");
  assert.equal(native.stops.includes(listen.id), false, "still listening");
  native.emitCallback(listen.id, REAL);
  await settle();
  assert.equal(replyTo(id).result.url, `http://127.0.0.1:53682${REAL}`);
});

test("the tab's own address never finishes a sign-in: only the listener does", async () => {
  await enable(MAIL);
  windowWithPage();
  const { id, tabId } = await started();
  S().updateTab(tabId, { url: `http://127.0.0.1:53682${REAL}` });
  await settle();
  assert.equal(replyTo(id), undefined);
});

test("a port another program holds is port_in_use, and no tab opens", async () => {
  await enable(MAIL);
  const { w } = windowWithPage();
  native.listenResult = { ok: false, code: "port_in_use", reason: "127.0.0.1:53682: Address already in use" };
  const before = S().windows[w].tabIds.length;
  const run = await activated("mail");
  const reply = await ask("mail", "signIn.start", START, run);
  assert.equal(reply.error.code, "port_in_use");
  assert.equal(S().windows[w].tabIds.length, before, "no tab opened");
  assert.equal(signInSessionCount(), 0);
  assert.equal(takePluginCounts().plugin_sign_in_port_in_use, 1);
});

test("two plugins can't share an endpoint; localhost overlaps 127.0.0.1; another port is fine", async () => {
  await enable(MAIL, OTHER);
  const { w } = windowWithPage();
  const first = await started();
  const run = await activated("other");
  const tabs = S().windows[w].tabIds.length;
  const listens = native.listens.length;
  for (const callback of [CALLBACK, "http://localhost:53682/x"]) assert.equal((await ask("other", "signIn.start", { ...START, callback }, run)).error.code, "port_in_use", callback);
  assert.equal(native.listens.length, listens, "nothing else listened");
  assert.equal(S().windows[w].tabIds.length, tabs, "no tab opened");
  const other = await started("other", { ...START, callback: "http://127.0.0.1:53683/cb" });
  assert.ok(other.tabId);
  native.emitCallback(other.listen.id, REAL);
  native.emitCallback(first.listen.id, REAL);
  await settle();
  assert.equal(replyTo(other.id).result.url, `http://127.0.0.1:53683${REAL}`);
  assert.equal(replyTo(first.id).result.url, `http://127.0.0.1:53682${REAL}`);
});

test("a callback that arrives while Ardia is still binding isn't lost: it finishes once the tab is registered", async () => {
  await enable(MAIL);
  const { w, page } = windowWithPage();
  let open;
  native.listenGate = new Promise((resolve) => (open = resolve));
  const run = await activated("mail");
  const id = send("mail", "signIn.start", START, run);
  await settle();
  const listen = native.listens.at(-1);
  native.emitCallback(listen.id, REAL);
  await settle();
  assert.equal(replyTo(id), undefined);
  open();
  await settle();
  assert.equal(replyTo(id).result.url, `http://127.0.0.1:53682${REAL}`);
  assert.equal(activeTabId(S(), w), page);
  assert.equal(Object.values(S().tabs).some((t) => t.url === AUTH), false, "the tab it opened is closed");
});

test("a plugin stopping while Ardia binds settles the start and stops the listener", async () => {
  await enable(MAIL);
  const { w } = windowWithPage();
  let open;
  native.listenGate = new Promise((resolve) => (open = resolve));
  const run = await activated("mail");
  const before = S().windows[w].tabIds.length;
  const id = send("mail", "signIn.start", START, run);
  await settle();
  const listen = native.listens.at(-1);
  restartProcess("mail");
  await settle();
  open();
  await settle();
  assert.ok(native.stops.includes(listen.id));
  assert.equal(S().windows[w].tabIds.length, before, "no tab opened");
  assert.equal(signInSessionCount(), 0);
  void id;
});

test("while it runs, the sign-in tab is hidden from every other plugin: lists, events and decide hooks", async () => {
  await enable(MAIL, WATCHER);
  windowWithPage();
  const watcher = await activated("watcher");
  await ask("watcher", "subscribe", { events: ["*"] }, watcher);
  const eventsBefore = host.events.length;
  const { tabId, listen } = await started();
  assert.equal(isEligibleTab(S(), tabId), false);
  S().updateTab(tabId, { url: `https://accounts.example/consent?state=${STATE}` });
  await settle();
  const windows = (await ask("watcher", "windows", {}, watcher)).result;
  assert.equal(windows.flatMap((x) => x.tabs).some((t) => t.id === tabId), false, "not in windows");
  const ws = await ask("watcher", "apply", { ops: [{ op: "tab.activate", tab: tabId }] }, watcher);
  assert.ok(ws.error || ws.result?.ok === false, `another plugin can't reach the tab: ${JSON.stringify(ws).slice(0, 200)}`);
  const leaked = host.events.slice(eventsBefore).filter((e) => e.name === "watcher" && (e.line.includes(STATE) || e.line.includes(tabId)));
  assert.deepEqual(leaked.map((e) => e.line.slice(0, 120)), [], "no event or decide call names it");
  native.emitCallback(listen.id, REAL);
  await settle();
  assert.equal(S().tabs[tabId], undefined);
});

test("workspace and apply never name the sign-in tab, not as the active tab, a group member or a split pane", async () => {
  await enable(MAIL, { ...WATCHER, permissions: { tabs: "write", fullUrls: true, workspace: true } });
  const { w, page } = windowWithPage();
  const watcher = await activated("watcher");
  const { tabId, listen } = await started();
  assert.equal(activeTabId(S(), w), tabId, "the sign-in tab is the active one");
  const names = (value) => JSON.stringify(value).includes(tabId);
  const ws = await ask("watcher", "workspace", {}, watcher);
  assert.equal(names(ws.result), false, `workspace: ${JSON.stringify(ws.result).slice(0, 300)}`);
  const group = S().createGroup([page, tabId], { name: "Team" });
  const applied = await ask("watcher", "apply", { ops: [{ op: "group.update", group, name: "Renamed" }] }, watcher);
  assert.ok(applied.result, JSON.stringify(applied).slice(0, 200));
  assert.equal(names(applied.result), false, `apply: ${JSON.stringify(applied.result).slice(0, 300)}`);
  assert.equal(names((await ask("watcher", "workspace", {}, watcher)).result), false, "workspace with it in a group");
  native.emitCallback(listen.id, REAL);
  await settle();
});

test("apply never names the sign-in tab: ungrouping a mixed group, moving a tab out of a mixed split", async () => {
  await enable(MAIL, { ...WATCHER, permissions: { tabs: "write", fullUrls: true, workspace: true } });
  const { w, page } = windowWithPage();
  const watcher = await activated("watcher");
  const plain = S().newTab(w, { url: "https://plain.example/" });
  const { tabId, listen } = await started();
  const names = (value) => JSON.stringify(value).includes(tabId);
  const group = S().createGroup([plain, tabId], { name: "Mixed" });
  const ungrouped = await ask("watcher", "apply", { ops: [{ op: "group.ungroup", group }] }, watcher);
  assert.equal(names(ungrouped), false, `ungroup: ${JSON.stringify(ungrouped).slice(0, 400)}`);
  const split = S().createSplit([plain, tabId]);
  assert.ok(split, "a real split holds both");
  const moved = await ask("watcher", "apply", { ops: [{ op: "tab.move", tabs: [plain], window: w }] }, watcher);
  assert.equal(names(moved), false, `move: ${JSON.stringify(moved).slice(0, 400)}`);
  assert.match(moved.result.error.message, /A tab in a split with the tabs named is one the ardia command can't use/);
  const closed = await ask("watcher", "apply", { ops: [{ op: "tab.close", tabs: [plain] }] }, watcher);
  assert.equal(names(closed), false, `close: ${JSON.stringify(closed).slice(0, 400)}`);
  assert.equal(names((await ask("watcher", "workspace", {}, watcher)).result), false);
  void page;
  native.emitCallback(listen.id, REAL);
  await settle();
});

test("hooks.json and plugin decide hooks never hear from the sign-in tab: links it opens and permissions it asks keep the browser's default", async () => {
  const { startAutomation } = await import("../automation/controlSocket.ts");
  const { reloadHooks } = await import("../automation/hookRules.ts");
  const { openFromPage } = await import("../tabs/openFromPage.ts");
  const { permissionGate } = await import("../site/permissionGate.ts");
  await enable(MAIL);
  S().updateSettings({ cliControl: true });
  startAutomation();
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks: [
    { name: "block", on: "tab.opening", match: "https://blocked.example/*", cancel: true },
    { name: "deny", on: "permission.requested", match: "https://cam.example/*", permission: "deny" },
  ] }));
  reloadHooks();
  await settle();
  const { w } = windowWithPage();
  const plain = S().newTab(w, { url: "https://plain.example/" });
  const { tabId, listen } = await started();
  const from = (id) => ({ windowId: w, profileId: S().windows[w].profileId, tabId: id });
  const count = () => Object.keys(S().tabs).length;
  let before = count();
  openFromPage({ url: "https://blocked.example/x", disposition: "background" }, from(plain));
  assert.equal(count(), before, "control: the rule cancels a link from a normal tab");
  before = count();
  openFromPage({ url: "https://blocked.example/x", disposition: "background" }, from(tabId));
  await settle();
  assert.equal(count(), before + 1, "a link from the sign-in tab opens as the browser would, no hook asked");
  const ask = (id) => permissionGate()({ tabId: id, origin: "https://cam.example", permissions: ["camera"] }, new AbortController().signal);
  assert.equal(await ask(plain), "deny", "control: the rule denies for a normal tab");
  assert.equal(await ask(tabId), "ask", "the sign-in tab gets the browser's own prompt");
  stub.configFolder.files.delete("hooks.json");
  reloadHooks();
  native.emitCallback(listen.id, REAL);
  await settle();
});

test("the authorization URL never reaches History, the address bar's source or ⌘⇧T, and the engine's copy is deleted", async () => {
  const { startHistory, reloadHistory } = await import("../history/engineSync.ts");
  const { historyOf } = await import("../history/history.ts");
  const { queryHistory } = await import("../../platform/history.ts");
  const { engineProfile } = await import("../browser/model.ts");
  await enable(MAIL);
  const { w } = windowWithPage();
  stub.historyDbs.clear();
  const stopHistory = startHistory();
  await reloadHistory();
  const engine = engineProfile(S(), S().windows[w].profileId);
  const db = stub.chromeHistory(engine);
  stub.chromeVisit(engine, "https://news.example/", "News");
  const { id, tabId, listen } = await started();
  const hop = `https://accounts.example/signin?continue=${encodeURIComponent(AUTH)}`;
  stub.chromeVisit(engine, AUTH, "Sign in");
  stub.chromeVisit(engine, hop, "Sign in");
  await settle();
  const urls = () => historyOf(S(), S().windows[w].profileId).map((e) => e.url);
  assert.ok(urls().includes("https://news.example/"), "control: ordinary visits still arrive");
  assert.equal(urls().some((u) => u.includes(STATE)), false, "not in Ardia's History, which the address bar reads");
  assert.equal((await queryHistory(engine, 5000, 1)).some((e) => e.url.includes(STATE)), false, "not in an engine query (history.search)");
  assert.equal([...db.keys()].some((u) => u.includes(STATE)), false, "deleted from the engine's history");
  db.set(`https://accounts.example/late?state=${STATE}`, { title: "", visits: [Date.now()] });
  S().closeTabs([tabId]);
  await settle();
  assert.equal(replyTo(id).error.code, "cancelled");
  assert.equal(JSON.stringify(S().closedTabs).includes(STATE), false, "⌘⇧T can't bring it back");
  assert.equal([...db.keys()].some((u) => u.includes(STATE)), false, "the sweep at the end deletes what the engine wrote late");
  void listen;
  stopHistory();
});

test("a finished sign-in closes its tab without a closed-tab record", async () => {
  await enable(MAIL);
  windowWithPage();
  const { tabId, listen } = await started();
  native.emitCallback(listen.id, REAL);
  await settle();
  assert.equal(S().tabs[tabId], undefined);
  assert.equal(JSON.stringify([S().closedTabs, S().closedWindows]).includes(STATE), false);
});

test("closing the sign-in tab cancels", async () => {
  await enable(MAIL);
  windowWithPage();
  const { id, tabId, listen } = await started();
  takePluginCounts();
  S().closeTabs([tabId]);
  await settle();
  assert.equal(replyTo(id).error.code, "cancelled");
  assert.ok(native.stops.includes(listen.id));
  assert.equal(takePluginCounts().plugin_sign_in_cancelled, 1);
});

test("when the person moved to another tab, finishing closes the sign-in tab without pulling them back", async () => {
  await enable(MAIL);
  const { w } = windowWithPage();
  const { id, tabId, listen } = await started();
  const elsewhere = S().newTab(w, { url: "https://news.example/" });
  S().activate(elsewhere);
  native.emitCallback(listen.id, REAL);
  await settle();
  assert.ok(replyTo(id).result.url);
  assert.equal(S().tabs[tabId], undefined);
  assert.equal(activeTabId(S(), w), elsewhere);
});

test("a second start from the same plugin cancels the first, closes its tab and can reuse its port", async () => {
  await enable(MAIL);
  windowWithPage();
  const first = await started();
  const second = await started();
  assert.equal(replyTo(first.id).error.code, "cancelled");
  assert.equal(S().tabs[first.tabId], undefined);
  assert.ok(S().tabs[second.tabId]);
  assert.ok(native.stops.indexOf(first.listen.id) >= 0);
  native.emitCallback(first.listen.id, REAL);
  await settle();
  assert.equal(replyTo(second.id), undefined, "the replaced listener's callback is ignored");
  native.emitCallback(second.listen.id, REAL);
  await settle();
  assert.ok(replyTo(second.id).result.url);
});

test("the plugin turning off cancels its sign-in and leaves the tab, visible again", async () => {
  await enable(MAIL);
  windowWithPage();
  const { tabId, listen } = await started();
  lifecycle.disablePlugin("mail", consentToken());
  await settledStops();
  await settle();
  assert.equal(signInSessionCount(), 0);
  assert.ok(native.stops.includes(listen.id));
  assert.ok(S().tabs[tabId]);
  assert.equal(isEligibleTab(S(), tabId), true);
});

test("timeoutMs ends the wait with timeout and leaves the tab", async (t) => {
  await enable(MAIL);
  windowWithPage();
  const run = await activated("mail");
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const before = Object.keys(S().tabs);
    const id = send("mail", "signIn.start", { ...START, timeoutMs: 1000 }, run);
    await flush();
    const tabId = Object.keys(S().tabs).find((tab) => !before.includes(tab));
    assert.equal(native.listens.at(-1).deadlineMs, 1000 + SIGN_IN_LIMITS.nativeMarginMs);
    t.mock.timers.tick(999);
    await flush();
    assert.equal(replyTo(id), undefined);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(replyTo(id).error.code, "timeout");
    assert.ok(native.stops.includes(native.listens.at(-1).id));
    assert.ok(S().tabs[tabId]);
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(takePluginCounts().plugin_sign_in_timeouts, 1);
});

test("refused without the permission, for a bad state, url or callback (%2e included), and bad_request for a bad timeout", async () => {
  await enable(MAIL, BARE);
  windowWithPage();
  const bare = await activated("bare");
  assert.equal((await ask("bare", "signIn.start", START, bare)).error.code, "refused");
  const run = await activated("mail");
  for (const state of [undefined, "short", "x".repeat(257), "Zq81_mNw-4Lp0aX.", 7]) assert.equal((await ask("mail", "signIn.start", { ...START, state }, run)).error.code, "refused", String(state));
  for (const url of ["https://accounts.example/o", `https://accounts.example/o?state=${STATE}x`, `https://accounts.example/o?state=${STATE}&state=${STATE}`, `https://accounts.example/o?st%61te=evil&state=${STATE}`, `https://accounts.example/o?state=${STATE}&%73tate=x`, `https://accounts.example/o#state=${STATE}`, `http://accounts.example/?state=${STATE}`, "javascript:alert(1)", `https://user:pw@accounts.example/?state=${STATE}`, `https://a.example/${"a".repeat(SIGN_IN_LIMITS.urlChars)}?state=${STATE}`, 7, null]) {
    assert.equal((await ask("mail", "signIn.start", { ...START, url }, run)).error.code, "refused", String(url).slice(0, 60));
  }
  for (const callback of ["http://127.0.0.1/cb", "http://127.0.0.1:80/cb", "http://127.0.0.1:65536/cb", "http://127.0.0.1:053682/cb", "https://127.0.0.1:53682/cb", "http://10.0.0.1:53682/cb", "http://0.0.0.0:53682/cb", "http://u@127.0.0.1:53682/cb", "http://127.0.0.1:53682/cb?x=1", "http://127.0.0.1:53682/cb#x", "http://127.0.0.1:53682/../cb", "http://127.0.0.1:53682/%2e%2e/cb", "http://127.0.0.1:53682/%63b", "http://127.0.0.1:53682/cb/", "http://127.0.0.1:53682//cb", "http://127.0.0.1:53682/a/./b", "HTTP://127.0.0.1:53682/cb", "http://127.0.0.1:53682/c b"]) {
    assert.equal((await ask("mail", "signIn.start", { ...START, callback }, run)).error.code, "refused", callback);
  }
  for (const timeoutMs of [0, -1, 1.5, "60000", 999]) assert.equal((await ask("mail", "signIn.start", { ...START, timeoutMs }, run)).error.code, "bad_request", String(timeoutMs));
  assert.equal(native.listens.length, 0, "nothing listened");
  assert.equal(signInSessionCount(), 0);
});

test("never in a private window: the sign-in goes to the frontmost normal window, or nowhere", async () => {
  await enable(MAIL);
  const normal = S().createWindow({ url: "https://a.example/" });
  const p = S().createWindow({ kind: "private", url: "https://secret.example/" });
  useBrowser.setState((s) => ({ ui: { ...s.ui, focusOrder: [p, normal] } }));
  const { tabId } = await started();
  assert.equal(S().tabs[tabId].windowId, normal);
  S().closeWindow(normal);
  await settle();
  const run = P().processes.mail.run;
  assert.equal((await ask("mail", "signIn.start", START, run)).error.code, "no_window");
  assert.equal(Object.values(S().tabs).filter((t) => t.windowId === p).length, 1);
});

test("the signIn permission is listed, on the consent sheet, and a change to it prompts an update", () => {
  const read = (doc) => readManifest(JSON.stringify(doc));
  const m = read(MAIL);
  assert.deepEqual(m.problems ?? [], []);
  assert.equal(m.manifest.permissions.signIn, true);
  assert.match(consentLines(m.manifest).map((l) => l.text).join("\n"), /Opens sign-in pages in a tab and reads the address they send you back to/);
  assert.equal(read({ ...MAIL, permissions: { signIn: "yes" } }).problems.some((p) => /permissions\.signIn must be true or false/.test(p)), true);
  const official = (version, permissions) => ({ ...read({ ...MAIL, version, permissions }).manifest, official: true });
  assert.equal(updateWithin(official("1.0.0", { files: true }), official("1.1.0", { files: true })).ok, true);
  assert.deepEqual(updateWithin(official("1.0.0", { files: true }), official("1.1.0", { files: true, signIn: true })), { ok: false, reason: "permissions" });
});

test("the guards' own answers and hostile inputs", () => {
  assert.deepEqual(signInCallbackOf("http://localhost:8080/"), { base: "http://localhost:8080", host: "localhost", port: 8080, path: "/" });
  assert.deepEqual(signInCallbackOf("http://[::1]:8080"), { base: "http://[::1]:8080", host: "::1", port: 8080, path: "/" });
  assert.equal(signInTimeoutOf(10 ** 9), 15 * 60_000);
  const cb = signInCallbackOf(CALLBACK);
  assert.equal(signInRedirect(cb, STATE, REAL), `http://127.0.0.1:53682${REAL}`);
  assert.equal(signInRedirect(cb, STATE, "/cb?code=x"), null);
  assert.equal(signInRedirect(cb, STATE, `/cbx?state=${STATE}`), null);
  for (const { value } of HOSTILE_VALUES) {
    for (const shaped of typeof value === "string" ? [value, `/cb?state=${STATE}&x=${value}`, `/cb?${value}`] : [value]) {
      const back = signInRedirect(cb, STATE, shaped);
      if (back !== null) assert.match(back, /^http:\/\/127\.0\.0\.1:53682\/cb\?[\x21\x22\x24-\x7e]*$/, show(shaped));
    }
    const callback = signInCallbackOf(value);
    if (!("problem" in callback)) assert.match(callback.path, /^\/[A-Za-z0-9/_.~-]*$/);
    const url = signInUrlOf(value, STATE);
    assert.ok("problem" in url || url.url.startsWith("https://"));
    assert.ok(signInStateOf(value) === null || /^[A-Za-z0-9_-]{16,256}$/.test(value));
  }
});
