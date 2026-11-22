import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const MIN = 60_000;
const frozen = Date.now();
let skew = 0;
Date.now = () => frozen + skew;
function advance(t, ms) {
  skew += ms;
  t.after(() => (skew = 0));
}
let nextId = 0;
let nextConnection = 900;

function connections(t, count) {
  const ids = Array.from({ length: count }, () => ++nextConnection);
  t.after(() => ids.forEach((id) => stub.emitControlClose(id)));
  return ids;
}

async function idleTabs() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const w = S().createWindow({ url: "https://a.com/" });
  const [b, c] = ["b", "c"].map((u) => S().newTab(w, { url: `https://${u}.com/`, background: true }));
  for (const id of [b, c]) S().updateTab(id, { lastActiveAt: Date.now() - 2 * 60 * MIN });
  return { b, c };
}

const sent = [];
let failNextReply = false;
for (const [list, kind] of [[stub.controlSocket.replies, "reply"], [stub.controlSocket.broadcasts, "event"]]) {
  const push = list.push.bind(list);
  list.push = (...items) => {
    if (kind === "reply" && failNextReply) {
      failNextReply = false;
      throw new Error("socket write failed");
    }
    for (const item of items) sent.push({ kind, connections: item.connections ?? [item.connection] });
    return push(...items);
  };
}

function subscribe(connection, events, tab) {
  const from = sent.length;
  stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id: ++nextId, method: "subscribe", params: { events, idle: { tab } } }) });
  const mine = sent.slice(from).filter((s) => s.connections.includes(connection));
  assert.equal(mine[0]?.kind, "reply", "the subscribe reply comes before any idle event");
}

const idleLog = (connection, from) =>
  stub.controlSocket.broadcasts
    .slice(from)
    .filter((b) => b.connections.includes(connection))
    .map((b) => JSON.parse(b.line))
    .filter((e) => e.event === "tab.idle" || e.event === "tab.resumed");

const idleEvents = (connection, from) =>
  stub.controlSocket.broadcasts
    .slice(from)
    .filter((b) => b.connections.includes(connection))
    .map((b) => JSON.parse(b.line))
    .filter((e) => e.event === "tab.idle" || e.event === "tab.resumed")
    .map((e) => `${e.event} ${e.data.url} ${e.data.idle}`)
    .sort();

test("another client subscribing or leaving doesn't send tab.idle again, and the idle tabs still resume once", async (t) => {
  const { b } = await idleTabs();
  const [listener, other] = connections(t, 2);
  let from = stub.controlSocket.broadcasts.length;
  subscribe(listener, ["tab.idle", "tab.resumed"], [1800]);
  assert.deepEqual(idleEvents(listener, from), ["tab.idle https://b.com/ 1800", "tab.idle https://c.com/ 1800"]);
  from = stub.controlSocket.broadcasts.length;
  subscribe(other, ["tab.crashed"], []);
  stub.emitControlClose(other);
  assert.deepEqual(idleEvents(listener, from), []);
  S().activate(b);
  assert.deepEqual(idleEvents(listener, from), ["tab.resumed https://b.com/ 1800"]);
});

test("a client that joins a threshold already watched gets the idle tabs once, and nobody else gets them again", async (t) => {
  await idleTabs();
  const [first, late] = connections(t, 2);
  subscribe(first, ["tab.idle"], [1800]);
  const from = stub.controlSocket.broadcasts.length;
  subscribe(late, ["tab.idle"], [1800]);
  subscribe(late, ["tab.idle", "tab.crashed"], [1800]);
  assert.deepEqual(idleEvents(late, from), ["tab.idle https://b.com/ 1800", "tab.idle https://c.com/ 1800"]);
  assert.deepEqual(idleEvents(first, from), []);
});

test("an idle threshold from a client that doesn't want idle events doesn't use up the tabs for a later one", async (t) => {
  await idleTabs();
  const [crashes, half, hour] = connections(t, 3);
  subscribe(crashes, ["tab.crashed"], [3600]);
  subscribe(half, ["tab.idle"], [1800]);
  const from = stub.controlSocket.broadcasts.length;
  subscribe(hour, ["tab.idle"], [3600]);
  assert.deepEqual(idleEvents(hour, from), ["tab.idle https://b.com/ 3600", "tab.idle https://c.com/ 3600"]);
  assert.deepEqual(idleEvents(half, from), []);
});

test("dropping one threshold keeps the other's idle tabs, which resume once at that threshold", async (t) => {
  const { b } = await idleTabs();
  const [listener] = connections(t, 1);
  subscribe(listener, ["tab.idle", "tab.resumed"], [1800, 3600]);
  const from = stub.controlSocket.broadcasts.length;
  subscribe(listener, ["tab.idle", "tab.resumed"], [1800]);
  assert.deepEqual(idleEvents(listener, from), []);
  S().activate(b);
  assert.deepEqual(idleEvents(listener, from), ["tab.resumed https://b.com/ 1800"]);
});

test("a threshold added later still knows the tab that was just on screen", async (t) => {
  const { b } = await idleTabs();
  const a = Object.keys(S().tabs).find((id) => S().tabs[id].url === "https://a.com/");
  S().updateTab(a, { lastActiveAt: Date.now() - 2 * 60 * MIN });
  const [listener] = connections(t, 1);
  subscribe(listener, ["tab.idle"], [1800]);
  S().activate(b);
  const from = stub.controlSocket.broadcasts.length;
  subscribe(listener, ["tab.idle"], [1800, 3600]);
  assert.deepEqual(idleEvents(listener, from), ["tab.idle https://c.com/ 3600"]);
});

test("subscribing, leaving and subscribing again in one go replays each time, with nothing left over", async (t) => {
  await idleTabs();
  const [listener] = connections(t, 1);
  const from = stub.controlSocket.broadcasts.length;
  subscribe(listener, ["tab.idle"], [1800]);
  assert.equal(idleEvents(listener, from).length, 2);
  subscribe(listener, [], []);
  subscribe(listener, ["tab.idle"], [1800]);
  assert.equal(idleEvents(listener, from).length, 4);
  await tick();
  assert.deepEqual(idleEvents(listener, from), ["tab.idle https://b.com/ 1800", "tab.idle https://b.com/ 1800", "tab.idle https://c.com/ 1800", "tab.idle https://c.com/ 1800"]);
});

test("a subscribe whose reply couldn't be written leaves no idle replay for the next reply", async (t) => {
  await idleTabs();
  const [listener] = connections(t, 1);
  const from = stub.controlSocket.broadcasts.length;
  failNextReply = true;
  const request = (method, params) => stub.emitControlRequest({ connection: listener, generation: stub.controlSocket.generation, line: JSON.stringify({ id: ++nextId, method, params }) });
  request("subscribe", { events: ["tab.idle"], idle: { tab: [1800] } });
  assert.equal(failNextReply, false, "the subscribe reply was attempted");
  stub.emitControlRequest({ connection: listener, generation: stub.controlSocket.generation, line: JSON.stringify({ id: ++nextId, method: "hello" }) });
  assert.deepEqual(idleEvents(listener, from), []);
});

test("a client joining a watched threshold gets the tabs that crossed it since the last scan, and the others get them once", async (t) => {
  const { b, c } = await idleTabs();
  for (const id of [b, c]) S().updateTab(id, { lastActiveAt: Date.now() - 59_000 });
  const [resumes, idles, late] = connections(t, 3);
  subscribe(resumes, ["tab.resumed"], [60]);
  subscribe(idles, ["tab.idle"], [60]);
  const from = stub.controlSocket.broadcasts.length;
  advance(t, 2_000);
  subscribe(late, ["tab.idle", "tab.resumed"], [60]);
  S().activate(b);
  assert.deepEqual(idleEvents(late, from), ["tab.idle https://b.com/ 60", "tab.idle https://c.com/ 60", "tab.resumed https://b.com/ 60"]);
  assert.deepEqual(idleEvents(idles, from), ["tab.idle https://b.com/ 60", "tab.idle https://c.com/ 60"]);
  assert.deepEqual(idleEvents(resumes, from), ["tab.resumed https://b.com/ 60"]);
});

test("a tab moved to another profile in the background starts a new idle stretch there", async (t) => {
  const { b } = await idleTabs();
  const work = S().createProfile({ name: "Work" });
  const [listener, late] = connections(t, 2);
  subscribe(listener, ["tab.idle"], [1800]);
  S().moveTabToProfile(b, work, { background: true });
  const movedAt = S().tabs[b].lastActiveAt;
  let from = stub.controlSocket.broadcasts.length;
  subscribe(late, ["tab.idle"], [1800]);
  assert.deepEqual(idleEvents(late, from), ["tab.idle https://c.com/ 1800"]);
  from = stub.controlSocket.broadcasts.length;
  advance(t, 31 * MIN);
  S().createWindow({ url: "https://d.com/" });
  const again = idleLog(listener, from).filter((e) => e.data.url === "https://b.com/");
  assert.equal(again.length, 1, "the moved tab goes idle again after a full stretch");
  assert.equal(again[0].data.profile, work);
  assert.equal(again[0].data.idleSince, movedAt);
});

test("replacing a subscription with a new threshold sends nothing at the old one before the reply", async (t) => {
  const { b, c } = await idleTabs();
  for (const id of [b, c]) S().updateTab(id, { lastActiveAt: Date.now() - 59_000 });
  const [listener] = connections(t, 1);
  subscribe(listener, ["tab.idle"], [60]);
  const from = stub.controlSocket.broadcasts.length;
  advance(t, 2_000);
  subscribe(listener, ["tab.idle"], [120]);
  assert.deepEqual(idleEvents(listener, from), []);
});

test("an idle tab selected in a window without focus still resumes once that window is focused", async (t) => {
  const { b } = await idleTabs();
  const w = S().tabs[b].windowId;
  const [listener] = connections(t, 1);
  subscribe(listener, ["tab.idle", "tab.resumed"], [1800]);
  S().createWindow({ url: "https://d.com/" });
  const from = stub.controlSocket.broadcasts.length;
  S().activate(b);
  S().setFocusedWindow(w);
  assert.deepEqual(idleEvents(listener, from), ["tab.resumed https://b.com/ 1800"]);
});

test("a synced activity time that still leaves the tab idle doesn't send tab.idle again", async (t) => {
  const { b } = await idleTabs();
  const [listener, late] = connections(t, 2);
  subscribe(listener, ["tab.idle"], [60]);
  S().updateTab(b, { lastActiveAt: Date.now() - 10 * MIN });
  const from = stub.controlSocket.broadcasts.length;
  subscribe(late, ["tab.idle"], [60]);
  assert.deepEqual(idleEvents(listener, from), []);
  assert.deepEqual(idleEvents(late, from), ["tab.idle https://b.com/ 60", "tab.idle https://c.com/ 60"]);
});

test("moving an idle tab to another profile in front starts a new stretch without a tab.resumed", async (t) => {
  const { b } = await idleTabs();
  const work = S().createProfile({ name: "Work" });
  const [listener] = connections(t, 1);
  subscribe(listener, ["tab.idle", "tab.resumed"], [1800]);
  const from = stub.controlSocket.broadcasts.length;
  S().moveTabToProfile(b, work);
  assert.deepEqual(idleEvents(listener, from), []);
});

test("a tab recreated under the same id, like a pin restored in another window, starts a new idle stretch", async (t) => {
  const { b } = await idleTabs();
  const [listener, late] = connections(t, 2);
  subscribe(listener, ["tab.idle"], [60]);
  const restoredAt = Date.now();
  S().updateTab(b, { restoredAt });
  let from = stub.controlSocket.broadcasts.length;
  subscribe(late, ["tab.idle"], [60]);
  assert.deepEqual(idleEvents(late, from), ["tab.idle https://c.com/ 60"]);
  from = stub.controlSocket.broadcasts.length;
  advance(t, 61_000);
  S().createWindow({ url: "https://d.com/" });
  const again = idleLog(listener, from).filter((e) => e.data.url === "https://b.com/");
  assert.equal(again.length, 1);
  assert.equal(again[0].data.idleSince, restoredAt);
});

test("an idle tab moved to another profile in the background never resumes the old profile's stretch when it's shown", async (t) => {
  const { b } = await idleTabs();
  const work = S().createProfile({ name: "Work" });
  const [listener] = connections(t, 1);
  subscribe(listener, ["tab.idle", "tab.resumed"], [1800]);
  const from = stub.controlSocket.broadcasts.length;
  S().moveTabToProfile(b, work, { background: true });
  S().activate(b);
  assert.equal(S().tabs[b].profileId, work);
  assert.deepEqual(idleEvents(listener, from), []);
});

test("a late subscriber is replayed the open idle stretches as the others heard them, and hears their resume", async (t) => {
  const { b, c } = await idleTabs();
  const [listener, late] = connections(t, 2);
  subscribe(listener, ["tab.idle", "tab.resumed"], [60]);
  const told = Object.fromEntries(idleLog(listener, 0).filter((e) => e.event === "tab.idle").map((e) => [e.data.url, e.data.idleSince]));
  S().updateTab(b, { lastActiveAt: Date.now() });
  S().updateTab(c, { lastActiveAt: Date.now() - 10 * MIN });
  let from = stub.controlSocket.broadcasts.length;
  subscribe(late, ["tab.idle", "tab.resumed"], [60]);
  const replayed = Object.fromEntries(idleLog(late, from).map((e) => [e.data.url, e.data.idleSince]));
  assert.deepEqual(replayed, told);
  from = stub.controlSocket.broadcasts.length;
  S().activate(b);
  assert.deepEqual(idleEvents(late, from), ["tab.resumed https://b.com/ 60"]);
});
