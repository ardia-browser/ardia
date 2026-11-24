import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { liveEngineSessions } = await import("./engineCli.ts");
const { openInspection } = await import("./devToolsSession.ts");

const asks = [];
let nextSession = 100;
const answers = {
  cliDevToolsOpen: (args) => ({ session: ++nextSession, targetId: `T-${args.tabId}`, scope: args.scope }),
  cliDevToolsSend: (args) => (args.method === "Fail.please" ? Promise.reject(new Error("no such method")) : { result: { echoed: args.method } }),
  cliDevToolsClose: () => ({ closed: true }),
  cliCancel: () => ({ cancelled: 0 }),
  cliClick: (args) => ({ point: [10, 20], verified: true, blocked: args.ref === "e9", clicked: args.ref !== "e9" }),
};
globalThis.acTestCliEngine = (call, args) => {
  asks.push({ call, args });
  const answer = answers[call];
  return answer ? answer(args) : undefined;
};

after(() => {
  delete globalThis.acTestCliEngine;
  S().updateSettings({ cliControl: false });
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

const eventsFor = (connection, from) =>
  stub.controlSocket.broadcasts
    .slice(from)
    .filter((b) => b.connections.includes(connection))
    .map((b) => JSON.parse(b.line));

async function aTab() {
  const { windowId } = await freshWindow("https://shown.example/");
  return S().newTab(windowId, { url: "https://one.example/", background: true });
}

test("a DevTools session belongs to the connection that opened it, gets its events and ends with it", async () => {
  const tab = await aTab();
  const owner = socketClient(501);
  const other = socketClient(502);
  asks.length = 0;
  const opened = await owner.ok("devtools.attach", { tab });
  assert.equal(opened.tab, tab);
  assert.equal(asks[0].call, "cliDevToolsOpen");
  assert.equal(asks[0].args.scope, "full", "the owner's session is a full DevTools client");
  assert.match(asks[0].args.owner, /^s\d+c501$/);
  const sent = await owner.ok("devtools.send", { session: opened.session, method: "Runtime.evaluate", params: { expression: "1" } });
  assert.deepEqual(sent.result, { echoed: "Runtime.evaluate" });
  const stolen = await other.call("devtools.send", { session: opened.session, method: "Runtime.evaluate" });
  assert.equal(stolen.error?.code, "no_window", "another connection can't use it");
  const before = stub.controlSocket.broadcasts.length;
  stub.emitEvent("engine.cliDevTools", { session: opened.session, method: "Network.requestWillBeSent", params: { requestId: "1" } });
  stub.emitEvent("engine.cliDevTools", { session: opened.session, method: "Tracing.dataCollected", cut: true, bytes: 2_000_000 });
  stub.emitEvent("engine.cliDevTools", { session: opened.session, method: "Tracing.tracingComplete", params: {}, dropped: 4, droppedByHost: 2 });
  await settle();
  const pushed = eventsFor(501, before);
  assert.deepEqual(
    pushed.map((e) => [e.event, e.data.method, e.data.cut ?? false, e.data.dropped ?? 0, e.data.droppedByHost ?? 0]),
    [
      ["devtools.event", "Network.requestWillBeSent", false, 0, 0],
      ["devtools.event", "Tracing.dataCollected", true, 0, 0],
      ["devtools.event", "Tracing.tracingComplete", false, 4, 2],
    ],
    "a socket client is told when the engine or the host dropped its events",
  );
  assert.equal(eventsFor(502, before).length, 0, "events go only to the owning connection");
  assert.equal(liveEngineSessions(), 1);
  asks.length = 0;
  stub.emitControlClose(501);
  await settle();
  assert.equal(liveEngineSessions(), 0);
  assert.ok(asks.some((a) => a.call === "cliCancel" && /c501$/.test(a.args.owner)), "the engine is told to end the connection's sessions and work");
});

test("devtools.batch runs commands in order and stops at the first error unless asked not to", async () => {
  const tab = await aTab();
  const client = socketClient(511);
  const { session } = await client.ok("devtools.attach", { tab });
  const stopped = await client.ok("devtools.batch", { session, commands: [{ method: "DOM.enable" }, { method: "Fail.please" }, { method: "CSS.enable" }] });
  assert.equal(stopped.completed, 1);
  assert.equal(stopped.stopped, true);
  assert.match(stopped.results[1].error.message, /no such method/);
  const all = await client.ok("devtools.batch", { session, commands: [{ method: "DOM.enable" }, { method: "Fail.please" }, { method: "CSS.enable" }], stopOnError: false });
  assert.equal(all.results.length, 3);
  assert.equal(all.completed, 2);
  const bad = await client.call("devtools.batch", { session, commands: [{ method: "DOM.enable", extra: 1 }] });
  assert.equal(bad.error?.code, "bad_request");
  const detached = await client.ok("devtools.detach", { session });
  assert.equal(detached.closed, true);
  assert.deepEqual(await client.ok("devtools.sessions", {}), []);
  stub.emitControlClose(511);
});

test("the engine closing a session tells its connection once and forgets it", async () => {
  const tab = await aTab();
  const client = socketClient(521);
  const { session } = await client.ok("devtools.attach", { tab });
  const before = stub.controlSocket.broadcasts.length;
  stub.emitEvent("engine.cliDevTools", { session, closed: "tab-closed" });
  await settle();
  assert.deepEqual(eventsFor(521, before).map((e) => [e.event, e.data.reason]), [["devtools.detached", "tab-closed"]]);
  assert.equal((await client.call("devtools.send", { session, method: "Page.reload" })).error?.code, "no_window");
  stub.emitControlClose(521);
});

test("the app's inspection sessions run on the engine with the inspect scope and get only their own events", async () => {
  const tab = await aTab();
  asks.length = 0;
  const inspection = await openInspection(tab, 531);
  const open = asks.find((a) => a.call === "cliDevToolsOpen");
  assert.equal(open.args.scope, "inspect");
  const seen = [];
  inspection.on((method) => seen.push(method));
  stub.emitEvent("engine.cliDevTools", { session: nextSession, method: "Audits.issueAdded", params: {} });
  await settle();
  assert.deepEqual(seen, ["Audits.issueAdded"]);
  await inspection.close();
  assert.ok(asks.some((a) => a.call === "cliDevToolsClose"));
});

test("tab operations hand the engine the tab, the connection's owner and only checked values", async () => {
  const tab = await aTab();
  const client = socketClient(541);
  asks.length = 0;
  await client.ok("tabs.snapshot", { tab, maxRefs: 50, interactiveOnly: true });
  await client.ok("tabs.waitSettled", { tab, timeoutMs: 2000, quietMs: 100 });
  await client.ok("tabs.hitTest", { tab, ref: "e3" });
  const blocked = await client.ok("tabs.click", { tab, ref: "e9" });
  assert.equal(blocked.clicked, false);
  await client.ok("tabs.click", { tab, x: 10, y: 20, button: "right" });
  await client.ok("tabs.screenshot", { tab, format: "png", clip: { x: 0, y: 0, width: 10, height: 10 } });
  assert.deepEqual(
    asks.map((a) => a.call),
    ["cliSnapshot", "cliWaitSettled", "cliHitTest", "cliClick", "cliClick", "cliScreenshot"],
  );
  for (const ask of asks.slice(0, 5)) assert.match(ask.args.owner, /c541$/);
  assert.equal(asks[0].args.tabId, tab);
  for (const params of [{ tab, ref: "e3", x: 1, y: 2 }, { tab }, { tab, x: 1 }, { tab, ref: "button" }, { tab, ref: "e3", clickCount: 4 }]) {
    const before = asks.length;
    const reply = await client.call("tabs.click", params);
    assert.ok(reply.error, JSON.stringify(params));
    assert.equal(asks.length, before, `${JSON.stringify(params)} never reached the engine`);
  }
  stub.emitControlClose(541);
});

test("every shared hostile input as a DevTools or tab-operation param is refused before the engine sees it", async () => {
  const tab = await aTab();
  const client = socketClient(551);
  const { session } = await client.ok("devtools.attach", { tab });
  asks.length = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    if (value === undefined) continue;
    const method = await client.call("devtools.send", { session, method: value });
    if (!(typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value))) assert.ok(method.error, `method ${id}`);
    const child = await client.call("devtools.send", { session, method: "Page.reload", sessionId: value });
    if (!(typeof value === "string" && /^[A-Za-z0-9]{1,128}$/.test(value))) assert.ok(child.error, `sessionId ${id}`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      assert.ok((await client.call("devtools.send", { session, method: "Page.reload", params: value })).error, `params ${id}`);
    }
    if (!(typeof value === "string" && /^e[0-9]{1,9}$/.test(value))) assert.ok((await client.call("tabs.click", { tab, ref: value })).error, `ref ${id}`);
    if (!(typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100000)) {
      assert.ok((await client.call("tabs.hitTest", { tab, x: value, y: 1 })).error, `x ${id}`);
    }
    assert.ok((await client.call("tabs.snapshot", { tab: value })).error, `tab ${id}`);
    if (!(Number.isSafeInteger(value) && value >= 1 && value <= 2000)) assert.ok((await client.call("tabs.snapshot", { tab, maxRefs: value })).error, `maxRefs ${id}`);
  }
  const reached = asks.filter((a) => a.call !== "cliDevToolsSend" || /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9_]{0,63}$/.test(a.args.method));
  assert.equal(reached.length, asks.length, "only well-formed requests reached the engine");
  stub.emitControlClose(551);
});

test("turning control off cancels every engine operation and session, not only the connections it knew", async () => {
  const tab = await aTab();
  const client = socketClient(561);
  await client.ok("devtools.attach", { tab });
  asks.length = 0;
  S().updateSettings({ cliControl: false });
  await settle();
  assert.ok(asks.some((a) => a.call === "cliCancel" && a.args.all === true), "the engine is asked to cancel everything");
  assert.equal(liveEngineSessions(), 0);
});

test("an attach that answers after control went off is closed in the engine and never handed out", async () => {
  const { tab } = await freshWindow("https://one.example/");
  const client = socketClient(571);
  let answer;
  const previous = answers.cliDevToolsOpen;
  answers.cliDevToolsOpen = (args) => new Promise((resolve) => (answer = () => resolve({ session: 9001, targetId: "T", scope: args.scope })));
  asks.length = 0;
  const pending = client.call("devtools.attach", { tab });
  await settle();
  S().updateSettings({ cliControl: false });
  await settle();
  answer();
  await settle();
  answers.cliDevToolsOpen = previous;
  assert.equal(liveEngineSessions(), 0, "the late session isn't kept");
  assert.ok(asks.some((a) => a.call === "cliDevToolsClose" && a.args.session === 9001), "the engine is told to close it");
  void pending;
});

test("an inspection session ends when the engine closes its native session", async () => {
  const { tab } = await freshWindow("https://one.example/");
  const inspection = await openInspection(tab, 581);
  assert.equal(inspection.isClosed, false);
  stub.emitEvent("engine.cliDevTools", { session: nextSession, closed: "tab-closed" });
  await settle();
  await inspection.ended;
  assert.equal(inspection.isClosed, true, "a dead session never looks open again");
});

test("an inspection session hears when the engine cut or dropped its events, so a trace reports truncated", async () => {
  const { tab } = await freshWindow("https://one.example/");
  const inspection = await openInspection(tab, 591);
  const seen = [];
  inspection.on((method) => seen.push(method));
  stub.emitEvent("engine.cliDevTools", { session: nextSession, method: "Tracing.dataCollected", cut: true, bytes: 20_000_000 });
  stub.emitEvent("engine.cliDevTools", { session: nextSession, method: "Tracing.dataCollected", params: { value: [] }, dropped: 3 });
  await settle();
  assert.deepEqual(seen, ["Ardia.transportLoss", "Ardia.transportLoss", "Tracing.dataCollected"]);
  await inspection.close();
});
