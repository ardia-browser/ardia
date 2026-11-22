import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { ensureRoots } = await import("../bookmarks/bookmarks.ts");
const { replyLine } = await import("./controlSocket.ts");
const { noteCommit } = await import("./automationEvents.ts");
const { requestDecision } = await import("./decideSocket.ts");
const { LINE_BYTE_LIMIT, DROPPED_MARKER_ROOM, fittedEvent } = await import("./socketWire.ts");
const { reloadHooks, useHookRules } = await import("./hookRules.ts");
const { approveRule, resetApprovalsForTests } = await import("./approvals.ts");
const { approvalFor } = await import("./hookPolicy.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

const { call, ok } = socketClient(41);
const bytes = (line) => Buffer.byteLength(line, "utf8") + 1;
const lines = (connection, from) => stub.controlSocket.broadcasts.slice(from).filter((b) => b.connections.includes(connection)).map((b) => b.line);
const hugeUrl = (n = LINE_BYTE_LIMIT + 4096) => `https://big.example/?q=${"a".repeat(n)}`;

test("a read reply over 1 MiB goes out as a failed error that fits and says what to narrow", () => {
  const line = replyLine(7, { result: "x".repeat(LINE_BYTE_LIMIT + 10) }, "tabs.list");
  assert.ok(bytes(line) <= LINE_BYTE_LIMIT);
  const reply = JSON.parse(line);
  assert.equal(reply.id, 7);
  assert.equal(reply.error.code, "failed");
  assert.match(reply.error.message, /over 1 MiB/);
  const wide = replyLine(9, { result: "é".repeat(Math.ceil(LINE_BYTE_LIMIT / 2) + 10) }, "tabs.list");
  assert.equal(JSON.parse(wide).error.code, "failed");
  assert.equal(JSON.parse(replyLine(8, { result: "small" }, "tabs.list")).result, "small");
});

test("a write's reply over 1 MiB still says the write happened, compactly", () => {
  const results = Array.from({ length: 40 }, (_, i) => ({ i, title: "t".repeat(40_000) }));
  const line = replyLine(5, { result: { ok: true, applied: 40, results } }, "apply");
  assert.ok(bytes(line) <= LINE_BYTE_LIMIT);
  const reply = JSON.parse(line);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.ok, true);
  assert.equal(reply.result.oversized, true);
  assert.equal(reply.result.applied, 40);
  assert.deepEqual(reply.result.results, { count: 40 });
  const tool = JSON.parse(replyLine(6, { result: "r".repeat(LINE_BYTE_LIMIT * 2) }, "plugins.call"));
  assert.equal(tool.result.ok, true);
  assert.equal(tool.result.oversized, true);
});

test("paged reads stop well inside 1 MiB and say where to go on", async () => {
  await freshWindow();
  useBrowser.setState((s) => ({ bookmarks: ensureRoots(s.bookmarks, "")[0], bookmarksReady: { "": true } }));
  for (let i = 0; i < 200; i++) await ok("bookmarks.add", { url: `https://b${i}.example/?q=${"b".repeat(8000)}`, title: `B${i}` });
  const before = stub.controlSocket.replies.length;
  const first = await ok("bookmarks.search", { query: "example", limit: 1000 });
  assert.ok(bytes(stub.controlSocket.replies[before].line) <= LINE_BYTE_LIMIT);
  assert.ok(first.items.length > 0 && first.items.length < 200);
  assert.equal(first.nextOffset, first.items.length);
  assert.equal(first.total, 200);
  const rest = await ok("bookmarks.search", { query: "example", limit: 1000, offset: first.nextOffset });
  assert.equal(rest.items[0].id === first.items.at(-1).id, false);

  const db = stub.chromeHistory("");
  db.clear();
  db.set(hugeUrl(), { title: "Huge", visits: [5] });
  const history = await ok("history.search", {});
  assert.deepEqual(history.items[0].clipped, ["url"]);
  assert.ok(history.items[0].url.length < LINE_BYTE_LIMIT);
});

test("an event over 1 MiB goes out summarized instead of whole", async () => {
  const { tab } = await freshWindow();
  await ok("subscribe", { events: ["tab.navigated"], fullUrls: true });
  const from = stub.controlSocket.broadcasts.length;
  noteCommit(tab, hugeUrl(), Date.now());
  for (let i = 0; i < 20 && !lines(41, from).length; i++) await new Promise((r) => setTimeout(r, 5));
  const sent = lines(41, from);
  assert.ok(sent.length > 0, "the event went out");
  for (const line of sent) assert.ok(bytes(line) <= LINE_BYTE_LIMIT, `${bytes(line)} bytes`);
  const event = JSON.parse(sent[0]);
  assert.equal(event.event, "tab.navigated");
  assert.equal(event.data.truncated, true);
  await ok("subscribe", { events: [] });
});

test("a decide request over 1 MiB isn't sent, and Ardia goes on as if nobody answered", async () => {
  const hooks = [{ name: "prog", on: "tab.opening", run: ["~/bin/decide"] }];
  await freshWindow();
  resetApprovalsForTests();
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks }));
  reloadHooks();
  const hook = useHookRules.getState().hooks[0];
  approveRule(approvalFor(hook).key);
  assert.deepEqual((await ok("subscribe", { events: [], hooks })).served, ["prog"]);
  const from = stub.controlSocket.broadcasts.length;
  const started = Date.now();
  const answer = await requestDecision(hook, "tab.opening", { url: "https://big.example/", title: "t".repeat(LINE_BYTE_LIMIT) }, 250);
  assert.equal(answer, undefined);
  assert.ok(Date.now() - started < 200, "it didn't wait for the deadline");
  assert.deepEqual(lines(41, from), [], "nothing was sent");
  await ok("subscribe", { events: [], hooks: null });
  stub.configFolder.files.delete("hooks.json");
  reloadHooks();
});

test("lines are measured as sent: escaped JSON plus the newline, and events leave room for the dropped marker", async () => {
  const control = "\u0001".repeat(200_000);
  const quotes = '"'.repeat(600_000);
  for (const text of [control, quotes]) {
    assert.ok(Buffer.byteLength(text) < LINE_BYTE_LIMIT, "the raw text is under the limit");
    const reply = replyLine(1, { result: text }, "tabs.get");
    assert.ok(bytes(reply) <= LINE_BYTE_LIMIT, `reply ${bytes(reply)}`);
    assert.equal(JSON.parse(reply).error.code, "failed", "escaped, it's over, so it was refit");
    const write = replyLine(2, { result: { ok: true, note: text } }, "apply");
    assert.ok(bytes(write) <= LINE_BYTE_LIMIT);
    assert.equal(JSON.parse(write).result.oversized, true);
    const event = fittedEvent("history.removed", 1, { urls: [text] }, null);
    assert.ok(bytes(event) + DROPPED_MARKER_ROOM <= LINE_BYTE_LIMIT, `event ${bytes(event)}`);
    assert.equal(JSON.parse(event).data.truncated, true);
  }
  const envelope = JSON.stringify({ id: 3, result: "" }).length;
  const exact = replyLine(3, { result: "x".repeat(LINE_BYTE_LIMIT - envelope) }, "tabs.get");
  assert.equal(JSON.parse(exact).error?.code, "failed", "a line of exactly 1 MiB is over once its newline is added");
  const fits = replyLine(4, { result: "x".repeat(LINE_BYTE_LIMIT - envelope - 1) }, "tabs.get");
  assert.equal(bytes(fits), LINE_BYTE_LIMIT, "a reply whose frame is exactly 1 MiB goes out whole");
  const nearEvent = fittedEvent("tab.navigated", 1, { url: "y".repeat(LINE_BYTE_LIMIT - 100) }, null);
  assert.equal(JSON.parse(nearEvent).data.truncated, true, "an event too big to take the marker is summarized");
});

test("every reply, event and decide line the socket sends fits in 1 MiB with its newline", async () => {
  const { tab } = await freshWindow();
  const from = stub.controlSocket.replies.length;
  const fromBroadcast = stub.controlSocket.broadcasts.length;
  await ok("subscribe", { events: ["tab.navigated"], fullUrls: true });
  noteCommit(tab, `https://big.example/${"\u0001".repeat(300_000)}`, Date.now());
  await new Promise((r) => setTimeout(r, 20));
  await call("tabs.list", {});
  await call("methods", {});
  const sent = [...stub.controlSocket.replies.slice(from), ...stub.controlSocket.broadcasts.slice(fromBroadcast)].map((r) => r.line);
  assert.ok(sent.length >= 3);
  for (const line of sent) assert.ok(bytes(line) <= LINE_BYTE_LIMIT, `${bytes(line)} bytes`);
  await ok("subscribe", { events: [] });
});
