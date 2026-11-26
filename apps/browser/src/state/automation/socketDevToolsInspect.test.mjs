import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { S, freshWindow, socketClient, tick } from "./fixtures/socketHarness.mjs";

const stub = await import("../../test-native/index.ts");
const { setInspectionTransport, liveInspectionSessions, UNAVAILABLE } = await import("./devToolsSession.ts");
const { heldLogpointSessions } = await import("./devToolsLogpoints.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/devtools/${name}`, import.meta.url), "utf8"));
const TRACE = fixture("trace-load.json");
const ISSUES = fixture("audits-issues.json");
const CSS = fixture("css-matched.json");

const MAP = {
  version: 3,
  sources: ["webpack:///src/cart.ts"],
  names: ["addToCart"],
  mappings: "AAAA,cAWE",
};
const INLINE_MAP = `data:application/json;base64,${Buffer.from(JSON.stringify(MAP)).toString("base64")}`;

function scriptedTab(traceEvents = TRACE.traceEvents) {
  const control = { failRemove: false };
  const sent = [];
  const opened = [];
  let breakpoints = 0;
  const reply = (method, params, emit) => {
    switch (method) {
      case "Tracing.end":
        setTimeout(() => {
          emit("Tracing.dataCollected", { value: traceEvents.slice(0, 20) });
          emit("Tracing.dataCollected", { value: traceEvents.slice(20) });
          emit("Tracing.tracingComplete", { dataLossOccurred: false });
        }, 0);
        return {};
      case "Audits.enable":
        setTimeout(() => ISSUES.forEach((issue) => emit("Audits.issueAdded", issue)), 0);
        return {};
      case "CSS.enable":
        emit("CSS.styleSheetAdded", { header: { styleSheetId: "S1", sourceURL: "https://shop.example/site.css", origin: "regular", startLine: 0, startColumn: 0, isInline: false } });
        emit("CSS.styleSheetAdded", { header: { styleSheetId: "S2", sourceURL: "https://shop.example/", origin: "regular", startLine: 10, startColumn: 4, isInline: true } });
        return {};
      case "DOM.getDocument":
        return { root: { nodeId: 1, nodeName: "#document" } };
      case "DOM.querySelector":
        if (params.selector === "#none") return { nodeId: 0 };
        if (params.selector.includes("[[")) throw new Error("DOM Error while querying");
        return { nodeId: 5 };
      case "CSS.getMatchedStylesForNode":
        return CSS.matched;
      case "CSS.getComputedStyleForNode":
        return CSS.computed;
      case "Debugger.enable":
        emit("Debugger.scriptParsed", { scriptId: "9", url: "https://shop.example/assets/app.min.js", sourceMapURL: INLINE_MAP, startLine: 0, endLine: 1 });
        emit("Debugger.scriptParsed", { scriptId: "10", url: "https://shop.example/plain.js", sourceMapURL: "" });
        emit("Debugger.scriptParsed", { scriptId: "11", url: "https://shop.example/assets/app.min.js", sourceMapURL: "" });
        return { debuggerId: "d1" };
      case "Debugger.setBreakpoint":
        return { breakpointId: `bp-${++breakpoints}`, actualLocation: params.location };
      case "Debugger.removeBreakpoint":
        if (control.failRemove) throw new Error("No breakpoint for given id found");
        return {};
      case "Debugger.setBreakpointByUrl":
        if (params.url.endsWith("refused.js")) throw new Error("bad location");
        return { breakpointId: `bp-${++breakpoints}`, locations: params.url.endsWith("app.min.js") ? [{ scriptId: "9", lineNumber: params.lineNumber, columnNumber: params.columnNumber ?? 0 }] : [] };
      default:
        return {};
    }
  };
  const opener = async (tabId) => {
    let listener = null;
    const transport = { tabId, closed: false };
    opened.push(transport);
    return {
      async send(method, params) {
        sent.push({ tabId, method, params });
        return reply(method, params, (m, p) => listener?.(m, p));
      },
      onEvent(next) {
        listener = next;
        return () => (listener = null);
      },
      async close() {
        transport.closed = true;
      },
    };
  };
  return { sent, opened, opener, control, methods: () => sent.map((s) => s.method) };
}

let slowIds = 0;

async function slow(connection, method, params) {
  const before = stub.controlSocket.replies.length;
  const id = `slow-${++slowIds}`;
  stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const reply = stub.controlSocket.replies.slice(before).find((r) => r.connection === connection && JSON.parse(r.line).id === id);
    if (reply) return JSON.parse(reply.line);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no reply to ${method}`);
}

const slowOk = async (connection, method, params) => {
  const reply = await slow(connection, method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

test("devtools methods are listed in their own family and say plainly when the engine can't open a session", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  const client = socketClient(41);
  const names = (await client.ok("methods")).filter((m) => m.area === "devtools").map((m) => m.name);
  assert.deepEqual(names.sort(), ["devtools.attach", "devtools.batch", "devtools.causeChainFunction", "devtools.clearLogpoint", "devtools.detach", "devtools.issues", "devtools.logpoint", "devtools.logpoints", "devtools.perfInsight", "devtools.perfTrace", "devtools.send", "devtools.sessions", "devtools.stackTrace", "devtools.styles"]);
  setInspectionTransport(null);
  const reply = await client.call("devtools.perfTrace", { tab, durationMs: 250 });
  assert.deepEqual(reply.error, { code: "failed", message: UNAVAILABLE });
});

test("devtools.perfTrace records in its own session, answers insights, keeps field data off and closes the session", async () => {
  setConsentPeriod(true, "devtools-socket-test");
  const { tab } = await freshWindow("https://shop.example/");
  const client = socketClient(42);
  const scripted = scriptedTab();
  setInspectionTransport(scripted.opener);
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ record: { metrics: {} } }) };
  };
  takeCliCounts();
  try {
    const result = await slowOk(42, "devtools.perfTrace", { tab, durationMs: 250 });
    assert.equal(result.metrics.lcp.ms, 2600);
    assert.equal(result.complete, true);
    assert.equal(result.fieldData, null);
    assert.deepEqual(fetched, [], "no field data request unless asked");
    assert.deepEqual(scripted.methods(), ["Tracing.start", "Tracing.end"]);
    assert.ok(scripted.opened.every((t) => t.closed));
    assert.equal(liveInspectionSessions(), 0);
    const only = await slowOk(42, "devtools.perfTrace", { tab, durationMs: 250, insight: "cls-culprits" });
    assert.deepEqual(only.insights.map((i) => i.id), ["cls-culprits"]);
    assert.equal((await slow(42, "devtools.perfTrace", { tab, durationMs: 250, includeFieldData: true })).error.code, "bad_request");
    const withField = await slowOk(42, "devtools.perfTrace", { tab, durationMs: 250, includeFieldData: true, fieldDataKey: "AIzaFixtureKey_123" });
    assert.deepEqual(fetched.map((f) => f.body.origin), ["https://shop.example"]);
    assert.equal(withField.fieldData.origin, "https://shop.example");
    assert.equal((await slow(42, "devtools.perfTrace", { tab, durationMs: 250, reload: true })).error.code, "refused");
    globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
    await slowOk(42, "devtools.perfTrace", { tab, durationMs: 250, reload: true });
    assert.ok(scripted.methods().includes("Page.reload"));
    assert.ok(scripted.methods().every((m) => !/^(Emulation|Network)\./.test(m)), "no override is ever sent");
    const counts = takeCliCounts();
    assert.equal(counts.cli_devtools_traces, 4);
    assert.equal(counts.cli_devtools_field_data_requests, 1);
    assert.ok(counts.cli_socket_calls_devtools >= 6);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.acTestCliOwns;
  }
});

test("devtools.perfInsight analyses a trace it's given and refuses anything else", async () => {
  await freshWindow();
  const client = socketClient(43);
  const result = await client.ok("devtools.perfInsight", { trace: TRACE });
  assert.equal(result.metrics.cls.value, 0.13);
  assert.equal(result.rating, "needs-improvement");
  assert.equal((await client.call("devtools.perfInsight", { trace: { nope: 1 } })).error.code, "bad_request");
  assert.equal((await client.call("devtools.perfInsight", { trace: "x" })).error.code, "bad_request");
});

test("devtools.issues reads a tab's DevTools Issues once and explains given payloads", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  const client = socketClient(44);
  const scripted = scriptedTab();
  setInspectionTransport(scripted.opener);
  const live = await client.ok("devtools.issues", { tab, waitMs: 0 });
  assert.equal(live.tab, tab);
  assert.equal(live.issues.length, 7);
  assert.deepEqual(scripted.methods(), ["Audits.enable", "Audits.disable"]);
  const offline = await client.ok("devtools.issues", { issues: ISSUES.slice(3, 5) });
  assert.deepEqual(offline.issues.map((i) => i.kind), ["cors", "csp"]);
  assert.equal((await client.call("devtools.issues", { tab, issues: [] })).error.code, "bad_request");
  assert.equal((await client.call("devtools.issues", {})).error.code, "bad_request");
});

test("devtools.styles answers the winning declarations and refuses bad selectors and property names", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  const client = socketClient(45);
  const scripted = scriptedTab();
  setInspectionTransport(scripted.opener);
  const result = await client.ok("devtools.styles", { tab, selector: "#buy", properties: ["color", "font-size"] });
  assert.deepEqual(result.properties.map((p) => [p.property, p.winner.value, p.winner.selector]), [["color", "green", ".cta"], ["font-size", "18px", "body"]]);
  assert.equal(result.properties[0].winner.source.url, "https://shop.example/");
  const declared = await client.ok("devtools.styles", { tab, selector: "#buy" });
  assert.deepEqual(declared.properties.map((p) => p.property), ["color", "padding", "margin"]);
  assert.equal((await client.call("devtools.styles", { tab, selector: "#none" })).error.code, "failed");
  assert.equal((await client.call("devtools.styles", { tab, selector: "a[[" })).error.code, "bad_request");
  assert.equal((await client.call("devtools.styles", { tab, selector: "  " })).error.code, "bad_request");
  assert.equal((await client.call("devtools.styles", { tab, selector: "a", properties: ["color;background:red"] })).error.code, "bad_request");
  assert.equal(liveInspectionSessions(), 0);
  const order = scripted.methods();
  assert.deepEqual(order.slice(0, 6), ["DOM.enable", "CSS.enable", "DOM.getDocument", "DOM.querySelector", "CSS.getMatchedStylesForNode", "CSS.getComputedStyleForNode"]);
  assert.deepEqual(order.slice(6, 8), ["CSS.disable", "DOM.disable"]);
});

test("devtools.stackTrace maps a cause chain through a given source map without fetching", async () => {
  await freshWindow();
  const client = socketClient(46);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("source maps never go to the network");
  try {
    const stack = "Error: no stock\n    at addToCart (https://shop.example/assets/app.min.js:1:15)";
    const result = await client.ok("devtools.stackTrace", { error: { message: "no stock", stack, cause: { name: "HttpError", message: "409", stack: "HttpError: 409\n    at https://shop.example/assets/app.min.js:1:2" } }, sourceMaps: { "https://shop.example/assets/app.min.js": MAP } });
    assert.deepEqual(result.chain.map((l) => [l.name, l.frames[0].original?.source, l.frames[0].original?.line]), [["Error", "webpack:///src/cart.ts", 12], ["HttpError", "webpack:///src/cart.ts", 1]]);
    assert.equal(result.sourceMaps.resolved, 1);
    assert.equal((await client.call("devtools.stackTrace", { error: {} })).error.code, "bad_request");
    const fn = await client.ok("devtools.causeChainFunction");
    assert.match(fn.functionDeclaration, /^function\(\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("logpoints go only on tabs the command opened, map original sources, and end with the connection", async () => {
  setConsentPeriod(true, "devtools-socket-test");
  const { tab } = await freshWindow("https://shop.example/");
  const client = socketClient(47);
  const scripted = scriptedTab();
  setInspectionTransport(scripted.opener);
  takeCliCounts();
  const refused = await client.call("devtools.logpoint", { tab, url: "src/cart.ts", line: 12, expression: "cart.total" });
  assert.equal(refused.error.code, "refused");
  assert.equal(scripted.sent.length, 0, "nothing reaches an unowned tab");
  globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
  try {
    const mapped = await slowOk(47, "devtools.logpoint", { tab, url: "src/cart.ts", line: 12, expression: "cart.total", condition: "cart.total > 0" });
    assert.deepEqual([mapped.url, mapped.line, mapped.column, mapped.bound, mapped.matchedScript], ["https://shop.example/assets/app.min.js", 1, 15, true, true]);
    assert.deepEqual(mapped.original, { source: "src/cart.ts", line: 12, column: null });
    const set = scripted.sent.find((s) => s.method === "Debugger.setBreakpoint");
    assert.deepEqual(set.params.location, { scriptId: "9", lineNumber: 0, columnNumber: 14 }, "bound to the mapped script, not every script sharing its URL");
    assert.equal(scripted.sent.filter((s) => s.method === "Debugger.setBreakpointByUrl").length, 0);
    assert.match(set.params.condition, /return false; \}\)\(\)$/);
    const direct = await slowOk(47, "devtools.logpoint", { tab, url: "https://shop.example/plain.js", line: 3, expression: "1" });
    assert.equal(direct.pending, true);
    assert.equal(scripted.methods().filter((m) => m === "Debugger.enable").length, 1, "one session per tab and connection");
    assert.deepEqual((await client.ok("devtools.logpoints")).map((l) => l.id), [mapped.id, direct.id]);
    assert.deepEqual(await socketClient(48).ok("devtools.logpoints"), [], "another connection sees none of them");
    assert.equal((await socketClient(48).call("devtools.clearLogpoint", { id: mapped.id })).error.code, "bad_request");
    scripted.control.failRemove = true;
    assert.equal((await client.call("devtools.clearLogpoint", { id: mapped.id })).error.code, "failed", "a removal the tab refused isn't reported as cleared");
    assert.ok((await client.ok("devtools.logpoints")).some((l) => l.id === mapped.id), "it stays listed so it can be retried");
    scripted.control.failRemove = false;
    assert.deepEqual(await client.ok("devtools.clearLogpoint", { id: mapped.id }), { cleared: 1 });
    assert.equal((await slow(47, "devtools.logpoint", { tab, url: "x.js", line: 1, expression: "" })).error.code, "bad_request");
    assert.equal(heldLogpointSessions(), 1);
    stub.emitControlClose(47);
    await settle();
    assert.equal(heldLogpointSessions(), 0);
    assert.equal(liveInspectionSessions(), 0);
    const tail = scripted.methods().slice(-2);
    assert.deepEqual(tail, ["Debugger.removeBreakpoint", "Debugger.disable"]);
    assert.ok(scripted.opened.every((t) => t.closed));
    const counts = takeCliCounts();
    assert.equal(counts.cli_devtools_logpoints_set, 2);
    assert.equal(counts.cli_devtools_logpoints_refused, 1);
  } finally {
    delete globalThis.acTestCliOwns;
    setInspectionTransport(null);
  }
  assert.equal(S().tabs[tab].id, tab);
});

test("closing the connection mid-trace ends the session at once, and field data follows the page the trace ended on", async () => {
  setConsentPeriod(true, "devtools-socket-test");
  const { tab } = await freshWindow("https://shop.example/");
  const scripted = scriptedTab();
  setInspectionTransport(scripted.opener);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("no field data for a page that changed origin");
  try {
    const before = stub.controlSocket.replies.length;
    stub.emitControlRequest({ connection: 49, generation: stub.controlSocket.generation, line: JSON.stringify({ id: 1, method: "devtools.perfTrace", params: { tab, durationMs: 30000 } }) });
    await settle();
    assert.equal(liveInspectionSessions(), 1);
    stub.emitControlClose(49);
    await settle();
    assert.equal(liveInspectionSessions(), 0, "the 30-second trace didn't keep running");
    assert.ok(scripted.opened.every((t) => t.closed));
    assert.ok(scripted.methods().includes("Tracing.end"));
    assert.equal(stub.controlSocket.replies.slice(before).filter((r) => r.connection === 49 && !JSON.parse(r.line).error).length, 0);
    const moving = scriptedTab();
    setInspectionTransport(async (tabId) => {
      const transport = await moving.opener(tabId);
      S().updateTab(tabId, { url: "https://elsewhere.example/" });
      return transport;
    });
    const result = await slowOk(50, "devtools.perfTrace", { tab, durationMs: 250, includeFieldData: true, fieldDataKey: "AIzaFixtureKey_123" });
    assert.match(result.fieldData.skipped, /changed origin|no longer/);
  } finally {
    globalThis.fetch = realFetch;
    setInspectionTransport(null);
  }
});

test("a refused first logpoint closes its session, and concurrent logpoints can't pass the per-connection cap", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  const scripted = scriptedTab();
  setInspectionTransport(scripted.opener);
  globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
  try {
    const refused = await slow(51, "devtools.logpoint", { tab, url: "https://shop.example/refused.js", line: 1, expression: "1" });
    assert.equal(refused.error.code, "failed");
    assert.equal(heldLogpointSessions(), 0);
    assert.equal(liveInspectionSessions(), 0, "an empty logpoint session isn't left open");
    const { MAX_LOGPOINTS_PER_CONNECTION } = await import("./devToolsLogpoints.ts");
    const asks = Array.from({ length: MAX_LOGPOINTS_PER_CONNECTION + 5 }, (_, i) => slow(52, "devtools.logpoint", { tab, url: "https://shop.example/plain.js", line: i + 1, expression: "1" }));
    const replies = await Promise.all(asks);
    assert.equal(replies.filter((r) => !r.error).length, MAX_LOGPOINTS_PER_CONNECTION);
    assert.equal(replies.filter((r) => r.error?.code === "refused").length, 5);
    stub.emitControlClose(52);
    await settle();
    assert.equal(liveInspectionSessions(), 0);
  } finally {
    delete globalThis.acTestCliOwns;
    setInspectionTransport(null);
  }
});

test("field data is never asked for a trace with no page load to tie it to", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  const scripted = scriptedTab(TRACE.traceEvents.filter((e) => e.name !== "navigationStart"));
  setInspectionTransport(scripted.opener);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("no unattributed field data request");
  try {
    const result = await slowOk(53, "devtools.perfTrace", { tab, durationMs: 250, includeFieldData: true, fieldDataKey: "AIzaFixtureKey_123" });
    assert.equal(result.navigation, null);
    assert.match(result.fieldData.skipped, /no page load/);
  } finally {
    globalThis.fetch = realFetch;
    setInspectionTransport(null);
  }
});
