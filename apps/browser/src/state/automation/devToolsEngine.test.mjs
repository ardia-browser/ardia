import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const { analyzeTrace, overallRating, MAX_TRACE_EVENTS } = await import("./devToolsInsights.ts");
const { describeIssues, describeIssue } = await import("./devToolsIssues.ts");
const { parseSourceMap, originalPositionFor, generatedPositionFor, sourceMapRefOf, inlineMapText, SourceMapResolver } = await import("./devToolsSourceMaps.ts");
const { chainOf, framesOfStack, resolveChain, CAUSE_CHAIN_FUNCTION } = await import("./devToolsStacks.ts");
const { cascadeFor, declaredProperties, estimateSpecificity, headerOf } = await import("./devToolsCascade.ts");
const { logpointCondition, checkedExpression } = await import("./devToolsLogpoints.ts");
const { InspectionSession, liveInspectionSessions } = await import("./devToolsSession.ts");
const { recordTrace } = await import("./devToolsTrace.ts");
const { fetchFieldData, fieldDataOrigin } = await import("./devToolsFieldData.ts");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/devtools/${name}`, import.meta.url), "utf8"));

test("a page-load trace gives Core Web Vitals, the LCP phases and each insight's culprits", () => {
  const result = analyzeTrace(fixture("trace-load.json"));
  assert.deepEqual(result.navigation, { url: "https://shop.example/", navigationId: "N1" });
  assert.deepEqual(result.metrics, {
    fcp: { ms: 1000, rating: "good" },
    lcp: { ms: 2600, rating: "needs-improvement" },
    ttfb: { ms: 655, rating: "good" },
    tbt: { ms: 170, rating: "good" },
    inp: { ms: 320, rating: "needs-improvement" },
    cls: { value: 0.13, rating: "needs-improvement" },
  });
  const byId = Object.fromEntries(result.insights.map((i) => [i.id, i]));
  assert.deepEqual(byId["lcp-breakdown"].details.phases, { ttfbMs: 655, loadDelayMs: 545, loadDurationMs: 1200, renderDelayMs: 200 });
  assert.equal(byId["lcp-breakdown"].details.element.url, "https://cdn.shop.example/hero.jpg");
  assert.match(byId["lcp-breakdown"].summary, /loadDuration/);
  assert.deepEqual(byId["cls-culprits"].details.culprits.map((c) => [c.atMs, c.score, c.nodeIds]), [[1320, 0.08, [7, 9]], [1500, 0.05, [11]]], "the shift with recent input and the ad frame's shift don't count");
  assert.equal(byId["cls-culprits"].details.culprits[0].likelyCauses[0].kind, "web-font");
  assert.deepEqual(byId["inp-breakdown"].details.phases, { inputDelayMs: 150, processingMs: 130, presentationMs: 40 });
  assert.deepEqual(byId["long-tasks"].details.tasks.map((t) => [t.durationMs, t.attribution?.activity]), [[180, "EvaluateScript"], [90, "FunctionCall"]], "another process's and a worker thread's tasks don't count");
  assert.equal(byId["long-tasks"].details.tasks[1].attribution.functionName, "onBuyClick");
  assert.deepEqual(byId["render-blocking"].details.requests.map((r) => r.url), ["https://shop.example/site.css"]);
  assert.equal(byId["render-blocking"].savingsMs, 220);
  assert.equal(byId["document-latency"].rating, "good");
  assert.equal(byId["network-bottlenecks"].details.slowest[0].url, "https://cdn.shop.example/hero.jpg");
  assert.deepEqual(result.counts, { events: 42, requests: 5, layoutShifts: 3, interactions: 2, longTasks: 2 });
  assert.equal(result.truncated, false);
});

test("each analysis builds a fresh model, so a second trace never sees the first one's events", () => {
  const trace = fixture("trace-load.json");
  const first = analyzeTrace(trace);
  const empty = analyzeTrace({ traceEvents: [] });
  assert.equal(empty.metrics.lcp, null);
  assert.equal(empty.counts.events, 0);
  assert.deepEqual(empty.insights, []);
  assert.deepEqual(analyzeTrace(trace), first);
});

test("hostile trace input never throws and stays bounded", () => {
  const weird = [null, 1, "x", [], { name: 5 }, { name: "RunTask", ts: "nope" }, { name: "LayoutShift", ts: 1, args: { data: { score: Infinity } } }, { name: "__proto__", ts: 2, args: "x" }, { name: "EventTiming", ph: "b", ts: 3, args: { data: { interactionId: -1, duration: 9e99 } } }];
  for (const input of [undefined, null, 42, "trace", { traceEvents: "x" }, weird, { traceEvents: weird }]) {
    const result = analyzeTrace(input);
    assert.equal(typeof result.metrics.cls.value, "number");
  }
  const long = { traceEvents: { length: MAX_TRACE_EVENTS + 1 } };
  assert.equal(analyzeTrace(long).counts.events, 0);
  assert.equal({}.polluted, undefined);
});

const ISSUES = fixture("audits-issues.json");

test("DevTools Issues are explained with a fix and their affected request, element, source and cookie, never a cookie value", () => {
  const { issues, byKind, dropped } = describeIssues(ISSUES);
  assert.equal(dropped, 0);
  assert.deepEqual(byKind, { cookie: 2, cors: 1, csp: 1, "mixed-content": 1, deprecation: 1, other: 1 });
  const cookie = issues.find((i) => i.reasons.includes("ExcludeSameSiteUnspecifiedTreatedAsLax"));
  assert.equal(cookie.severity, "error");
  assert.match(cookie.explanation, /SameSite=Lax/);
  assert.match(cookie.fix, /SameSite=None; Secure/);
  assert.deepEqual(cookie.affected.cookie, { name: "session", domain: "api.shop.example", path: "/" });
  assert.equal(cookie.affected.request.url, "https://api.shop.example/cart");
  assert.ok(!JSON.stringify(issues).includes("s3cr3t-value"), "the raw cookie line never comes back");
  const cors = issues.find((i) => i.kind === "cors");
  assert.match(cors.explanation, /different origin/);
  assert.match(cors.explanation, /https:\/\/evil\.example/);
  const csp = issues.find((i) => i.kind === "csp");
  assert.deepEqual(csp.affected.source, { url: "https://shop.example/", line: 41, column: 8 });
  assert.equal(csp.affected.nodeId, 88);
  assert.equal(issues.find((i) => i.kind === "mixed-content").severity, "error");
  assert.equal(issues[issues.length - 1].severity, "info");
  assert.equal(describeIssue({ issue: { code: "Bad Code!", details: {} } }), null);
  assert.equal(describeIssue("x"), null);
});

function vlq(value) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += chars[digit];
  } while (v > 0);
  return out;
}

function encode(lines) {
  let src = 0, srcLine = 0, srcCol = 0, name = 0;
  return lines
    .map((segments) => {
      let col = 0;
      return segments
        .map(([c, s, l, sc, n]) => {
          let out = vlq(c - col) + vlq(s - src) + vlq(l - srcLine) + vlq(sc - srcCol);
          col = c, src = s, srcLine = l, srcCol = sc;
          if (n !== undefined) out += vlq(n - name), (name = n);
          return out;
        })
        .join(",");
    })
    .join(";");
}

const MINIFIED_MAP = { version: 3, file: "app.min.js", sourceRoot: "", sources: ["webpack:///src/cart.ts", "webpack:///src/util/money.ts"], names: ["addToCart", "formatPrice"], mappings: encode([[[0, 0, 0, 0], [14, 0, 11, 2, 0], [60, 1, 4, 9, 1]], [[0, 1, 20, 0]]]) };

test("a source map maps generated positions back to the original source and original lines forward", () => {
  const map = parseSourceMap(JSON.stringify(MINIFIED_MAP));
  assert.deepEqual(originalPositionFor(map, 0, 20), { source: "webpack:///src/cart.ts", line: 12, column: 3, name: "addToCart" });
  assert.deepEqual(originalPositionFor(map, 0, 75), { source: "webpack:///src/util/money.ts", line: 5, column: 10, name: "formatPrice" });
  assert.equal(originalPositionFor(map, 5, 0), null);
  assert.deepEqual(generatedPositionFor(map, "src/cart.ts", 12, null), { line: 0, column: 14 });
  assert.deepEqual(generatedPositionFor(map, "src/util/money.ts", 21, null), { line: 1, column: 0 });
  assert.equal(generatedPositionFor(map, "src/missing.ts", 1, null), null);
  const index = parseSourceMap({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: MINIFIED_MAP }, { offset: { line: 10, column: 0 }, map: MINIFIED_MAP }] });
  assert.deepEqual(originalPositionFor(index, 10, 20), { source: "webpack:///src/cart.ts", line: 12, column: 3, name: "addToCart" });
  for (const bad of [null, "{", { version: 2 }, { version: 3, mappings: "!!!" }, { version: 3, mappings: "gggggggggggggggggggggggggggggggggggg" }]) assert.equal(parseSourceMap(bad), null);
});

test("a TypeScript-compiled inline source map resolves a thrown error's stack to the .ts line, with its Error.cause chain", async () => {
  const source = ["type Money = number;", "", "export function charge(amount: Money): Money {", "  const fee: Money = amount * 0.03;", "  if (fee > 10) {", '    throw new Error("fee too high", { cause: new RangeError("amount out of range") });', "  }", "  return amount + fee;", "}"].join("\n");
  const out = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, inlineSourceMap: true, inlineSources: true }, fileName: "src/charge.ts" }).outputText;
  const ref = sourceMapRefOf(out);
  assert.match(ref, /^data:application\/json;base64,/);
  const lines = out.split("\n");
  const throwLine = lines.findIndex((l) => l.includes("throw new Error"));
  const throwColumn = lines[throwLine].indexOf("throw") + 1;
  const scriptUrl = "https://shop.example/assets/charge.js";
  const stack = `Error: fee too high\n    at charge (${scriptUrl}:${throwLine + 1}:${throwColumn})\n    at async checkout (${scriptUrl}:40:3)`;
  const chain = chainOf({ error: { name: "Error", message: "fee too high", stack, cause: { name: "RangeError", message: "amount out of range", stack: `RangeError: amount out of range\n    at charge (${scriptUrl}:${throwLine + 1}:${throwColumn + 40})` } } });
  assert.deepEqual(chain.map((l) => [l.name, l.message, l.frames.length]), [["Error", "fee too high", 2], ["RangeError", "amount out of range", 1]]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("source maps never go to the network");
  let resolver;
  let resolved;
  try {
    resolver = new SourceMapResolver({ scripts: { [scriptUrl]: out } });
    resolved = resolveChain(chain, resolver);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(resolved[0].frames[0].original && [resolved[0].frames[0].original.source, resolved[0].frames[0].original.line], ["charge.ts", 6]);
  assert.equal(resolved[0].frames[1].async, "await");
  assert.equal(resolved[1].frames[0].original.line, 6);
  assert.equal(resolver.resolvedCount, 1, "the parsed map is reused for every frame of that script");
});

test("source maps come only from what the caller passes or an inline data: URL, never the network", () => {
  const map = JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" });
  const inline = `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
  assert.equal(inlineMapText(inline), map);
  for (const ref of ["https://shop.example/a.js.map", "a.js.map", "file:///etc/passwd", "javascript:alert(1)", "data:application/json;base64,!!!", "data:text/html;base64,PGI+"]) assert.equal(inlineMapText(ref), null, ref);
  const resolver = new SourceMapResolver({ maps: { "https://shop.example/given.js": inline, "https://shop.example/broken.js": "{" }, scripts: { "https://shop.example/remote.js": "x()\n//# sourceMappingURL=https://shop.example/remote.js.map", "https://shop.example/inline.js": `x()\n//# sourceMappingURL=${inline}` } });
  assert.ok(resolver.mapFor("https://shop.example/given.js"));
  assert.ok(resolver.mapFor("https://shop.example/inline.js"));
  assert.equal(resolver.mapFor("https://shop.example/remote.js"), null);
  assert.equal(resolver.mapFor("https://shop.example/unknown.js"), null);
  assert.equal(resolver.mapFor("https://shop.example/broken.js"), null);
  assert.deepEqual(Object.fromEntries(resolver.failures.map((f) => [f.url.split("/").pop(), f.reason])), { "broken.js": "bad-map", "remote.js": "not-inline", "unknown.js": "no-map" });
});

test("the mappings decoder refuses segments of the wrong length and negative positions", () => {
  const ok = { version: 3, sources: ["a.ts"], names: ["n"], mappings: "AAAA,CAAC,CAACA" };
  assert.ok(parseSourceMap(ok));
  for (const mappings of ["AA", "AAA", "AAAAAA", "AAAA,D", "AAAD", "AADA", "AAAA,ADAA", "AAAAD"]) assert.equal(parseSourceMap({ ...ok, mappings }), null, mappings);
});

test("CDP exception details keep async parents and the stack text parser ignores junk lines", () => {
  const chain = chainOf({
    exceptionDetails: {
      text: "Uncaught",
      exception: { className: "TypeError", description: "TypeError: x is not a function\n    at a (https://s.example/a.js:1:2)" },
      stackTrace: { callFrames: [{ functionName: "a", url: "https://s.example/a.js", lineNumber: 0, columnNumber: 1, scriptId: "1" }], parent: { description: "setTimeout", callFrames: [{ functionName: "", url: "https://s.example/b.js", lineNumber: 4, columnNumber: 9 }] } },
    },
  });
  assert.deepEqual(chain[0].frames, [
    { functionName: "a", url: "https://s.example/a.js", line: 1, column: 2, async: null },
    { functionName: null, url: "https://s.example/b.js", line: 5, column: 10, async: "setTimeout" },
  ]);
  assert.equal(chain[0].message, "x is not a function");
  assert.deepEqual(framesOfStack("junk\n    at <anonymous>\n    at x (y:0:0)\n    at https://a.example/z.js:3:4"), [{ functionName: null, url: "https://a.example/z.js", line: 3, column: 4, async: null }]);
  const loop = { name: "E", message: "m" };
  loop.cause = loop;
  assert.equal(chainOf({ error: loop }).length, 1, "a cause cycle stops");
  const cause = vm.runInNewContext(`(${CAUSE_CHAIN_FUNCTION}).call(new Error("outer", { cause: new TypeError("inner", { cause: "root" }) }))`);
  assert.deepEqual(JSON.parse(JSON.stringify(cause)).map((l) => [l.name, l.message]), [["Error", "outer"], ["TypeError", "inner"], ["", "root"]]);
});

const MATCHED = fixture("css-matched.json");

test("the cascade names the winning rule for each property with specificity, origin and stylesheet line, and why the rest lost", () => {
  const headers = new Map([headerOf({ header: { styleSheetId: "S1", sourceURL: "https://shop.example/site.css", origin: "regular", startLine: 0, startColumn: 0, isInline: false } }), headerOf({ header: { styleSheetId: "S2", sourceURL: "https://shop.example/", origin: "regular", startLine: 10, startColumn: 4, isInline: true } })]);
  const [color, padding, margin, fontSize, display] = cascadeFor(MATCHED.matched, MATCHED.computed, ["color", "padding", "margin", "font-size", "display"], headers);
  assert.equal(color.computed, "rgb(0, 128, 0)");
  assert.deepEqual([color.winner.value, color.winner.selector, color.winner.specificity, color.winner.important], ["green", ".cta", [0, 1, 0], true]);
  assert.deepEqual(color.winner.source, { styleSheetId: "S2", url: "https://shop.example/", line: 14, column: 5, inline: true });
  assert.deepEqual(color.overridden.map((o) => [o.value, o.reason]), [["purple", "the winner is !important"], ["blue", "the winner is !important"], ["red", "the winner is !important"]]);
  assert.deepEqual([padding.winner.value, padding.winner.source.line], ["4px", 3]);
  assert.deepEqual(padding.overridden.map((o) => [o.value, o.reason]), [["8px", "disabled"]]);
  assert.equal(margin.winner, null);
  assert.deepEqual(margin.overridden.map((o) => o.reason), ["invalid value"]);
  assert.deepEqual([fontSize.winner.value, fontSize.winner.selector, fontSize.winner.inheritedFrom], ["18px", "body", 1]);
  assert.deepEqual([display.winner.value, display.winner.origin], ["block", "user-agent"]);
  assert.deepEqual(declaredProperties(MATCHED.matched), ["color", "padding", "margin"]);
});

test("specificity is estimated when the engine leaves it out", () => {
  assert.deepEqual(estimateSpecificity("#buy.btn"), [1, 1, 0]);
  assert.deepEqual(estimateSpecificity("ul li > a:hover"), [0, 1, 3]);
  assert.deepEqual(estimateSpecificity(":where(#x) .a"), [0, 1, 0]);
  assert.deepEqual(estimateSpecificity("p::first-line"), [0, 0, 2]);
});

function runCondition(code, globals = {}) {
  const logged = [];
  const context = vm.createContext({ console: { log: (...args) => logged.push(args) }, String, ...globals });
  const result = vm.runInContext(`(function () { const cart = { total: 42 }; return ${code}; })()`, context, { timeout: 500 });
  return { result, logged };
}

test("a logpoint's condition logs and always answers false, so it can never pause the page", () => {
  const plain = runCondition(logpointCondition("lp1", "cart.total", null));
  assert.equal(plain.result, false);
  assert.deepEqual(plain.logged, [["[ardia logpoint lp1]", 42]]);
  const gated = runCondition(logpointCondition("lp2", "cart.total * 2", "cart.total > 100"));
  assert.deepEqual([gated.result, gated.logged.length], [false, 0]);
  const escapes = ['0); return true; (0', '"}) || true || (() => {"', "0)}catch(e){}return true;(()=>{", "`${true}`", "debugger", "throw 1", "true true", "\\", "</script>"];
  for (const hostile of escapes) {
    for (const [expression, condition] of [[hostile, null], ["1", hostile], [hostile, hostile]]) {
      const { result } = runCondition(logpointCondition("lp3", expression, condition));
      assert.equal(result, false, `${JSON.stringify(hostile)} never makes the condition truthy`);
    }
  }
  const replacedEval = runCondition(logpointCondition("lp4", "cart.total", null), { eval: () => true });
  assert.equal(replacedEval.result, false, "a page that replaces eval still can't make it pause");
  assert.throws(() => checkedExpression("", "expression"), /empty/);
  assert.throws(() => checkedExpression("a\u0000b", "expression"), /NUL/);
  assert.throws(() => checkedExpression("x".repeat(2001), "expression"), /longer/);
});

function fakeTransport(script = {}) {
  const sent = [];
  let listener = null;
  let closed = false;
  return {
    sent,
    emit: (method, params) => listener?.(method, params),
    get closed() {
      return closed;
    },
    transport: {
      async send(method, params) {
        sent.push([method, params]);
        const reply = script[method];
        return typeof reply === "function" ? reply(params, (m, p) => listener?.(m, p)) : (reply ?? {});
      },
      onEvent(next) {
        listener = next;
        return () => (listener = null);
      },
      async close() {
        closed = true;
      },
    },
  };
}

test("an inspection session never sends an override and undoes only what it turned on when it closes", async () => {
  const fake = fakeTransport({ "Debugger.setBreakpointByUrl": { breakpointId: "bp-1", locations: [] } });
  const before = liveInspectionSessions();
  const session = new InspectionSession("tab-1", 901, fake.transport);
  assert.equal(liveInspectionSessions(), before + 1);
  for (const method of ["Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride", "Network.setCacheDisabled", "Network.emulateNetworkConditions", "Network.disable", "Audits.checkContrast", "Runtime.evaluate", "Page.navigate", "Debugger.pause", "Target.closeTarget"]) {
    await assert.rejects(session.send(method), /never sends/, method);
  }
  await session.send("Audits.enable");
  await session.send("Debugger.enable");
  await session.send("Debugger.setBreakpointByUrl", { url: "https://a.example/x.js", lineNumber: 1 });
  await session.send("Tracing.start", {});
  await Promise.all([session.close(), session.close()]);
  assert.deepEqual(fake.sent.map(([m]) => m), ["Audits.enable", "Debugger.enable", "Debugger.setBreakpointByUrl", "Tracing.start", "Tracing.end", "Debugger.removeBreakpoint", "Debugger.disable", "Audits.disable"]);
  assert.ok(fake.sent.every(([m]) => !/^(Emulation|Network)\./.test(m)));
  assert.ok(fake.closed);
  assert.equal(liveInspectionSessions(), before);
  await assert.rejects(session.send("Audits.enable"), /ended before it finished/);
});

test("each trace recording starts from an empty buffer and drops it once handed back", async () => {
  const chunks = (n) => Array.from({ length: n }, (_, i) => ({ name: "RunTask", ph: "X", ts: 1000 + i, dur: 10, pid: 1, tid: 1 }));
  const run = async (n) => {
    const fake = fakeTransport({
      "Tracing.end": (_params, emit) => {
        emit("Tracing.dataCollected", { value: chunks(n) });
        emit("Tracing.dataCollected", { value: "junk" });
        setTimeout(() => emit("Tracing.tracingComplete", { dataLossOccurred: false }), 1);
        return {};
      },
    });
    const session = new InspectionSession("tab-2", 902, fake.transport);
    try {
      return { recording: await recordTrace(session, { durationMs: 1, reload: false, beforeReload: () => {} }), sent: fake.sent };
    } finally {
      await session.close();
    }
  };
  const first = await run(30);
  const second = await run(5);
  assert.equal(first.recording.events.length, 30);
  assert.equal(second.recording.events.length, 5);
  assert.ok(second.recording.complete);
  assert.deepEqual(first.sent.map(([m]) => m), ["Tracing.start", "Tracing.end"], "a finished trace isn't ended twice");
  assert.deepEqual(first.sent[0][1].traceConfig.excludedCategories, ["*"]);
});

test("field data sends only the origin by default and refuses non-web pages", async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push([url, JSON.parse(init.body), init.credentials]);
    return { ok: true, status: 200, json: async () => ({ record: { metrics: { largest_contentful_paint: { histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }], percentiles: { p75: "2100" } } } } }) };
  };
  const data = await fetchFieldData({ pageUrl: "https://shop.example/cart?id=9#x", apiKey: "AIzaFixtureKey_123", formFactor: null }, fetchFn);
  assert.deepEqual(sent[0][1].origin, "https://shop.example");
  assert.equal(JSON.stringify(sent[0][1]).includes("cart"), false);
  assert.equal(sent[0][2], "omit");
  assert.deepEqual(data.metrics.largest_contentful_paint, { p75: 2100, good: 0.7, poor: 0.1 });
  await fetchFieldData({ pageUrl: "https://shop.example/cart?id=9", apiKey: "AIzaFixtureKey_123", formFactor: "PHONE" }, fetchFn);
  assert.deepEqual(Object.keys(sent[1][1]).sort(), ["formFactor", "metrics", "origin"], "never a url field");
  for (const pageUrl of ["chrome://settings", "file:///etc/hosts", "javascript:alert(1)", "https://u:p@shop.example/"]) assert.throws(() => fieldDataOrigin(pageUrl));
  await assert.rejects(fetchFieldData({ pageUrl: "https://shop.example/", apiKey: "bad key&x=1", formFactor: null }, fetchFn), /API key/);
});

test("a trace with a second navigation attributes nothing from the second page to the first", () => {
  const trace = fixture("trace-load.json");
  const later = 1_010_000_000;
  trace.traceEvents.push(
    { name: "navigationStart", ph: "R", pid: 2, tid: 3, ts: later, args: { frame: "F1", data: { documentLoaderURL: "https://shop.example/next", isLoadingMainFrame: true, isOutermostMainFrame: true, navigationId: "N2" } } },
    { name: "RunTask", ph: "X", pid: 2, tid: 3, ts: later + 1_000_000, dur: 1_000_000, args: {} },
    { name: "LayoutShift", ph: "I", pid: 2, tid: 3, ts: later + 1_000_000, args: { frame: "F1", data: { score: 0.8, weighted_score_delta: 0.8, had_recent_input: false, navigationId: "N2" } } },
  );
  const result = analyzeTrace(trace);
  assert.deepEqual([result.metrics.tbt.ms, result.metrics.cls.value, result.navigation.navigationId], [170, 0.13, "N1"]);
});

test("a slow server makes TTFB the LCP phase the summary blames", () => {
  const start = 2_000_000_000;
  const events = [
    { name: "navigationStart", ph: "R", pid: 2, tid: 3, ts: start, args: { frame: "F", data: { documentLoaderURL: "https://slow.example/", isOutermostMainFrame: true, navigationId: "S" } } },
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 1000, args: { data: { requestId: "D", url: "https://slow.example/", frame: "F" } } },
    { name: "ResourceReceiveResponse", ph: "I", pid: 2, tid: 3, ts: start + 3_000_000, args: { data: { requestId: "D", statusCode: 200, mimeType: "text/html", timing: { requestTime: (start + 1000) / 1e6, receiveHeadersEnd: 2999 } } } },
    { name: "largestContentfulPaint::Candidate", ph: "R", pid: 2, tid: 3, ts: start + 3_100_000, args: { frame: "F", data: { candidateIndex: 1, navigationId: "S", type: "text", nodeId: 3 } } },
  ];
  const lcp = analyzeTrace(events).insights.find((i) => i.id === "lcp-breakdown");
  assert.match(lcp.summary, /largest phase is ttfb\. The server answers the document slowly/);
});

test("custom properties keep their case, and distinct blocked resources stay distinct issues", () => {
  const style = (name, value, line) => ({ name, value, range: { startLine: line, startColumn: 0 } });
  const matched = { matchedCSSRules: [{ rule: { origin: "regular", selectorList: { selectors: [{ text: ":root", specificity: { a: 0, b: 1, c: 0 } }] }, style: { cssProperties: [style("--Brand", "red", 1), style("--brand", "blue", 2)] } }, matchingSelectors: [0] }] };
  const [upper, lower] = cascadeFor(matched, { computedStyle: [{ name: "--Brand", value: "red" }, { name: "--brand", value: "blue" }] }, ["--Brand", "--brand"], new Map());
  assert.deepEqual([upper.winner.value, upper.computed, upper.overridden.length, lower.winner.value], ["red", "red", 0, "blue"]);
  assert.deepEqual(declaredProperties(matched), ["--Brand", "--brand"]);
  const mixed = (url) => ({ issue: { code: "MixedContentIssue", details: { mixedContentIssueDetails: { resolutionStatus: "MixedContentBlocked", insecureURL: url, mainResourceURL: "https://shop.example/" } } } });
  const { issues } = describeIssues([mixed("http://a.example/1.png"), mixed("http://a.example/2.png"), mixed("http://a.example/1.png")]);
  assert.deepEqual(issues.map((i) => i.affected.resourceUrl), ["http://a.example/1.png", "http://a.example/2.png"]);
});

test("a long inline source map is found anywhere in the script", () => {
  const body = Array.from({ length: 400 }, (_, i) => `export const value${i}: number = ${i};`).join("\n");
  const out = ts.transpileModule(`${body}\nexport function late(): never { throw new Error("late"); }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, inlineSourceMap: true, inlineSources: true }, fileName: "src/late.ts" }).outputText;
  const ref = sourceMapRefOf(out);
  assert.ok(ref && ref.length > 8192, "the inline map is longer than 8 KiB");
  assert.ok(parseSourceMap(inlineMapText(ref)));
  assert.equal(sourceMapRefOf("var a = 'sourceMappingURL=nope';"), null);
});

const sessions = await import("./devToolsSession.ts");

function deferredTransport() {
  const sent = [];
  const pending = [];
  let closed = false;
  return {
    sent,
    pending,
    get closed() {
      return closed;
    },
    transport: {
      send(method, params) {
        sent.push(method);
        if (method === "Debugger.setBreakpointByUrl") return new Promise((resolve) => pending.push(() => resolve({ breakpointId: "late-bp" })));
        return Promise.resolve({});
      },
      onEvent: () => () => {},
      async close() {
        closed = true;
      },
    },
  };
}

test("once a session starts closing it refuses new commands, and a breakpoint set in flight is still removed", async () => {
  const fake = deferredTransport();
  const session = new InspectionSession("tab-3", 903, fake.transport);
  await session.send("Debugger.enable");
  const inFlight = session.send("Debugger.setBreakpointByUrl", { url: "https://a.example/a.js", lineNumber: 0 });
  inFlight.catch(() => {});
  const closing = session.close();
  await assert.rejects(session.send("Debugger.enable"), /ended before it finished/);
  await assert.rejects(session.pause(10_000), /ended before it finished/);
  fake.pending.shift()();
  await assert.rejects(inFlight, /ended before it finished/, "the caller isn't left waiting once the session closes");
  await closing;
  assert.deepEqual(fake.sent, ["Debugger.enable", "Debugger.setBreakpointByUrl", "Debugger.removeBreakpoint", "Debugger.disable"]);
  assert.ok(fake.closed);
});

test("closing a connection or turning control off ends its sessions, including one still opening", async () => {
  const transports = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  sessions.setInspectionTransport(async () => {
    const fake = deferredTransport();
    transports.push(fake);
    await gate;
    return fake.transport;
  });
  try {
    const opening = sessions.openInspection("tab-4", 904);
    await sessions.closeInspectionsFor(904);
    release();
    await assert.rejects(opening, /Control was turned off/);
    assert.ok(transports[0].closed, "a session that finished opening after its connection closed is closed at once");
    const open = await sessions.openInspection("tab-5", 905);
    const work = open.pause(10_000);
    await sessions.closeAllInspections();
    await assert.rejects(work, /ended before it finished/);
    assert.equal(sessions.liveInspectionSessions(), 0);
  } finally {
    sessions.setInspectionTransport(null);
  }
});

test("interactions from another frame or the previous document don't count toward INP, and blocking spans aren't double counted", () => {
  const trace = fixture("trace-load.json");
  const before = 999_000_000;
  trace.traceEvents.push(
    { name: "EventTiming", ph: "b", pid: 2, tid: 3, ts: before, args: { data: { interactionId: 90, duration: 900, type: "click", frame: "F1", timeStamp: 1, processingStart: 2, processingEnd: 3 } } },
    { name: "EventTiming", ph: "b", pid: 2, tid: 3, ts: 1_004_000_000, args: { data: { interactionId: 91, duration: 800, type: "click", frame: "F2", timeStamp: 1, processingStart: 2, processingEnd: 3 } } },
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: 1_000_700_000, args: { data: { requestId: "R9", url: "https://shop.example/other.css", renderBlocking: "blocking", frame: "F1" } } },
    { name: "ResourceFinish", ph: "I", pid: 2, tid: 3, ts: 1_000_850_000, args: { data: { requestId: "R9", finishTime: 1000.85 } } },
  );
  const result = analyzeTrace(trace);
  assert.equal(result.metrics.inp.ms, 320);
  assert.equal(result.counts.interactions, 2);
  const blocking = result.insights.find((i) => i.id === "render-blocking");
  assert.equal(blocking.savingsMs, 220, "a blocker inside another blocker's span adds nothing");
  assert.equal(blocking.details.requests.length, 2);
});

test("a registered custom property that doesn't inherit isn't taken from an ancestor, and shorthands count for their longhands", () => {
  const rule = (selector, props) => ({ rule: { origin: "regular", selectorList: { selectors: [{ text: selector, specificity: { a: 0, b: 1, c: 0 } }] }, style: { cssProperties: props } }, matchingSelectors: [0] });
  const matched = {
    matchedCSSRules: [rule(".card", [{ name: "margin", value: "4px 8px", longhandProperties: [{ name: "margin-top", value: "4px" }, { name: "margin-left", value: "8px" }] }]), rule(".card.wide", [{ name: "margin-left", value: "16px" }])],
    inherited: [{ matchedCSSRules: [rule(".parent", [{ name: "--gap", value: "10px" }, { name: "--tone", value: "dark" }])] }],
    cssPropertyRules: [{ propertyName: { text: "--gap" }, style: { cssProperties: [{ name: "syntax", value: '"<length>"' }, { name: "inherits", value: "false" }] } }],
  };
  const [gap, tone, top, left] = cascadeFor(matched, { computedStyle: [] }, ["--gap", "--tone", "margin-top", "margin-left"], new Map());
  assert.equal(gap.winner, null);
  assert.equal(tone.winner.value, "dark");
  assert.deepEqual([top.winner.value, top.winner.shorthand], ["4px", "margin"]);
  assert.deepEqual([left.winner.value, left.winner.shorthand, left.overridden[0].value, left.overridden[0].shorthand], ["16px", null, "8px", "margin"]);
});

const logpointBook = await import("./devToolsLogpoints.ts");

const navStart = (ts, frame, url, extra = {}) => ({ name: "navigationStart", ph: "R", pid: extra.pid ?? 2, tid: 3, ts, args: { frame, data: { documentLoaderURL: url, isLoadingMainFrame: true, isOutermostMainFrame: true, navigationId: extra.id ?? `nav-${ts}` } } });

test("another tab's navigation and requests never enter this tab's insights", () => {
  const trace = fixture("trace-load.json");
  trace.traceEvents.push(
    navStart(999_990_000, "OTHER", "https://elsewhere.example/", { pid: 7 }),
    navStart(1_002_000_000, "OTHER", "https://elsewhere.example/b", { pid: 7 }),
    { name: "ResourceSendRequest", ph: "I", pid: 7, tid: 1, ts: 1_000_690_000, args: { data: { requestId: "X1", url: "https://elsewhere.example/block.css", renderBlocking: "blocking", frame: "OTHER" } } },
    { name: "ResourceFinish", ph: "I", pid: 7, tid: 1, ts: 1_000_990_000, args: { data: { requestId: "X1", finishTime: 1000.99 } } },
  );
  const result = analyzeTrace(trace);
  assert.equal(result.navigation.url, "https://shop.example/");
  assert.equal(result.metrics.tbt.ms, 170, "the other tab's navigation didn't cut this page's trace short");
  assert.ok(!JSON.stringify(result).includes("elsewhere.example"));
});

test("the renderer process comes from the selected navigation, and a task crossing the next navigation is clipped", () => {
  const start = 3_000_000_000;
  const events = [
    { name: "TracingStartedInBrowser", ph: "I", pid: 1, tid: 1, ts: start - 10, args: { data: { frames: [{ frame: "M", processId: 1, isOutermostMainFrame: true }] } } },
    navStart(start, "M", "https://a.example/", { pid: 2 }),
    { name: "firstContentfulPaint", ph: "R", pid: 2, tid: 3, ts: start + 100_000, args: { frame: "M" } },
    { name: "RunTask", ph: "X", pid: 2, tid: 3, ts: start + 200_000, dur: 1_000_000, args: {} },
    { name: "RunTask", ph: "X", pid: 2, tid: 3, ts: start + 1_900_000, dur: 1_000_000, args: {} },
    navStart(start + 2_000_000, "M", "https://a.example/next", { pid: 2 }),
  ];
  const result = analyzeTrace(events);
  assert.equal(result.metrics.tbt.ms, 950 + 50, "the first task counts in full, the second only up to the next navigation");
  assert.equal(result.counts.longTasks, 2);
});

test("an interaction just before navigation start doesn't count toward INP", () => {
  const trace = fixture("trace-load.json");
  trace.traceEvents.push({ name: "EventTiming", ph: "b", pid: 2, tid: 3, ts: 999_999_500, args: { data: { interactionId: 70, duration: 2000, type: "click", frame: "F1", timeStamp: 1, processingStart: 2, processingEnd: 3 } } });
  assert.equal(analyzeTrace(trace).metrics.inp.ms, 320);
});

test("finding the worst layout-shift window stays linear on a huge burst", () => {
  const events = [navStart(4_000_000_000, "M", "https://a.example/")];
  for (let i = 0; i < 100_000; i++) events.push({ name: "LayoutShift", ph: "I", pid: 2, tid: 3, ts: 4_000_000_000 + i * 10, args: { frame: "M", data: { score: 0.00001, had_recent_input: false } } });
  const started = Date.now();
  const result = analyzeTrace(events);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(result.counts.layoutShifts, 100_000);
});

test("the logpoint script book drops a navigated frame's old scripts and caps retained map bytes", () => {
  const map = (source) => `data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: [source], names: [], mappings: "AAAA" })).toString("base64")}`;
  const book = logpointBook.newScriptBook();
  const parsed = (scriptId, url, context, sourceMapURL) => logpointBook.recordScript(book, { scriptId, url, sourceMapURL, executionContextId: context, executionContextAuxData: { frameId: "F", isDefault: true } });
  parsed("1", "https://a.example/old.js", 1, map("src/app.ts"));
  assert.equal(logpointBook.locate(book, "src/app.ts", 1, null).url, "https://a.example/old.js");
  parsed("2", "https://a.example/new.js", 2, map("src/app.ts"));
  assert.deepEqual([...book.scripts.keys()], ["2"], "the old document's scripts are gone");
  assert.equal(logpointBook.locate(book, "src/app.ts", 1, null).url, "https://a.example/new.js");
  const huge = `data:application/json;base64,${"A".repeat(logpointBook.MAX_HELD_MAP_BYTES)}`;
  parsed("3", "https://a.example/huge.js", 2, huge);
  assert.equal(book.scripts.get("3").sourceMapURL, null, "a map past the session's byte budget isn't kept");
  assert.ok(book.mapBytes <= logpointBook.MAX_HELD_MAP_BYTES);
  logpointBook.discardScriptBook(book);
  assert.equal(logpointBook.retainedLogpointMapBytes(), 0);
});

test("teardown finishes even when the transport stalls", async () => {
  let closeCalled = false;
  const stalled = { send: () => new Promise(() => {}), onEvent: () => () => {}, close: () => ((closeCalled = true), new Promise(() => {})) };
  const session = new InspectionSession("tab-6", 906, stalled);
  const hanging = session.send("DOM.enable");
  hanging.catch(() => {});
  const started = Date.now();
  await session.close();
  assert.ok(closeCalled, "close always reaches the transport");
  assert.ok(Date.now() - started < sessions.TEARDOWN_WAIT_MS + sessions.CLEANUP_STEP_MS * 3, `took ${Date.now() - started} ms`);
  assert.equal(sessions.liveInspectionSessions(), 0);
});

test("the cascade keeps declaration order between longhands and shorthands, the last inherits descriptor, and layer order for !important", () => {
  const rule = (selector, props, extra = {}) => ({ rule: { origin: extra.origin ?? "regular", selectorList: { selectors: [{ text: selector, specificity: { a: 0, b: 1, c: 0 } }] }, style: { cssProperties: props }, ...extra.rule }, matchingSelectors: [0] });
  const margin = { name: "margin", value: "4px", longhandProperties: [{ name: "margin-left", value: "4px" }] };
  const [left] = cascadeFor({ matchedCSSRules: [rule(".x", [{ name: "margin-left", value: "16px" }, margin])] }, {}, ["margin-left"], new Map());
  assert.deepEqual([left.winner.value, left.winner.shorthand], ["4px", "margin"]);
  const [importantShorthand] = cascadeFor({ matchedCSSRules: [rule(".x", [{ name: "margin-left", value: "16px" }, { ...margin, important: true }])] }, {}, ["margin-left"], new Map());
  assert.equal(importantShorthand.winner.value, "4px");
  const registered = { inherited: [{ matchedCSSRules: [rule(".p", [{ name: "--gap", value: "1px" }])] }], cssPropertyRules: [{ propertyName: { text: "--gap" }, style: { cssProperties: [{ name: "inherits", value: "false" }, { name: "inherits", value: "true" }] } }] };
  assert.equal(cascadeFor(registered, {}, ["--gap"], new Map())[0].winner.value, "1px", "the later inherits: true wins");
  const layered = { matchedCSSRules: [rule(".x", [{ name: "color", value: "red", important: true }], { rule: { layers: [{ text: "a" }] } }), rule(".x", [{ name: "color", value: "blue", important: true }], { rule: { layers: [{ text: "b" }] } }), rule(".x", [{ name: "color", value: "green", important: true }])] };
  const [color] = cascadeFor(layered, {}, ["color"], new Map());
  assert.equal(color.winner.value, "red", "an earlier layer's !important beats a later layer's and unlayered !important");
  assert.ok(color.overridden.some((o) => o.reason === "an earlier @layer's !important wins"));
  const normal = { matchedCSSRules: [rule(".x", [{ name: "color", value: "red" }], { rule: { layers: [{ text: "a" }] } }), rule(".x", [{ name: "color", value: "blue" }])] };
  assert.equal(cascadeFor(normal, {}, ["color"], new Map())[0].winner.value, "blue");
});

test("presentational attributes beat browser defaults, inactive conditions never win, SVG paint inherits, and inline sheets offset their first line", () => {
  const rule = (selector, props, extra = {}) => ({ rule: { origin: extra.origin ?? "regular", styleSheetId: extra.sheet, selectorList: { selectors: [{ text: selector, specificity: { a: 0, b: 0, c: 1 } }] }, style: { styleSheetId: extra.sheet, cssProperties: props }, ...extra.rule }, matchingSelectors: [0] });
  const th = { attributesStyle: { cssProperties: [{ name: "text-align", value: "left" }] }, matchedCSSRules: [rule("th", [{ name: "text-align", value: "-internal-center" }], { origin: "user-agent" })] };
  assert.equal(cascadeFor(th, {}, ["text-align"], new Map())[0].winner.value, "left");
  const media = { matchedCSSRules: [rule(".x", [{ name: "color", value: "red" }]), rule(".x", [{ name: "color", value: "blue", important: true }], { rule: { media: [{ text: "print", mediaList: [{ active: false, expressions: [] }] }] } })] };
  const [color] = cascadeFor(media, {}, ["color"], new Map());
  assert.equal(color.winner.value, "red");
  assert.equal(color.overridden[0].reason, "its @media or @supports condition doesn't apply");
  const svg = { matchedCSSRules: [], inherited: [{ inlineStyle: { cssProperties: [{ name: "fill", value: "red" }] }, matchedCSSRules: [] }] };
  assert.equal(cascadeFor(svg, {}, ["fill"], new Map())[0].winner.value, "red");
  const headers = new Map([["S", { url: "https://a.example/", origin: "regular", startLine: 9, startColumn: 40, isInline: true }]]);
  const located = { matchedCSSRules: [rule(".x", [{ name: "color", value: "red", range: { startLine: 0, startColumn: 3 } }, { name: "margin", value: "0", range: { startLine: 2, startColumn: 3 } }], { sheet: "S" })] };
  const [first, later] = cascadeFor(located, {}, ["color", "margin"], headers);
  assert.deepEqual([first.winner.source.line, first.winner.source.column], [10, 44]);
  assert.deepEqual([later.winner.source.line, later.winner.source.column], [12, 4]);
});

test("source maps refuse line floods, bad sections and find directives in linear time", () => {
  const base = { version: 3, sources: ["a.ts"], names: [] };
  assert.equal(parseSourceMap({ ...base, mappings: ";".repeat(300_000) }), null);
  assert.equal(parseSourceMap({ version: 3, sections: [{ offset: { line: -1, column: 0 }, map: { ...base, mappings: "AAAA" } }] }), null);
  assert.equal(parseSourceMap({ version: 3, sections: Array.from({ length: 65 }, (_, i) => ({ offset: { line: i, column: 0 }, map: { ...base, mappings: "AAAA" } })) }), null);
  assert.equal(sourceMapRefOf("x()\n/*# sourceMappingURL=app.js.map*/"), "app.js.map");
  assert.equal(sourceMapRefOf("x()\n//#sourceMappingURL=app.js.map\n"), "app.js.map");
  assert.equal(sourceMapRefOf("x()\n//@ sourceMappingURL=old.map\n//# sourceURL=x.js"), "old.map");
  const trap = `var s = "${"sourceMappingURL=".repeat(50_000)}";`;
  const started = Date.now();
  assert.equal(sourceMapRefOf(trap), null);
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
});

test("stack frames keep URLs with parentheses, primitive causes stay in the chain, and distinct CSP severities aren't merged", () => {
  assert.deepEqual(framesOfStack("Error\n    at checkout (https://shop.example/app(1).js:10:20)").map((f) => [f.functionName, f.url, f.line]), [["checkout", "https://shop.example/app(1).js", 10]]);
  assert.deepEqual(chainOf({ error: { name: "Error", message: "outer", cause: "root" } }).map((l) => l.message), ["outer", "root"]);
  const csp = (reportOnly) => ({ issue: { code: "ContentSecurityPolicyIssue", details: { contentSecurityPolicyIssueDetails: { violatedDirective: "script-src", isReportOnly: reportOnly, contentSecurityPolicyViolationType: "kInlineViolation", sourceCodeLocation: { url: "https://a.example/", lineNumber: 1, columnNumber: 1 } } } } });
  assert.deepEqual(describeIssues([csp(true), csp(false)]).issues.map((i) => i.severity), ["error", "warning"]);
});

test("an inline map with an upper-case DATA: scheme still resolves", () => {
  const map = JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" });
  const upper = `DATA:application/json;base64,${Buffer.from(map).toString("base64")}`;
  const resolver = new SourceMapResolver({ maps: { "https://a.example/given.js": upper }, scripts: { "https://a.example/inline.js": `x()\n//# sourceMappingURL=${upper}` } });
  assert.ok(resolver.mapFor("https://a.example/given.js"));
  assert.ok(resolver.mapFor("https://a.example/inline.js"));
  const book = logpointBook.newScriptBook();
  logpointBook.recordScript(book, { scriptId: "1", url: "https://a.example/x.js", sourceMapURL: upper });
  assert.equal(book.scripts.get("1").sourceMapURL, upper);
  logpointBook.discardScriptBook(book);
});

test("an image URL from another renderer never becomes this page's LCP URL", () => {
  const trace = fixture("trace-load.json");
  for (const e of trace.traceEvents) if (e.name === "LargestImagePaint::Candidate") e.args.data.imageUrl = "https://cdn.shop.example/hero.jpg";
  const lcp = trace.traceEvents.find((e) => e.name === "largestContentfulPaint::Candidate" && e.args.data.candidateIndex === 2);
  trace.traceEvents.push({ name: "LargestImagePaint::Candidate", ph: "R", pid: 7, tid: 1, ts: lcp.ts + 10, args: { frame: "OTHER", data: { DOMNodeId: 42, imageUrl: "https://elsewhere.example/secret.jpg" } } });
  const result = analyzeTrace(trace);
  assert.equal(result.insights.find((i) => i.id === "lcp-breakdown").details.element.url, "https://cdn.shop.example/hero.jpg");
  assert.ok(!JSON.stringify(result).includes("secret.jpg"));
});

test("a main-frame navigation to about:blank ends the selected page's trace window", () => {
  const start = 5_000_000_000;
  const events = [
    navStart(start, "M", "https://a.example/"),
    { name: "firstContentfulPaint", ph: "R", pid: 2, tid: 3, ts: start + 100_000, args: { frame: "M" } },
    navStart(start + 500_000, "M", "about:blank"),
    { name: "RunTask", ph: "X", pid: 2, tid: 3, ts: start + 600_000, dur: 1_000_000, args: {} },
  ];
  const result = analyzeTrace(events);
  assert.equal(result.counts.longTasks, 0);
  assert.equal(result.metrics.tbt.ms, 0);
});

test("logpoint map memory is one budget across every session, and frames are bounded", () => {
  const map = `data:application/json;base64,${"A".repeat(Math.floor(logpointBook.MAX_HELD_MAP_BYTES / 2) - 40)}`;
  const books = [logpointBook.newScriptBook(), logpointBook.newScriptBook(), logpointBook.newScriptBook()];
  books.forEach((book, i) => logpointBook.recordScript(book, { scriptId: "1", url: `https://a.example/${i}.js`, sourceMapURL: map }));
  assert.deepEqual(books.map((book) => book.scripts.get("1").sourceMapURL !== null), [true, true, false], "the third tab's map would pass the shared budget");
  assert.ok(logpointBook.retainedLogpointMapBytes() <= logpointBook.MAX_HELD_MAP_BYTES);
  books.forEach((book) => logpointBook.discardScriptBook(book));
  assert.equal(logpointBook.retainedLogpointMapBytes(), 0);
  const frames = logpointBook.newScriptBook();
  for (let i = 0; i < logpointBook.MAX_HELD_FRAMES + 50; i++) logpointBook.recordScript(frames, { scriptId: `s${i}`, url: `https://a.example/f${i}.js`, executionContextId: i + 1, executionContextAuxData: { frameId: `F${i}`, isDefault: true } });
  assert.equal(frames.frameContexts.size, logpointBook.MAX_HELD_FRAMES);
  assert.equal(frames.scripts.size, logpointBook.MAX_HELD_FRAMES, "a script whose frame was refused isn't kept either");
  logpointBook.discardScriptBook(frames);
});

test("closing a session releases callers waiting on a stalled transport and aborts a pending open", async () => {
  const stalled = { send: () => new Promise(() => {}), onEvent: () => () => {}, close: async () => {} };
  const session = new InspectionSession("tab-7", 907, stalled);
  const waiting = session.send("DOM.getDocument");
  const closing = session.close();
  await assert.rejects(waiting, /ended before it finished/);
  await closing;
  let aborted = false;
  sessions.setInspectionTransport((tabId, signal) => {
    signal.addEventListener("abort", () => (aborted = true));
    return new Promise(() => {});
  });
  try {
    const opening = sessions.openInspection("tab-8", 908);
    await sessions.closeInspectionsFor(908);
    await assert.rejects(opening, /Control was turned off/);
    assert.ok(aborted, "the opener was told to stop");
  } finally {
    sessions.setInspectionTransport(null);
  }
});

test("an anonymous @layer's !important beats unlayered !important, and two anonymous layers stay distinct", () => {
  const rule = (value, layers) => ({ rule: { origin: "regular", selectorList: { selectors: [{ text: ".x", specificity: { a: 0, b: 1, c: 0 } }] }, style: { cssProperties: [{ name: "color", value, important: true }] }, ...(layers ? { layers } : {}) }, matchingSelectors: [0] });
  const matched = { matchedCSSRules: [rule("first", [{ text: "" }]), rule("second", [{ text: "" }]), rule("plain")] };
  const [color] = cascadeFor(matched, {}, ["color"], new Map());
  assert.equal(color.winner.value, "first", "the earlier anonymous layer wins among !important");
});

test("a sourceMappingURL directive after code on the last line is found, and a string isn't one", () => {
  assert.equal(sourceMapRefOf("x();//# sourceMappingURL=app.js.map"), "app.js.map");
  assert.equal(sourceMapRefOf("x(); /*# sourceMappingURL=app.js.map */"), "app.js.map");
  assert.equal(sourceMapRefOf('var s = "//# sourceMappingURL=app.js.map";'), null);
  const started = Date.now();
  assert.equal(sourceMapRefOf(`x();${"//#sourceMappingURL=a ".repeat(50_000)}y();`), null);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test("an explicit cause: null is kept in the chain", () => {
  assert.deepEqual(chainOf({ error: { name: "Error", message: "outer", cause: null } }).map((l) => l.message), ["outer", "null"]);
  assert.deepEqual(chainOf({ error: { name: "Error", message: "outer" } }).map((l) => l.message), ["outer"]);
  const chain = vm.runInNewContext(`(${CAUSE_CHAIN_FUNCTION}).call(new Error("outer", { cause: null }))`);
  assert.deepEqual(JSON.parse(JSON.stringify(chain)).map((l) => l.message), ["outer", "null"]);
});

test("a directive followed by a long run of spaces and junk is rejected in linear time", () => {
  const started = Date.now();
  assert.equal(sourceMapRefOf(`x();\n//# sourceMappingURL=x${" ".repeat(32_000)}!`), null);
  assert.equal(sourceMapRefOf(`x();\n//#${" ".repeat(32_000)}sourceMappingURL=x`), null);
  assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`);
  assert.equal(sourceMapRefOf(`x();\n//# sourceMappingURL=app.js.map${" ".repeat(32_000)}`), "app.js.map");
});

test("a long task that starts before FCP counts its blocking time after FCP", () => {
  const start = 6_000_000_000;
  const events = [
    navStart(start, "M", "https://a.example/"),
    { name: "firstContentfulPaint", ph: "R", pid: 2, tid: 3, ts: start + 2_000_000, args: { frame: "M" } },
    { name: "RunTask", ph: "X", pid: 2, tid: 3, ts: start + 1_990_000, dur: 1_000_000, args: {} },
  ];
  assert.equal(analyzeTrace(events).metrics.tbt.ms, 940, "only the 990 ms after FCP count, less the 50 ms threshold");
});

test("a document redirect that reuses its request id still gives TTFB for the final URL", () => {
  const start = 7_000_000_000;
  const events = [
    navStart(start, "M", "https://a.example/"),
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 1000, args: { data: { requestId: "D", url: "https://a.example/old", frame: "M" } } },
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 100_000, args: { data: { requestId: "D", url: "https://a.example/", frame: "M" } } },
    { name: "ResourceReceiveResponse", ph: "I", pid: 2, tid: 3, ts: start + 400_000, args: { data: { requestId: "D", statusCode: 200, timing: { requestTime: (start + 100_000) / 1e6, receiveHeadersEnd: 300 } } } },
  ];
  assert.equal(analyzeTrace(events).metrics.ttfb.ms, 400);
});

test("frames are found whatever order the trace lists them in", () => {
  const start = 8_000_000_000;
  const events = [
    { name: "TracingStartedInBrowser", ph: "I", pid: 1, tid: 1, ts: start - 10, args: { data: { frames: [{ frame: "M", processId: 2, isOutermostMainFrame: true }, { frame: "G", parent: "C", processId: 2 }, { frame: "C", parent: "M", processId: 2 }] } } },
    navStart(start, "M", "https://a.example/"),
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 1000, args: { data: { requestId: "R", url: "https://a.example/grandchild.js", frame: "G" } } },
    { name: "ResourceFinish", ph: "I", pid: 2, tid: 3, ts: start + 5000, args: { data: { requestId: "R", finishTime: (start + 5000) / 1e6 } } },
  ];
  assert.equal(analyzeTrace(events).counts.requests, 1);
});

test("a trace the browser reports as lossy comes back truncated", async () => {
  const fake = fakeTransport({
    "Tracing.end": (_params, emit) => {
      emit("Tracing.dataCollected", { value: [{ name: "RunTask", ph: "X", ts: 1, dur: 1, pid: 1, tid: 1 }] });
      setTimeout(() => emit("Tracing.tracingComplete", { dataLossOccurred: true }), 1);
      return {};
    },
  });
  const session = new InspectionSession("tab-9", 909, fake.transport);
  try {
    const recording = await recordTrace(session, { durationMs: 1, reload: false, beforeReload: () => {} });
    assert.deepEqual([recording.complete, recording.truncated], [true, true]);
  } finally {
    await session.close();
  }
});

test("a huge sourceRoot can't make source paths, and so the answer, balloon", () => {
  const map = (sourceRoot) => parseSourceMap({ version: 3, sourceRoot, sources: ["a.ts"], names: [], mappings: "AAAA" });
  assert.deepEqual(map("https://a.example/src").sources, ["https://a.example/src/a.ts"]);
  assert.deepEqual(map("x".repeat(100_000)).sources, ["a.ts"], "an oversized root is ignored");
  assert.ok(map("y".repeat(2040)).sources[0].length <= 2048, "a composed path is capped");
});

test("a long-lived session doesn't keep a close handler per finished command, and still rejects stalled ones", async () => {
  const fake = fakeTransport();
  const session = new InspectionSession("tab-10", 910, fake.transport);
  for (let i = 0; i < 1000; i++) await session.send("DOM.getDocument");
  assert.equal(session.closeWaiters.size, 0);
  const stalled = new InspectionSession("tab-11", 911, { send: () => new Promise(() => {}), onEvent: () => () => {}, close: async () => {} });
  const waiting = stalled.send("DOM.getDocument");
  assert.equal(stalled.closeWaiters.size, 1);
  await Promise.all([assert.rejects(waiting, /ended before it finished/), stalled.close(), session.close()]);
});

test("many directive prefixes on one line ending in a quote stay linear", () => {
  const started = Date.now();
  assert.equal(sourceMapRefOf(`${"//#sourceMappingURL=".repeat(8000)}"`), null);
  assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`);
});

test("the document request is found by its loader id even when a redirect changed its URL", () => {
  const start = 9_000_000_000;
  const events = [
    navStart(start, "M", "https://a.example/old", { id: "LOADER" }),
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 1000, args: { data: { requestId: "LOADER", url: "https://a.example/old", frame: "M" } } },
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 100_000, args: { data: { requestId: "LOADER", url: "https://a.example/new", frame: "M" } } },
    { name: "ResourceReceiveResponse", ph: "I", pid: 2, tid: 3, ts: start + 400_000, args: { data: { requestId: "LOADER", statusCode: 200, timing: { requestTime: (start + 100_000) / 1e6, receiveHeadersEnd: 300 } } } },
  ];
  assert.equal(analyzeTrace(events).metrics.ttfb.ms, 400);
});

test("a task is clipped to the window after FCP before the 50 ms threshold comes off", () => {
  const start = 10_000_000_000;
  const events = [
    navStart(start, "M", "https://a.example/"),
    { name: "RunTask", ph: "X", pid: 2, tid: 3, ts: start + 10_000, dur: 140_000, args: {} },
    { name: "firstContentfulPaint", ph: "R", pid: 2, tid: 3, ts: start + 110_000, args: { frame: "M" } },
  ];
  assert.equal(analyzeTrace(events).metrics.tbt.ms, 0, "40 ms after FCP is under the threshold");
});

test("a sourceMappingURL line inside a template literal isn't a directive", () => {
  assert.equal(sourceMapRefOf("const s = `\n//# sourceMappingURL=evil.map`;"), null);
  assert.equal(sourceMapRefOf("const s = `\n//# sourceMappingURL=evil.map`"), null);
  assert.equal(sourceMapRefOf("const s = `\n//# sourceMappingURL=evil.map\n`;"), null);
  assert.equal(sourceMapRefOf("x();\n//# sourceMappingURL=data:application/json;base64,e30="), "data:application/json;base64,e30=");
});

test("the frame cap counts frames seen only in isolated worlds too", () => {
  const book = logpointBook.newScriptBook();
  for (let i = 0; i < logpointBook.MAX_HELD_FRAMES + 50; i++) logpointBook.recordScript(book, { scriptId: `iso${i}`, url: `https://a.example/${i}.js`, executionContextId: 5000 + i, executionContextAuxData: { frameId: `W${i}`, isDefault: false } });
  assert.equal(book.frames.size, logpointBook.MAX_HELD_FRAMES);
  assert.equal(book.scripts.size, logpointBook.MAX_HELD_FRAMES);
  assert.equal(book.frameContexts.size, 0, "only default contexts drive navigation cleanup");
  logpointBook.recordScript(book, { scriptId: "known", url: "https://a.example/again.js", executionContextId: 1, executionContextAuxData: { frameId: "W0", isDefault: true } });
  assert.ok(book.scripts.has("known"), "a frame already counted still takes new scripts");
  logpointBook.discardScriptBook(book);
});

test("an LCP image that starts loading before TTFB isn't counted twice", () => {
  const start = 11_000_000_000;
  const events = [
    navStart(start, "M", "https://a.example/", { id: "L" }),
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 1000, args: { data: { requestId: "L", url: "https://a.example/", frame: "M" } } },
    { name: "ResourceReceiveResponse", ph: "I", pid: 2, tid: 3, ts: start + 1_000_000, args: { data: { requestId: "L", statusCode: 200, timing: { requestTime: (start + 1000) / 1e6, receiveHeadersEnd: 999 } } } },
    { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: start + 100_000, args: { data: { requestId: "IMG", url: "https://a.example/hero.jpg", frame: "M" } } },
    { name: "ResourceFinish", ph: "I", pid: 2, tid: 3, ts: start + 1_500_000, args: { data: { requestId: "IMG", finishTime: (start + 1_500_000) / 1e6 } } },
    { name: "largestContentfulPaint::Candidate", ph: "R", pid: 2, tid: 3, ts: start + 1_600_000, args: { frame: "M", data: { candidateIndex: 1, navigationId: "L", type: "image", nodeId: 9, url: "https://a.example/hero.jpg" } } },
  ];
  const lcp = analyzeTrace(events).insights.find((i) => i.id === "lcp-breakdown");
  assert.deepEqual(lcp.details.phases, { ttfbMs: 1000, loadDelayMs: 0, loadDurationMs: 500, renderDelayMs: 100 });
  assert.match(lcp.summary, /largest phase is ttfb/);
});

test("a comment-looking line with a backtick ends the trailing scan, so a template literal's directive isn't read", () => {
  assert.equal(sourceMapRefOf("const s = `\n//# sourceMappingURL=evil.map\n//`;"), null);
  assert.equal(sourceMapRefOf("x();\n//# sourceMappingURL=app.js.map\n// trailing note"), "app.js.map");
});

test("the overall rating counts measured metrics, not only insights", () => {
  const start = 12_000_000_000;
  const slowPaint = analyzeTrace([navStart(start, "M", "https://a.example/"), { name: "firstContentfulPaint", ph: "R", pid: 2, tid: 3, ts: start + 3_200_000, args: { frame: "M" } }]);
  assert.equal(slowPaint.metrics.fcp.rating, "poor");
  assert.equal(overallRating(slowPaint), "poor");
});

test("the cascade answer is capped in total, and says how many overridden declarations it left out", () => {
  const rules = Array.from({ length: 200 }, (_, i) => ({ rule: { origin: "regular", selectorList: { selectors: [{ text: `.r${i}`, specificity: { a: 0, b: 1, c: 0 } }] }, style: { cssProperties: Array.from({ length: 20 }, (_, p) => ({ name: `--p${p}`, value: `${i}` })) } }, matchingSelectors: [0] }));
  const answer = cascadeFor({ matchedCSSRules: rules }, {}, Array.from({ length: 20 }, (_, p) => `--p${p}`), new Map());
  const kept = answer.reduce((sum, entry) => sum + entry.overridden.length, 0);
  assert.ok(kept <= 512, `${kept} overridden declarations returned`);
  assert.ok(answer.every((entry) => entry.overridden.length <= 32));
  assert.equal(answer[0].overriddenOmitted, 199 - 32);
  assert.equal(answer.reduce((sum, entry) => sum + entry.overridden.length + entry.overriddenOmitted, 0), 20 * 199);
});

test("a mapped logpoint in an inline script adds the script's start offsets", () => {
  const map = `data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ["src/inline.ts"], names: [], mappings: "AAAA;AACA" })).toString("base64")}`;
  const book = logpointBook.newScriptBook();
  logpointBook.recordScript(book, { scriptId: "7", url: "https://a.example/page.html", sourceMapURL: map, startLine: 10, startColumn: 4 });
  assert.deepEqual([logpointBook.locate(book, "src/inline.ts", 1, null).line, logpointBook.locate(book, "src/inline.ts", 1, null).column], [11, 5], "the first generated line adds both offsets");
  assert.deepEqual([logpointBook.locate(book, "src/inline.ts", 2, null).line, logpointBook.locate(book, "src/inline.ts", 2, null).column], [12, 1], "later lines add only the line offset");
  logpointBook.discardScriptBook(book);
});
