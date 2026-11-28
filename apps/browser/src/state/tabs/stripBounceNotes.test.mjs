import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;

class FakeStrip {
  rev = 0;
  tabs = [];
  active = 0;
  appWindow = undefined;
  commands = [];
  outbox = [];
  listen(listener) {
    this.listener = listener;
    return { remove() {} };
  }
  snapshot() {
    return Promise.resolve({ rev: this.rev, cmd: null, strips: this.tabs.length ? [this.state()] : [] });
  }
  command(command, id) {
    this.commands.push({ id, command });
  }
  state() {
    return {
      strip: 7,
      window: 70,
      ...(this.appWindow ? { appWindow: this.appWindow } : {}),
      profile: "",
      tabs: this.tabs.map((t, index) => ({ key: t.key, browser: t.browser, index, active: t.browser === this.active, pinned: false, group: null })),
      groups: [],
    };
  }
  emit(cmd, extra = {}) {
    const consent = typeof cmd === "number" && cmd >= 0 ? client.consentToken() : null;
    this.outbox.push({ rev: ++this.rev, cmd, strips: [this.state()], ...(consent ? { consent } : {}), ...extra });
  }
  select(key) {
    this.active = this.tabs.find((t) => t.key === key).browser;
  }
  runOne() {
    const next = this.commands.shift();
    if (!next) return null;
    if (next.command.op === "activate") this.select(next.command.key);
    this.emit(next.id);
    return next.id;
  }
  deliver() {
    const out = this.outbox;
    this.outbox = [];
    for (const tx of out) this.listener(tx);
    return out.length;
  }
}

const chrome = new FakeStrip();
globalThis.acTestTabStrip = chrome;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startChromeTabs } = await import("./chromeTabs.ts");
const { takeStripBounceCounts } = await import("./stripBounce.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((r) => setImmediate(r));
const shownIn = (w) => S().windows[w].activeTabIds[S().windows[w].profileId];

client.loadChoice();
client.setSharing(true, "onboarding");
startChromeTabs();
S().hydrate({});
const w = S().createWindow({ url: "a.com" });
const b = S().newTab(w, { url: "b.com", background: true });
const [a] = S().windows[w].tabIds;
chrome.appWindow = w;
chrome.tabs = S().windows[w].tabIds.map((key, i) => ({ key, browser: i + 1 }));
chrome.active = 1;
chrome.emit(-1, { trigger: "insert" });

async function settle() {
  for (let i = 0; i < 50; i++) {
    await tick();
    const delivered = chrome.deliver();
    await tick();
    const ran = chrome.runOne() !== null;
    if (!delivered && !ran && !chrome.outbox.length && !chrome.commands.length) return;
  }
  throw new Error("never settled");
}

async function switchAndAck(to) {
  S().activate(to);
  await tick();
  const ack = chrome.runOne();
  assert.ok(ack !== null, "the switch was sent to Chromium");
  chrome.deliver();
  return ack;
}

const bounceLogs = async () => {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"logs":[]}');
  return (saved.logs ?? []).filter((l) => /had just left/.test(JSON.stringify(l)));
};

await settle();
takeStripBounceCounts();
after(() => client.setSharing(false, "settings"));

test("a late deferred activation that names the tab just left is logged with its trigger, the deferral and where it came from", async () => {
  assert.equal(shownIn(w), a);
  await switchAndAck(b);
  assert.equal(shownIn(w), b);
  chrome.select(a);
  chrome.emit(null, { trigger: "activate", deferred: true, deferredInferred: true, deferredCmd: 12 });
  chrome.deliver();
  const counts = takeStripBounceCounts();
  assert.equal(counts.strip_bounces_back, 1);
  assert.equal(counts.strip_bounces_back_activate, 1);
  assert.equal(counts.strip_bounces_back_deferred, 1);
  assert.equal(counts.strip_bounces_back_active_fallback, 0);
  assert.equal(counts.strip_bounces_back_unknown, 0);
  const logs = await bounceLogs();
  const log = JSON.stringify(logs.at(-1));
  for (const field of [/"trigger"[^}]*"activate"/, /"deferred"[^}]*true/, /"deferredInferred"[^}]*true/, /"deferredFor"[^}]*"older"/, /"inflight"[^}]*"none"/, /"siblings"[^}]*false/, /"pendingActive"[^}]*false/])
    assert.match(log, field);
  assert.match(log, /"sinceAckMs","value":\{"intValue":"\d+"/);
  assert.doesNotMatch(log, new RegExp(`${a}|${b}|a\\.com|b\\.com`), "no tab keys or addresses");
  await settle();
});

test("a deferral asked for by the switch Chromium just answered reads as lastAck, and a first-tab stand-in as activeFallback", async () => {
  const ack = await switchAndAck(b);
  chrome.select(a);
  chrome.emit(null, { trigger: "attach", activeFallback: true, deferredCmd: ack });
  chrome.deliver();
  const counts = takeStripBounceCounts();
  assert.equal(counts.strip_bounces_back_attach, 1);
  assert.equal(counts.strip_bounces_back_active_fallback, 1);
  assert.equal(counts.strip_bounces_back_deferred, 0);
  const log = JSON.stringify((await bounceLogs()).at(-1));
  assert.match(log, /"deferredFor"[^}]*"lastAck"/);
  assert.match(log, /"activeFallback"[^}]*true/);
  await settle();
});

test("a report from an older native build without a trigger still counts, as unknown", async () => {
  await switchAndAck(b);
  chrome.select(a);
  chrome.emit(null);
  chrome.deliver();
  const counts = takeStripBounceCounts();
  assert.equal(counts.strip_bounces_back, 1);
  assert.equal(counts.strip_bounces_back_unknown, 1);
  assert.match(JSON.stringify((await bounceLogs()).at(-1)), /"trigger"[^}]*"unknown"/);
  await settle();
});

async function postponedSwitchAcrossOptIn(optInBeforeDelivery) {
  const from = shownIn(w);
  const to = from === a ? b : a;
  await client.setSharing(false, "settings");
  S().activate(to);
  await tick();
  const asked = chrome.commands.shift();
  assert.equal(asked.command.key, to);
  chrome.emit(asked.id, { deferred: true });
  if (optInBeforeDelivery) await client.setSharing(true, "settings");
  chrome.deliver();
  await tick();
  assert.equal(chrome.commands.length, 0, "the postponed switch is not sent again");
  if (!optInBeforeDelivery) await client.setSharing(true, "settings");
  takeStripBounceCounts();
  S().activate(from);
  await tick();
  assert.equal(chrome.commands.length, 0, "Chromium already shows the tab, so nothing is sent");
  chrome.select(to);
  chrome.emit(null, { trigger: "activate", deferred: true, deferredCmd: asked.id });
  chrome.deliver();
  assert.equal(takeStripBounceCounts().strip_bounces_back, 1);
  const log = JSON.stringify((await bounceLogs()).at(-1));
  assert.match(log, /"sinceAckMs","value":\{"intValue":"-1"/);
  assert.doesNotMatch(log, /"deferredFor"[^}]*"lastAck"/);
  assert.match(log, /"deferredFor"[^}]*"older"/);
  await settle();
}

test("an answer Chromium gave while sharing was off never reaches a warning sent after sharing is turned on", () => postponedSwitchAcrossOptIn(false));

test("an answer Chromium sent while sharing was off but that arrived after sharing was turned on is not used either", () => postponedSwitchAcrossOptIn(true));
