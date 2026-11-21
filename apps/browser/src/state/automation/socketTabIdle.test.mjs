import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const MIN = 60_000;
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
