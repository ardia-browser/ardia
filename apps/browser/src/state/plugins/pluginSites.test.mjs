import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";
import { shellNativeModules } from "../../test-native/shell.ts";

const gate = { write: null };
globalThis.acTestNativeModules = {
  ArdiaPlugins: {
    ...shellNativeModules.ArdiaPlugins,
    filesCall: async (spec) => {
      if (gate.write && spec.op === "stage" && !spec.first) await gate.write;
      return shellNativeModules.ArdiaPlugins.filesCall(spec);
    },
  },
};

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated } = await import("./activation.ts");
const { settledStops, restartProcess } = await import("./process.ts");
const { consentLines } = await import("./consent.ts");
const { parsePluginRecords, pluginRecordsJson } = await import("./savedState.ts");
const { siteTarget, siteHeadersOf, takeToken, setPluginSignIn, activeSiteRequests, setSiteTransport, SITES_LIMITS } = await import("./channelSites.ts");
const { useSiteContexts, attachSiteContext, liveContextCount, hiddenPageTransport } = await import("./siteContexts.ts");
const { readManifest: parseManifest } = await import("../../lib/pluginManifest.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-sites-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const files = stub.pluginFiles;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 0;

const SITES = ["app.notion.com", "file.notion.com"];
const NOTES = { manifest: 2, name: "notes", title: "Notes", main: "dist/index.js", permissions: { storage: true, files: true, sites: SITES, siteHeaders: ["x-notion-active-user-header"] } };
const NO_FILES = { manifest: 2, name: "peek", title: "Peek", main: "dist/index.js", permissions: { sites: ["app.notion.com"] } };
const NOTHING = { manifest: 2, name: "bare", title: "Bare", main: "dist/index.js", permissions: {} };

const page = { evaluations: [], fetch: null, chunks: [], origin: null, start: null, cancels: 0, hold: null, stall: null, fetchHold: null, startHold: null, cancelHold: null };

const specOf = (script) => JSON.parse(/const spec = (\{.*\});/.exec(script)[1]);

const fakeHandle = (view) => ({
  evaluate: async (script) => {
    page.evaluations.push(script);
    if (script.includes("document.readyState")) return { origin: page.origin ?? view.origin, ready: true, plain: true };
    if (script.includes("spec.keep")) {
      if (page.fetchHold) await page.fetchHold;
      return page.fetch(specOf(script));
    }
    if (script.includes("store[spec.id] = entry")) {
      if (page.startHold) await page.startHold;
      return page.start(specOf(script));
    }
    if (script.includes("d.reader.read()")) {
      if (page.hold) await page.hold;
      if (!page.chunks.length && page.stall) await page.stall;
      return page.chunks.shift() ?? { error: "gone" };
    }
    if (script.includes("d.control.abort()")) {
      page.cancels++;
      if (page.cancelHold) await page.cancelHold;
      return true;
    }
    return null;
  },
});

useSiteContexts.subscribe((s) => {
  for (const view of Object.values(s.contexts)) queueMicrotask(() => attachSiteContext(view.key, fakeHandle(view)));
});

async function enable(...docs) {
  S().hydrate({});
  S().createWindow({ url: "https://a.example/" });
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const name of Object.keys(P().records)) lifecycle.updateRecord(name, () => null, consentToken());
  for (const key of ["starts", "stops", "replies", "events"]) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: JSON.stringify(doc), ...(doc.name === "outsider" ? {} : { folderId: "bundled" }) }));
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
  for (let i = 0; i < 200; i++) {
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

const downloadEvents = (name) => host.events.filter((e) => e.name === name).map((e) => JSON.parse(e.line)).filter((e) => e.event === "sites.download").map((e) => e.data);

async function untilDone(name, id) {
  for (let i = 0; i < 400; i++) {
    const last = downloadEvents(name).filter((d) => d.download === id).at(-1);
    if (last && last.state !== "running") return last;
    await tick();
  }
  assert.fail("the download never ended");
}

beforeEach(() => {
  files.reset();
  takePluginCounts();
  page.evaluations.length = 0;
  page.chunks = [];
  page.origin = null;
  page.cancels = 0;
  page.hold = null;
  page.stall = null;
  page.fetchHold = null;
  page.startHold = null;
  page.cancelHold = null;
  gate.write = null;
  setSiteTransport(hiddenPageTransport);
  page.fetch = () => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" });
  page.start = () => ({ status: 200, total: 0 });
});

test("permissions.sites takes 1 to 8 exact public hosts, sorted, and nothing looser", () => {
  const parse = (sites) => parseManifest(JSON.stringify({ ...NOTES, permissions: { sites } }));
  assert.deepEqual(parse(["file.notion.com", "app.notion.com", "app.notion.com"]).manifest.permissions.sites, ["app.notion.com", "file.notion.com"]);
  for (const bad of [[], ["*.notion.so"], ["notion"], ["127.0.0.1"], ["a.example:443"], ["https://a.example"], ["A.example"], ["a.localhost"], ["printer.local"], "a.example", Array.from({ length: 9 }, (_, i) => `h${i}.example`), ...HOSTILE_VALUES.map((v) => [v])]) {
    const parsed = parse(bad);
    assert.ok(parsed.problems.length > 0 || parsed.manifest.permissions.sites.length === 0, JSON.stringify(bad).slice(0, 80));
    assert.ok(!parsed.manifest || parsed.manifest.permissions.sites.every((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)), JSON.stringify(bad).slice(0, 80));
  }
});

test("the consent sheet names the sign-in plainly", () => {
  const m = parseManifest(JSON.stringify({ ...NOTES, permissions: { files: true, sites: ["app.notion.com", "file.notion.com", "file.notion.so", "www.notion.so"] } })).manifest;
  const line = consentLines(m).find((l) => l.sites);
  assert.equal(line.text, "Use your sign-in on app.notion.com, file.notion.com, file.notion.so and www.notion.so: Notes can read your Notion pages and make changes there as you. Never in private windows, and it never sees your password or cookies");
});

test("only https on a declared host, its own port, without credentials", () => {
  const m = parseManifest(JSON.stringify(NOTES)).manifest;
  assert.deepEqual(siteTarget(m, "https://app.notion.com/api/v3/getSpaces#x"), { url: "https://app.notion.com/api/v3/getSpaces", origin: "https://app.notion.com", host: "app.notion.com" });
  for (const bad of ["http://app.notion.com/", "https://app.notion.com:8443/", "https://app.notion.com./", "https://evil.example/", "https://notion.com/", "https://x.app.notion.com/", "https://user:pw@app.notion.com/", "https://app.notion.com@evil.example/", "javascript:alert(1)", "file:///etc/passwd", ...HOSTILE_VALUES])
    assert.equal(typeof siteTarget(m, bad), "string", String(bad).slice(0, 60));
});

test("plugins never send credentials, origin or hop headers, and nothing off one line", () => {
  const allowed = ["notion-client-version", "x-notion-active-user-header"];
  assert.deepEqual(siteHeadersOf({ "Content-Type": "application/json", "x-notion-active-user-header": "u1", "notion-client-version": "23.13" }, allowed), { "content-type": "application/json", "x-notion-active-user-header": "u1", "notion-client-version": "23.13" });
  assert.equal(typeof siteHeadersOf({ "x-other-header": "v" }, allowed), "string", "a custom header the manifest doesn't list is refused");
  for (const bad of [["x-csrf-token"], ["authorization"], ["content-type"], ["X-Upper"], ["nodash"], ["x-a", "x-a", "x-b", "x-c", "x-d", "x-e", "x-f", "x-g", "x-h", "x-i", "x-j", "x-k", "x-l", "x-m", "x-n", "x-o", "x-p"]]) {
    const parsed = parseManifest(JSON.stringify({ ...NOTES, permissions: { sites: SITES, siteHeaders: bad } }));
    assert.ok(parsed.problems.length > 0, JSON.stringify(bad));
  }
  assert.ok(parseManifest(JSON.stringify({ ...NOTES, permissions: { siteHeaders: ["x-a-b"] } })).problems.length > 0, "siteHeaders needs sites");
  for (const name of ["Cookie", "cookie2", "Authorization", "Proxy-Authorization", "Origin", "Referer", "Host", "sec-fetch-site", "x-forwarded-for", "X-Real-IP", "Content-Length", "Transfer-Encoding", "User-Agent", "connection", "proxyauth", "a b", "__proto__"])
    assert.equal(typeof siteHeadersOf({ [name]: "v" }), "string", name);
  for (const value of ["a\r\nCookie: x", "a\nb", "a\u0000", "x".repeat(2000), 5, null]) assert.equal(typeof siteHeadersOf({ accept: value }), "string", JSON.stringify(value));
  assert.equal(typeof siteHeadersOf(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-h${i}-a`, "v"]))), "string");
  for (const hostile of HOSTILE_VALUES) {
    const asValue = siteHeadersOf({ accept: hostile }, allowed);
    if (typeof asValue !== "string") assert.ok(!/[\u0000-\u001f\u007f]/.test(asValue.accept), JSON.stringify(hostile).slice(0, 60));
    if (typeof hostile === "string") {
      const asName = siteHeadersOf({ [hostile]: "v" }, allowed);
      if (typeof asName !== "string") for (const name of Object.keys(asName)) assert.match(name, /^[a-z0-9-]+$/);
    }
  }
});

test("the rate limit allows a burst, then about five a second", () => {
  const now = 1_000_000;
  let taken = 0;
  for (let i = 0; i < 40; i++) if (takeToken("rate-test", now)) taken++;
  assert.equal(taken, SITES_LIMITS.burst);
  assert.equal(takeToken("rate-test", now + 100), false);
  assert.equal(takeToken("rate-test", now + 400), true);
});

test("sites.fetch runs in the site's own page and hands back only the allowed headers", async () => {
  await enable(NOTES, NOTHING);
  const run = await activated("notes");
  let seen = null;
  page.fetch = (spec) => ((seen = spec), { status: 200, headers: { "content-type": "application/json", "set-cookie": "token_v2=SECRET", "x-secret": "no" }, body: '{"ok":1}' });
  const reply = await ask("notes", "sites.fetch", { url: "https://app.notion.com/api/v3/getSpaces", method: "post", headers: { "content-type": "application/json" }, body: "{}" }, run);
  assert.deepEqual(reply.result, { status: 200, ok: true, headers: { "content-type": "application/json" }, body: '{"ok":1}' });
  assert.equal(seen.origin, "https://app.notion.com");
  assert.equal(seen.method, "POST");
  assert.ok(!JSON.stringify(seen).toLowerCase().includes("cookie"), "nothing about cookies goes into the page");
  const script = page.evaluations.find((s) => s.includes("spec.keep"));
  assert.match(script, /mode: "same-origin"/);
  assert.match(script, /redirect: "manual"/);
  assert.match(script, /if \(location\.origin !== spec\.origin\)/);
  assert.equal(liveContextCount(), 1, "one page for the site, reused");
  await ask("notes", "sites.fetch", { url: "https://app.notion.com/api/v3/getTasks", method: "POST", body: "{}" }, run);
  assert.equal(liveContextCount(), 1);
  const counts = takePluginCounts();
  assert.equal(counts.plugin_site_fetches, 2);
});

test("a redirect, a moved page or an undeclared host is refused and counted", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  page.fetch = () => ({ error: "redirect" });
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x" }, run)).error.code, "refused");
  page.fetch = () => ({ error: "origin" });
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x" }, run)).error.code, "failed");
  assert.equal((await ask("notes", "sites.fetch", { url: "https://evil.example/x" }, run)).error.code, "refused");
  const counts = takePluginCounts();
  assert.ok(counts.plugin_site_refusals >= 2);
  assert.ok(counts.plugin_site_fetch_failures >= 2);
});

test("a plugin without sites, or with sign-in turned off in Settings, gets nothing", async () => {
  await enable(NOTES, NOTHING);
  const bare = await activated("bare");
  assert.equal((await ask("bare", "sites.fetch", { url: "https://app.notion.com/" }, bare)).error.code, "refused");
  const run = await activated("notes");
  assert.ok(setPluginSignIn("notes", false));
  assert.equal(P().records.notes.sitesOff, true);
  const reply = await ask("notes", "sites.fetch", { url: "https://app.notion.com/" }, run);
  assert.equal(reply.error.code, "refused");
  assert.match(reply.error.message, /Settings › Plugins/);
  assert.equal(page.evaluations.length, 0, "no page was even opened");
  assert.equal(parsePluginRecords(pluginRecordsJson(P().records)).notes.sitesOff, true, "the switch survives a restart");
  assert.ok(setPluginSignIn("notes", true));
  assert.equal(P().records.notes.sitesOff, undefined);
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/" }, run)).result.status, 200);
});

test("never in a private window: with only a private window open nothing runs", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  for (const id of Object.keys(S().windows)) S().closeWindow?.(id);
  S().hydrate({});
  S().createWindow({ kind: "private", url: "https://secret.example/" });
  const reply = await ask("notes", "sites.fetch", { url: "https://app.notion.com/" }, run);
  assert.equal(reply.error.code, "no_window");
  assert.equal(liveContextCount(), 0);
  assert.ok(Object.values(useSiteContexts.getState().contexts).every((c) => S().windows[c.windowId]?.kind !== "private"));
});

test("sites.download streams into the data folder, reports progress and checks the cap", async () => {
  await enable(NOTES, NO_FILES);
  const run = await activated("notes");
  const peek = await activated("peek");
  assert.equal((await ask("peek", "sites.download", { url: "https://file.notion.com/f/x.zip", to: "x.zip" }, peek)).error.code, "refused", "download needs files");
  for (const to of ["/abs", "../up", "a//b", "", ".x.ardia-1"]) assert.equal((await ask("notes", "sites.download", { url: "https://file.notion.com/f/x.zip", to }, run)).error.code, "bad_path", to);
  const part = Buffer.alloc(3000, 7).toString("base64");
  page.start = () => ({ status: 200, total: 6000 });
  page.chunks = [{ data: part, size: 3000, end: false }, { data: part, size: 3000, end: true }];
  const started = await ask("notes", "sites.download", { url: "https://file.notion.com/f/export.zip?sig=1", to: "notion-live/e.zip" }, run);
  const id = started.result.download;
  const last = await untilDone("notes", id);
  assert.deepEqual({ state: last.state, size: last.size }, { state: "done", size: 6000 }, JSON.stringify(last));
  assert.equal(files.root("notes", null).files.get("notion-live/e.zip").data.length, 6000);
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = [{ data: part, size: 3000, end: false }, { data: part, size: 3000, end: false }, { data: part, size: 3000, end: true }];
  const capped = await ask("notes", "sites.download", { url: "https://file.notion.com/f/big.zip", to: "big.zip", maxBytes: 5000 }, run);
  const over = await untilDone("notes", capped.result.download);
  assert.equal(over.state, "failed");
  assert.equal(over.code, "too_large");
  assert.equal(files.root("notes", null).files.has("big.zip"), false, "a partial file is removed");
  assert.ok(page.cancels >= 1, "the page's reader is cancelled");
});

test("cancel and a stopped plugin end a download and remove what it wrote", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const part = Buffer.alloc(1000, 1).toString("base64");
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = Array.from({ length: 50 }, () => ({ data: part, size: 1000, end: false }));
  let release;
  page.hold = new Promise((resolve) => (release = resolve));
  const started = await ask("notes", "sites.download", { url: "https://file.notion.com/f/x.zip", to: "x.zip" }, run);
  const id = started.result.download;
  await settle(30);
  assert.equal((await ask("notes", "sites.download", { url: "https://file.notion.com/f/y.zip", to: "y.zip" }, run)).error.code, "refused", "one download at a time");
  assert.deepEqual((await ask("notes", "sites.cancel", { download: id }, run)).result, { ok: true });
  release();
  page.hold = null;
  const last = await untilDone("notes", id);
  assert.equal(last.state, "cancelled");
  assert.equal(files.root("notes", null).files.has("x.zip"), false);
  page.chunks = [{ data: part, size: 1000, end: false }];
  let unstall;
  page.stall = new Promise((resolve) => (unstall = resolve));
  const again = await ask("notes", "sites.download", { url: "https://file.notion.com/f/z.zip", to: "z.zip" }, run);
  await settle(20);
  await settle(20);
  assert.ok(files.staged.size > 0, "it staged a part before the stop");
  restartProcess("notes");
  await settle(30);
  unstall();
  page.stall = null;
  await settle(60);
  assert.equal(files.root("notes", null).files.has("z.zip"), false, "a stopped plugin's download never reaches its path");
  assert.equal(files.staged.size, 0, "and its staged part is discarded");
  assert.ok(!downloadEvents("notes").some((d) => d.download === again.result.download && d.state === "done"));
});

test("codex 3: a reply already on its way is dropped when sign-in goes off and on again meanwhile", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  let release;
  page.fetchHold = new Promise((resolve) => (release = resolve));
  const id = ++nextId;
  const before = host.replies.length;
  stub.emitPluginLine({ name: "notes", run, line: JSON.stringify({ id, method: "sites.fetch", params: { url: "https://app.notion.com/api/v3/getSpaces" } }) });
  await settle(20);
  assert.ok(setPluginSignIn("notes", false));
  assert.ok(setPluginSignIn("notes", true));
  release();
  await settle(30);
  const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.equal(reply.error.code, "refused", "the answer from before the switch never reaches the plugin");
});

test("codex 3: turning sign-in off while the last write is pending ends the download cancelled, without the file", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const part = Buffer.alloc(500, 3).toString("base64");
  page.start = () => ({ status: 200, total: 1000 });
  page.chunks = [{ data: part, size: 500, end: false }, { data: part, size: 500, end: true }];
  let release;
  gate.write = new Promise((resolve) => (release = resolve));
  const started = await ask("notes", "sites.download", { url: "https://file.notion.com/f/x.zip", to: "race.zip" }, run);
  await settle(30);
  assert.ok(files.staged.size > 0 && !files.root("notes", null).files.has("race.zip"), "the first part is staged, the last pending, nothing at the path");
  assert.ok(setPluginSignIn("notes", false));
  release();
  gate.write = null;
  const last = await untilDone("notes", started.result.download);
  assert.equal(last.state, "cancelled");
  assert.equal(files.root("notes", null).files.has("race.zip"), false);
});

test("codex 4: a download never replaces or deletes a file already at its path", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  files.put("notes", null, "keep.zip", "the plugin's own data");
  const part = Buffer.alloc(10, 1).toString("base64");
  page.start = () => ({ status: 200, total: 10 });
  page.chunks = [{ data: part, size: 10, end: true }];
  const started = await ask("notes", "sites.download", { url: "https://file.notion.com/f/x.zip", to: "keep.zip" }, run);
  const last = await untilDone("notes", started.result.download);
  assert.deepEqual([last.state, last.code], ["failed", "exists"]);
  assert.equal(files.text("notes", null, "keep.zip"), "the plugin's own data");
});

test("codex 2: the host counts decoded bytes, not what the page claims, and caps text by UTF-8 bytes", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = [{ data: Buffer.alloc(3000, 1).toString("base64"), size: 1, end: true }];
  const lied = await ask("notes", "sites.download", { url: "https://file.notion.com/f/x.zip", to: "lie.zip", maxBytes: 100 }, run);
  const last = await untilDone("notes", lied.result.download);
  assert.equal(last.state, "failed");
  assert.equal(files.root("notes", null).files.has("lie.zip"), false);
  page.fetch = () => ({ status: 200, headers: {}, body: "é".repeat(SITES_LIMITS.replyBodyBytes / 2 + 10) });
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x" }, run)).error.code, "too_large");
});

test("codex 5: a download takes one of the four slots, and restarting doesn't refill the rate bucket", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const part = Buffer.alloc(10, 1).toString("base64");
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = [{ data: part, size: 10, end: false }];
  let unstall;
  page.stall = new Promise((resolve) => (unstall = resolve));
  const dl = await ask("notes", "sites.download", { url: "https://file.notion.com/f/x.zip", to: "slot.zip" }, run);
  let release;
  page.fetchHold = new Promise((resolve) => (release = resolve));
  for (let i = 0; i < 3; i++) stub.emitPluginLine({ name: "notes", run, line: JSON.stringify({ id: ++nextId, method: "sites.fetch", params: { url: "https://app.notion.com/x" } }) });
  await settle(20);
  assert.equal(activeSiteRequests("notes"), 4);
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/y" }, run)).error.code, "refused", "a fifth is refused");
  release();
  await ask("notes", "sites.cancel", { download: dl.result.download }, run);
  unstall();
  await untilDone("notes", dl.result.download);
  await settle(20);
  assert.equal(activeSiteRequests("notes"), 0);
  const past = Date.now() - 100_000;
  let taken = 0;
  for (let i = 0; i < 40; i++) if (takeToken("notes", past)) taken++;
  restartProcess("notes");
  await settle(20);
  assert.equal(takeToken("notes", past), false, "a restart keeps the bucket");
  assert.ok(taken <= SITES_LIMITS.burst);
});

test("codex 6 and 7: cancel ends a stalled download at once, and its end can be asked for", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = [];
  page.stall = new Promise(() => {});
  const dl = await ask("notes", "sites.download", { url: "https://file.notion.com/f/x.zip", to: "stall.zip" }, run);
  await settle(20);
  await ask("notes", "sites.cancel", { download: dl.result.download }, run);
  const last = await untilDone("notes", dl.result.download);
  assert.equal(last.state, "cancelled");
  assert.equal((await ask("notes", "sites.status", { download: dl.result.download }, run)).result.state, "cancelled");
  assert.equal((await ask("notes", "sites.status", { download: "dnope" }, run)).error.code, "not_found");
});

test("codex 8: turning a changed plugin back on keeps its sign-in switch off", async () => {
  await enable(NOTES);
  assert.ok(setPluginSignIn("notes", false));
  host.folders = [{ name: "notes", status: "ok", text: JSON.stringify({ ...NOTES, version: "0.2.0", description: "changed" }) }];
  await lifecycle.rescanPlugins(consentToken());
  if (P().listings.notes.hash !== P().records.notes.approved) {
    assert.ok(lifecycle.requestPluginConsent("notes"));
    assert.ok(lifecycle.enablePlugin("notes", P().consent.hash));
  }
  assert.equal(P().records.notes.sitesOff, true);
  assert.ok(setPluginSignIn("notes", true));
});

test("codex 9: a session keeps a job on the profile it started in", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const session = (await ask("notes", "sites.session", {}, run)).result.session;
  assert.match(session, /^s[0-9a-f]{10}$/);
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x", session }, run)).result.status, 200);
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x", session: "sforged00000000000000" }, run)).error.code, "refused");
  restartProcess("notes");
  await settle();
  await settledStops();
  const restarted = await activated("notes");
  assert.notEqual(restarted, run);
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x", session }, restarted)).error.code, "refused", "a session doesn't outlive its run");
});

test("round 2 blocker: with no safe engine transport every site call is unavailable and nothing opens", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  setSiteTransport(null);
  assert.deepEqual((await ask("notes", "sites.available", {}, run)).result, { available: false });
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x" }, run)).error.code, "unavailable");
  assert.equal((await ask("notes", "sites.download", { url: "https://file.notion.com/x.zip", to: "x.zip" }, run)).error.code, "unavailable");
  assert.equal((await ask("notes", "sites.session", {}, run)).error.code, "unavailable");
  assert.equal(page.evaluations.length, 0);
  setSiteTransport(hiddenPageTransport);
  assert.deepEqual((await ask("notes", "sites.available", {}, run)).result, { available: true });
});

test("round 2 high 1: a cancel before the headers arrive aborts the page's request and frees the slot only after", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  let headers;
  page.startHold = new Promise((resolve) => (headers = resolve));
  let teardown;
  page.cancelHold = new Promise((resolve) => (teardown = resolve));
  const dl = await ask("notes", "sites.download", { url: "https://file.notion.com/x.zip", to: "early.zip" }, run);
  await settle(20);
  await ask("notes", "sites.cancel", { download: dl.result.download }, run);
  await settle(20);
  assert.equal(page.cancels, 1, "the in-page abort ran");
  assert.equal(activeSiteRequests("notes"), 1, "the slot stays taken until the abort settles");
  assert.equal((await ask("notes", "sites.status", { download: dl.result.download }, run)).result.state, "cancelled", "status answers the end during cleanup");
  teardown();
  headers();
  const last = await untilDone("notes", dl.result.download);
  assert.equal(last.state, "cancelled");
  await settle(20);
  assert.equal(activeSiteRequests("notes"), 0);
  assert.equal(files.root("notes", null).files.has("early.zip"), false);
});

test("round 2 high 2: a file put at the path mid-download is never touched, and a queued part never lands there", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const part = Buffer.alloc(100, 9).toString("base64");
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = [{ data: part, size: 100, end: false }];
  let unstall;
  page.stall = new Promise((resolve) => (unstall = resolve));
  const dl = await ask("notes", "sites.download", { url: "https://file.notion.com/x.zip", to: "swap.zip" }, run);
  await settle(30);
  files.put("notes", null, "swap.zip", "the plugin's replacement");
  let release;
  gate.write = new Promise((resolve) => (release = resolve));
  page.chunks = [{ data: part, size: 100, end: true }];
  unstall();
  await settle(20);
  assert.ok(setPluginSignIn("notes", false));
  release();
  gate.write = null;
  const last = await untilDone("notes", dl.result.download);
  assert.equal(last.state, "cancelled");
  assert.equal(files.text("notes", null, "swap.zip"), "the plugin's replacement");
  assert.equal(files.staged.size, 0);
  assert.ok(setPluginSignIn("notes", true));
});

test("round 2 high 3: each window has its own page, and closing one ends only its own work", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  const a = Object.keys(S().windows)[0];
  const b = S().createWindow({ url: "https://b.example/" });
  const focus = (id) => useBrowser.setState((st) => ({ ui: { ...st.ui, focusOrder: [id, ...st.ui.focusOrder.filter((x) => x !== id)] } }));
  focus(a);
  const sessionA = (await ask("notes", "sites.session", {}, run)).result.session;
  focus(b);
  const sessionB = (await ask("notes", "sites.session", {}, run)).result.session;
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x", session: sessionA }, run)).result.status, 200);
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x", session: sessionB }, run)).result.status, 200);
  assert.deepEqual(new Set(Object.values(useSiteContexts.getState().contexts).map((c) => c.windowId)), new Set([a, b]), "one page per window, never borrowed");
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = [];
  let unstall;
  page.stall = new Promise((resolve) => (unstall = resolve));
  const inA = await ask("notes", "sites.download", { url: "https://file.notion.com/x.zip", to: "a.zip", session: sessionA }, run);
  await settle(20);
  S().closeWindow(a);
  page.chunks = [{ data: Buffer.alloc(10, 1).toString("base64"), size: 10, end: true }];
  unstall();
  const last = await untilDone("notes", inA.result.download);
  assert.equal(last.state, "cancelled", "work bound to the closed window ends");
  assert.equal(files.root("notes", null).files.has("a.zip"), false);
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x", session: sessionA }, run)).error.code, "no_window");
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x", session: sessionB }, run)).result.status, 200, "the other window's session goes on");
});

test("round 2 medium 7: a download can't ask for more than the plugin's 2 GiB of files, and a full quota says so", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  assert.equal((await ask("notes", "sites.download", { url: "https://file.notion.com/x.zip", to: "q.zip", maxBytes: 4 * 1024 ** 3 }, run)).error.code, "bad_request");
  files.quotaBytes = 50;
  page.start = () => ({ status: 200, total: 0 });
  page.chunks = [{ data: Buffer.alloc(100, 1).toString("base64"), size: 100, end: true }];
  const dl = await ask("notes", "sites.download", { url: "https://file.notion.com/x.zip", to: "q.zip" }, run);
  const last = await untilDone("notes", dl.result.download);
  assert.deepEqual([last.state, last.code], ["failed", "quota"]);
});

test("interim transport: only a built-in official plugin gets it; a third-party plugin with the same manifest stays unavailable", async () => {
  const OUTSIDER = { ...NOTES, name: "outsider", title: "Outsider" };
  await enable(NOTES, OUTSIDER);
  const outsider = await activated("outsider");
  assert.deepEqual((await ask("outsider", "sites.available", {}, outsider)).result, { available: false });
  assert.equal((await ask("outsider", "sites.fetch", { url: "https://app.notion.com/x" }, outsider)).error.code, "unavailable");
  assert.equal((await ask("outsider", "sites.download", { url: "https://file.notion.com/x.zip", to: "x.zip" }, outsider)).error.code, "unavailable");
  assert.equal((await ask("outsider", "sites.session", {}, outsider)).error.code, "unavailable");
  assert.equal(page.evaluations.length, 0, "no hidden page opens for it");
  const notes = await activated("notes");
  assert.deepEqual((await ask("notes", "sites.available", {}, notes)).result, { available: true });
});

test("interim transport: every run checks the page is still the site's own plain-text page first", async () => {
  await enable(NOTES);
  const run = await activated("notes");
  assert.equal((await ask("notes", "sites.fetch", { url: "https://app.notion.com/x" }, run)).result.status, 200);
  page.origin = "https://elsewhere.example";
  const before = page.evaluations.filter((e) => e.includes("spec.keep")).length;
  const moved = await ask("notes", "sites.fetch", { url: "https://app.notion.com/x" }, run);
  assert.equal(moved.error.code, "failed");
  assert.equal(page.evaluations.filter((e) => e.includes("spec.keep")).length, before, "the request never ran in the moved page");
  assert.equal(liveContextCount(), 0, "the moved page is closed");
  page.origin = null;
  const script = page.evaluations.find((e) => e.includes("spec.keep"));
  assert.match(script, /credentials: "include"/);
  assert.match(script, /redirect: "manual"/);
});
