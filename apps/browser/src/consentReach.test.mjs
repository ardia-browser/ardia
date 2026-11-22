import { join, win32 } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { analyze, compare, readBaseline, reachSinks, scopeFiles, scoreboard, writeBaseline } from "../scripts/consentReach.mjs";
import { ROOT, isTelemetryBuffer, unstampedEmits } from "../scripts/consentStatic.mjs";

function virtualProgram(sources, { root = ROOT, joinPath = join } = {}) {
  const options = { noLib: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true };
  const posix = (name) => name.split("\\").join("/");
  const texts = new Map(Object.entries(sources).map(([rel, text]) => [posix(joinPath(root, rel)), text]));
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, version) => (texts.has(posix(name)) ? ts.createSourceFile(posix(name), texts.get(posix(name)), version, true) : undefined);
  host.fileExists = (name) => texts.has(posix(name));
  host.readFile = (name) => texts.get(posix(name));
  return ts.createProgram([...texts.keys()], options, host);
}

if (process.argv.includes("--write")) {
  writeBaseline(analyze());
} else {
  test("consent gaps the per-file tripwire can't see stay at the baseline", (t) => {
    const result = analyze();
    t.diagnostic(`reachable functions ${result.reached}, ${scoreboard(result.found)}`);
    const problems = compare(readBaseline(), result.found);
    assert.equal(
      problems.length,
      0,
      `Consent reach check. New entries fail; fixed ones must lower apps/browser/src/consent-reach-baseline.json (node apps/browser/scripts/consentReach.mjs --write):\n${problems.join("\n")}`,
    );
  });

  test("helpers reached from a continuation count, activity starts and forwarded tokens don't", () => {
    const program = virtualProgram({
      "apps/browser/src/state/telemetry/usage.ts": [
        "export type ConsentToken = string & { readonly period: 1 };",
        "export const consentToken = (): ConsentToken | null => null;",
        "export function noteThing(consent?: ConsentToken | null) {}",
        "export function noteOther(options: { times: number }) {}",
        "export function capture(event: string, props: object, consent: ConsentToken | null) {}",
      ].join("\n"),
      "apps/browser/src/state/x.ts": [
        'import { capture, consentToken, noteOther, noteThing, type ConsentToken } from "./telemetry/usage";',
        "declare const p: { then(cb: () => void): void };",
        "declare function onAppEvent(cb: () => void): void;",
        "function helperNoter() { noteThing(); }",
        'function helperToken() { capture("e", {}, consentToken()); }',
        "function helperStart() { const token = consentToken(); begin(token); }",
        "function begin(token: ConsentToken | null) { noteThing(token); noteOther({ times: 1, token } as never); }",
        'function helperLog() { console.warn("x"); }',
        "function onNative() { noteThing(); }",
        "p.then(() => { helperNoter(); helperToken(); helperStart(); helperLog(); });",
        "onAppEvent(() => onNative());",
        "function byReference() { noteThing(); }",
        "p.then(byReference);",
        "function inLoop() { noteThing(); }",
        "async function loop(xs: number[], work: () => Promise<void>) { for (const x of xs) { inLoop(); await work(); } }",
      ].join("\n"),
    });
    const { sinks } = reachSinks(program, scopeFiles(program), new Set(["onAppEvent"]));
    assert.deepEqual(sinks.map((s) => `${s.kind}:${s.line}`), ["noter:4", "consentToken:5", "console:8", "noter:12", "noter:14"]);
  });

  test("for await and awaits inside a call's arguments make the callee continuation work, unless the caller forwards its token", () => {
    const program = virtualProgram({
      "apps/browser/src/state/telemetry/usage.ts": [
        "export type ConsentToken = string & { readonly period: 1 };",
        "export const consentToken = (): ConsentToken | null => null;",
        "export function noteThing(consent?: ConsentToken | null) {}",
        "export function capture(event: string, props: object, consent: ConsentToken | null) {}",
      ].join("\n"),
      "apps/browser/src/state/x.ts": [
        'import { capture, consentToken, noteThing, type ConsentToken } from "./telemetry/usage";',
        "declare function work(): Promise<number>;",
        'function loopHelper() { capture("e", {}, consentToken()); }',
        "function argHelper(v: number) { noteThing(); }",
        "function forwarded(token: ConsentToken | null) { noteThing(token); }",
        "function before() { noteThing(); }",
        "export async function iterate(xs: AsyncIterable<number>) { before(); for await (const x of xs) loopHelper(); }",
        "export async function inline() { argHelper(await work()); }",
        "export async function passOn(token: ConsentToken | null, xs: AsyncIterable<number>) { for await (const x of xs) forwarded(token); }",
      ].join("\n"),
    });
    const { sinks } = reachSinks(program, scopeFiles(program), new Set());
    assert.deepEqual(sinks.map((s) => `${s.kind}:${s.line}`), ["consentToken:3", "noter:4"]);
  });

  test("CodeRabbit's probes: a helper called before an await in a loop body, and a helper passed by name to a timer, are continuation work", () => {
    const program = virtualProgram({
      "apps/browser/src/state/telemetry/usage.ts": [
        "export type ConsentToken = string & { readonly period: 1 };",
        "export const consentToken = (): ConsentToken | null => null;",
        "export function capture(event: string, props: object, consent: ConsentToken | null) {}",
      ].join("\n"),
      "apps/browser/src/state/x.ts": [
        'import { capture, consentToken, type ConsentToken } from "./telemetry/usage";',
        "declare function work(): Promise<void>;",
        "declare function setTimeout(cb: () => void, ms: number): void;",
        'function loopHelper() { capture("e", {}, consentToken()); }',
        "export async function run() { for (let i = 0; i < 2; i++) { loopHelper(); await work(); } }",
        'function forwardedHelper(token: ConsentToken | null) { capture("e", {}, token); }',
        "export async function runForwarding() { const token = consentToken(); for (let i = 0; i < 2; i++) { forwardedHelper(token); await work(); } }",
        'function namedTimer() { capture("e", {}, consentToken()); }',
        "setTimeout(namedTimer, 0);",
        'function inlineTimer() { capture("e", {}, consentToken()); }',
        "setTimeout(() => inlineTimer(), 0);",
      ].join("\n"),
    });
    const { sinks } = reachSinks(program, scopeFiles(program), new Set());
    assert.deepEqual(sinks.map((s) => `${s.kind}:${s.line}`), ["consentToken:4", "consentToken:8", "consentToken:10"]);
  });

  test("an imported take function counts as drained only when the drain root calls it", async () => {
    const { unclearedCounters } = await import("../scripts/consentStatic.mjs");
    const drain = (name) => `export function ${name}() {}`;
    const program = virtualProgram({
      "apps/browser/src/state/telemetry/usage.ts": `${drain("emitCounts")}\n${drain("emitWindowUsage")}`,
      "apps/browser/src/state/telemetry/hourlyExtras.ts": drain("takeHourlyExtras"),
      "apps/browser/src/state/telemetry/focusFeatureCounts.ts": "",
      "apps/browser/src/state/telemetry/workCounts.ts": drain("takeWorkCounts"),
      "apps/browser/src/state/telemetry/tabPresses.ts": drain("emitTabPresses"),
      "apps/browser/src/state/telemetry/counts.ts": "export function takeCalled() { return 1; }\nexport function takeImportedOnly() { return 1; }\nexport function takeRegistered() { return 1; }",
      "apps/browser/src/state/telemetry/consentBoundary.ts": [
        'import { takeCalled, takeImportedOnly, takeRegistered } from "./counts";',
        "declare function onConsentPeriodChange(fn: () => void): void;",
        "onConsentPeriodChange(() => void takeCalled());",
        "onConsentPeriodChange(takeRegistered);",
      ].join("\n"),
    });
    assert.deepEqual(unclearedCounters(program, scopeFiles(program)).uncleared, ["apps/browser/src/state/telemetry/counts.ts | takeImportedOnly"]);
  });

  test("native emits count unless the payload is stamped, on the line or before it", () => {
    const objc = [
      '[ArdiaEvents emit:@"a.plain" data:@{@"x" : @1}];',
      '[ArdiaEvents emit:@"a.stamped" data:[stamp onto:@{}]];',
      'NSDictionary *payload = [[ArdiaConsentStamp begin] onto:@{@"x" : @1}];',
      'dispatch_async(dispatch_get_main_queue(), ^{ [ArdiaEvents emit:@"a.stampedBefore" data:payload]; });',
      'NSDictionary *other = @{};',
      '[ArdiaEvents emit:@"a.unstampedVariable" data:other];',
      '[ArdiaEvents emit:@"a.multiLine"\n  data:@{\n    @"x" : @"y"\n  }];',
    ].join("\n");
    assert.deepEqual(unstampedEmits("x.mm", objc), ["x.mm | a.plain", "x.mm | a.unstampedVariable", "x.mm | a.multiLine"]);
    const swift = 'ArdiaEvents.emit("s.plain", data: event)\nlet stamped = stamp.onto(event)\nArdiaEvents.emit("s.stamped", data: stamped)';
    assert.deepEqual(unstampedEmits("x.swift", swift), ["x.swift | s.plain"]);
    const scoped = [
      "void first() {",
      "  NSDictionary *payload = [stamp onto:@{}];",
      "}",
      "void second(NSDictionary *payload) {",
      '  [ArdiaEvents emit:@"b.unrelatedParameter" data:payload];',
      "}",
      "void third() {",
      "  NSDictionary *payload = [[ArdiaConsentStamp begin] onto:@{}];",
      "  if (ready) {",
      '    dispatch_async(dispatch_get_main_queue(), ^{ [ArdiaEvents emit:@"b.captured" data:payload]; });',
      "  }",
      "}",
    ].join("\n");
    assert.deepEqual(unstampedEmits("y.mm", scoped), ["y.mm | b.unrelatedParameter"]);
  });

  test("a telemetry buffer is a queue or a retry that also emits telemetry", () => {
    const buffer = (text) => isTelemetryBuffer(ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true));
    assert.equal(buffer("const pendingSaves = [];\nexport const save = () => noteSave();"), true);
    assert.equal(buffer("export async function load() { for (let retries = 0; retries < 3; retries++) await go(); console.warn('x'); }"), true);
    assert.equal(buffer("const pendingSaves = [];\nexport const save = () => go();"), false);
    assert.equal(buffer("function f() { const pending = []; noteSave(); }"), false);
  });
}

test("the uncounted-counter class covers Linux telemetry as well as the browser's", async () => {
  const { COUNTER_SCOPE, telemetryModule } = await import("../scripts/consentStatic.mjs");
  assert.ok(COUNTER_SCOPE.test("apps/linux/src/hostTelemetry.ts"));
  assert.ok(COUNTER_SCOPE.test("apps/browser/src/state/telemetry/usage.ts"));
  assert.ok(telemetryModule("apps/linux/src/hostTelemetryCounts.ts"));
  assert.ok(!telemetryModule("apps/linux/src/hostTabs.ts"));
});

test("the virtual program finds its files when paths are built Windows-style, as TypeScript asks with forward slashes", () => {
  const program = virtualProgram({ "apps/browser/src/a.ts": "export const a = 1;", "apps/browser/src/b.ts": "export const b = 2;" }, { root: "C:\\repo", joinPath: win32.join });
  assert.deepEqual(program.getSourceFiles().map((file) => file.fileName.split(/[\\/]/).at(-1)).sort(), ["a.ts", "b.ts"]);
});
