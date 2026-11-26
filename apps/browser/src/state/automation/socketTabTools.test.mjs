import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const stub = await import("../../test-native/index.ts");

setConsentPeriod(true, "socket-tab-tools-test");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;
const CONNECTION = 41;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: CONNECTION, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === CONNECTION); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === CONNECTION);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

async function setup(t) {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  const tab = S().windows[windowId].activeTabIds[S().windows[windowId].profileId];
  const diagnostics = [];
  const inputs = [];
  globalThis.acTestTabDiagnostics = (args) => {
    diagnostics.push(args);
    return globalThis.acTestTabDiagnosticsReply?.(args) ?? { ok: true, console: [], network: [], nextSeq: 1, clearedBefore: 1, capacity: { console: 200, network: 250 } };
  };
  globalThis.acTestTabInput = (args) => {
    if (args.prime) return globalThis.acTestTabPrimeReply?.(args) ?? { ok: true, painted: true, token: 7 };
    assert.equal(args.token, globalThis.acTestTabPrimeReply ? undefined : 7, "the send carries the prime's token");
    inputs.push(args);
    return globalThis.acTestTabInputReply?.(args) ?? { ok: true, acked: true, viewport: { width: 800, height: 600 } };
  };
  t.after(() => {
    delete globalThis.acTestTabDiagnostics;
    delete globalThis.acTestTabInput;
    delete globalThis.acTestTabDiagnosticsReply;
    delete globalThis.acTestTabInputReply;
    delete globalThis.acTestTabPrimeReply;
  });
  takeCliCounts();
  return { tab, diagnostics, inputs };
}

test("methods lists both on macOS, each with a closed params schema", async (t) => {
  await setup(t);
  const listed = (await ok("methods")).filter((m) => m.name === "tabs.diagnostics" || m.name === "tabs.input");
  assert.deepEqual(listed.map((m) => [m.name, m.mutates]).sort(), [["tabs.diagnostics", true], ["tabs.input", true]]);
  for (const m of listed) assert.equal(m.params.additionalProperties, false);
});

test("diagnostics redacts, filters and moves the watermark; clear forgets only what was read", async (t) => {
  const { tab, diagnostics } = await setup(t);
  globalThis.acTestTabDiagnosticsReply = ({ since }) =>
    since >= 4
      ? { ok: true, console: [], network: [], nextSeq: 4, clearedBefore: 4, capacity: { console: 200, network: 250 } }
      : {
          ok: true,
          console: [{ seq: 2, time: 5, level: "error", message: "Uncaught (in promise) token=abc123", source: "https://a.example/a.js?k=1", line: 3, frame: "main" }],
          network: [{ seq: 3, time: 6, method: "GET", url: "https://a.example/missing?q=secret", status: 0, type: "fetch", frame: "main", error: "ERR_NAME_NOT_RESOLVED", failed: true, durationMs: 12 }],
          nextSeq: 4,
          clearedBefore: 1,
          capacity: { console: 200, network: 250 },
        };
  const read = await ok("tabs.diagnostics", { tab, onlyErrors: true, clear: true });
  assert.equal(read.tab, tab);
  assert.equal(read.cleared, true);
  assert.equal(read.nextSeq, 4);
  assert.equal(read.dropped, 1, "seq 1 left the ring before it was read");
  assert.deepEqual(read.console.map((e) => [e.kind, e.message, e.source]), [["rejection", "Uncaught (in promise) token=[redacted]", "https://a.example/a.js"]]);
  assert.deepEqual(read.network.map((e) => [e.url, e.error, e.failed]), [["https://a.example/missing", "ERR_NAME_NOT_RESOLVED", true]]);
  assert.deepEqual(
    diagnostics.map(({ tabId, since, clearBefore }) => [tabId, since, clearBefore]),
    [
      [tab, 0, undefined],
      [tab, 4, 4],
    ],
  );
  const counts = takeCliCounts();
  assert.equal(counts.cli_tab_diagnostics_reads, 1);
  assert.equal(counts.cli_tab_diagnostics_gaps, 1);
});

test("private tabs, unknown tabs and bad params are refused before the engine is asked", async (t) => {
  const { tab, diagnostics, inputs } = await setup(t);
  const privateWindow = S().createWindow({ kind: "private", url: "https://p.example/" });
  const privateTab = S().windows[privateWindow].tabIds[0];
  assert.ok(privateTab);
  for (const method of ["tabs.diagnostics", "tabs.input"]) {
    const params = method === "tabs.input" ? { action: "click", x: 1, y: 1 } : {};
    assert.equal((await call(method, { tab: privateTab, ...params })).error.code, "no_window");
    assert.equal((await call(method, { tab: "nope", ...params })).error.code, "no_window");
  }
  assert.equal((await call("tabs.diagnostics", { tab, kind: "logs" })).error.code, "bad_request");
  assert.equal((await call("tabs.diagnostics", { tab, limit: 501 })).error.code, "bad_request");
  assert.equal((await call("tabs.diagnostics", { tab, since: -1 })).error.code, "bad_request");
  assert.equal((await call("tabs.diagnostics", { tab, headers: true })).error.code, "bad_request");
  assert.equal((await call("tabs.input", { tab, action: "tap", x: 1, y: 1 })).error.code, "bad_request");
  assert.equal((await call("tabs.input", { tab, action: "click", x: -5, y: 1 })).error.code, "bad_request");
  assert.equal((await call("tabs.input", { tab, action: "click", x: 1, y: 1, text: "x" })).error.code, "bad_request");
  assert.equal((await call("tabs.input", { tab, action: "text", text: "a\u0000b" })).error.code, "bad_request");
  assert.equal((await call("tabs.input", { tab, action: "key", key: "\n" })).error.code, "bad_request");
  assert.equal((await call("tabs.input", { tab, action: "click", x: 1, y: 1, button: "right" })).error.code, "bad_request");
  assert.deepEqual([diagnostics.length, inputs.length], [0, 0]);
});

test("input reaches the engine checked and normalized, and engine refusals map to socket errors", async (t) => {
  const { tab, inputs } = await setup(t);
  const done = await ok("tabs.input", { tab, action: "click", x: 12.5, y: 40, modifiers: ["meta", "shift"] });
  assert.deepEqual(done, { tab, action: "click", acked: true, viewport: { width: 800, height: 600 } });
  globalThis.acTestTabInputReply = (args) => (args.action === "text" ? { ok: true, acked: false, sent: true, viewport: { width: 800, height: 600 } } : undefined);
  assert.deepEqual(await ok("tabs.input", { tab, action: "text", text: "hello" }), { tab, action: "text", acked: false, sent: true, viewport: { width: 800, height: 600 } });
  delete globalThis.acTestTabInputReply;
  await ok("tabs.input", { tab, action: "key", key: "Enter" });
  assert.deepEqual(
    inputs.map(({ profile, ...rest }) => rest),
    [
      { tabId: tab, action: "click", x: 12.5, y: 40, modifiers: ["shift", "meta"], token: 7 },
      { tabId: tab, action: "text", text: "hello", token: 7 },
      { tabId: tab, action: "key", key: "Enter", token: 7 },
    ],
  );
  globalThis.acTestTabInputReply = () => ({ ok: false, code: "out_of_bounds", reason: "That point is outside the tab's page." });
  const outside = await call("tabs.input", { tab, action: "click", x: 9000, y: 9000 });
  assert.deepEqual([outside.error.code, outside.error.message], ["bad_request", "That point is outside the tab's page."]);
  globalThis.acTestTabInputReply = () => ({ ok: false, code: "no_page", reason: "That tab's page isn't loaded or has no size yet." });
  assert.equal((await call("tabs.input", { tab, action: "move", x: 1, y: 1 })).error.code, "failed");
  globalThis.acTestTabInputReply = () => ({ ok: true, acked: false, viewport: { width: 1, height: 1 } });
  assert.equal((await ok("tabs.input", { tab, action: "wheel", x: 0, y: 0, deltaY: 100 })).acked, false);
  globalThis.acTestTabInputReply = undefined;
  globalThis.acTestTabPrimeReply = () => ({ ok: true, painted: false });
  const unpainted = await call("tabs.input", { tab, action: "click", x: 1, y: 1 });
  assert.deepEqual([unpainted.error.code, /didn't draw a frame/.test(unpainted.error.message)], ["failed", true]);
  delete globalThis.acTestTabPrimeReply;
  globalThis.acTestTabInputReply = () => ({ ok: false, code: "not_painting", reason: "The tab's page stopped drawing after prime, so nothing was sent; try again." });
  const lapsed = await call("tabs.input", { tab, action: "click", x: 3, y: 3 });
  assert.equal(lapsed.error.code, "failed", "a lapse between prime and send is never primed again on its own, so it can't reach another page");
  delete globalThis.acTestTabInputReply;
  assert.equal((await call("tabs.input", { tab, action: "key", key: "ContextMenu" })).error.code, "bad_request");
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_tab_input_click, counts.cli_tab_input_text, counts.cli_tab_input_key, counts.cli_tab_input_wheel], [1, 1, 1, 1]);
  assert.equal(counts.cli_tab_input_refusals, 5);
  assert.equal(counts.cli_tab_input_unacked, 1);
});

test("an engine that can't serve the call answers failed, never a crash", async (t) => {
  const { tab } = await setup(t);
  delete globalThis.acTestTabDiagnostics;
  delete globalThis.acTestTabInput;
  assert.equal((await call("tabs.diagnostics", { tab })).error.code, "failed");
  assert.equal((await call("tabs.input", { tab, action: "click", x: 1, y: 1 })).error.code, "failed");
  assert.equal(takeCliCounts().cli_tab_tools_engine_missing, 2);
});

test("every hostile value sent over the socket reaches the engine only as a checked input, or not at all", async (t) => {
  const { tab, inputs } = await setup(t);
  const bases = [{ action: "click", x: 1, y: 1 }, { action: "key", key: "a" }, { action: "text", text: "ok" }, { action: "wheel", x: 1, y: 1, deltaY: 3 }];
  const fields = ["action", "x", "y", "button", "clickCount", "modifiers", "deltaX", "deltaY", "key", "code", "text"];
  for (const base of bases) {
    for (const field of fields) {
      for (const { value } of HOSTILE_VALUES) {
        const reply = await call("tabs.input", { tab, ...base, [field]: value });
        if (reply.error) assert.equal(reply.error.code, "bad_request", `${field}: ${JSON.stringify(reply.error)}`);
      }
    }
  }
  assert.ok(inputs.length > 0);
  for (const sent of inputs) {
    assert.equal(sent.tabId, tab);
    assert.ok(["click", "dblclick", "move", "down", "up", "wheel", "key", "text"].includes(sent.action));
    for (const key of ["x", "y", "deltaX", "deltaY", "clickCount"]) if (key in sent) assert.ok(Number.isFinite(sent[key]), key);
    if ("button" in sent) assert.ok(["left", "middle"].includes(sent.button));
    if ("modifiers" in sent) assert.ok(sent.modifiers.every((m) => ["shift", "control", "alt", "meta"].includes(m)));
    if ("text" in sent) assert.ok(sent.text.length >= 1 && sent.text.length <= 4096 && !sent.text.includes("\0") && sent.text.isWellFormed());
    if ("key" in sent) assert.ok(sent.key.length <= 32 && !/[\0\n\r\u2028\u2029]/.test(sent.key) && sent.key !== "ContextMenu");
    if ("code" in sent) assert.match(sent.code, /^[A-Z][A-Za-z0-9]{1,31}$/);
    assert.deepEqual(Object.keys(sent).filter((k) => !["tabId", "profile", "action", "x", "y", "button", "clickCount", "modifiers", "deltaX", "deltaY", "key", "code", "text", "token"].includes(k)), []);
  }
});
