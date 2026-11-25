#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ROOT, TELEMETRY, TEST_FILE, arrivalStamps, declOf, nativeEventSections, queueSection, relOf, unclearedCounters, walk } from "./consentStatic.mjs";
import { DESKTOP_MODES, platformSuffixes } from "../../desktop/desktopModes.ts";

const HELP = `Usage: node apps/browser/scripts/consentReach.mjs [--report | --write | --help]

Freezes the consent gaps the per-file tripwire can't see, as counts per file in
apps/browser/src/consent-reach-baseline.json:
  noter, consentToken, consentNow, console  telemetry in helpers reached from an async continuation
  queues                                    retry and queue buffers that emit telemetry
  unstampedEvents                           native events emitted without a consent stamp
  arrivalStamps                             Linux engine events the host stamps on arrival, not at emission
  unclearedCounters                         take functions the consent-boundary drain never calls

  --report  print the totals, the top files and what differs from the baseline
  --write   regenerate the baseline from the working tree
The check itself runs as apps/browser/src/consentReach.test.mjs.`;

export const BASELINE_PATH = join(ROOT, "apps/browser/src/consent-reach-baseline.json");
const CONSENT_BASELINE = join(ROOT, "apps/browser/src/consent-baseline.json");
const REACH_SECTIONS = ["noter", "consentToken", "consentNow", "console"];
export const SECTIONS = [...REACH_SECTIONS, "queues", "unstampedEvents", "arrivalStamps", "unclearedCounters"];
const SCOPE = /^apps\/(?:browser|desktop)\/src\//;
const LATER = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask", "setImmediate"]);
const PROMISE = new Set(["then", "catch", "finally"]);
const LISTENER = /^(?:on[A-Z]\w*|addListener|addEventListener|subscribe|subscribeTo)$/;
const TOKEN_TAKERS = new Set(["consentNow", "consentToken"]);
const NOTER = /^(?:note|count|track)[A-Z]/;
const SINK_NAME = /^(?:capture|queueLog|warnFor|errorFor|counted|stillValid|(?:note|count|track)[A-Z]\w*)$/;
const CONSENT_TYPE = /\bConsentToken\b/;

export { DESKTOP_MODES };

export const platformSeams = (mode, platform = join(ROOT, "apps/desktop/src/platform")) => ({
  "@platform/*": platformSuffixes(mode).flatMap((suffix) => [`${platform}/*${suffix}.ts`, `${platform}/*${suffix}.tsx`]),
});

export const desktopModuleSuffixes = (mode) => [...platformSuffixes(mode), ".web", ""];

function buildProgram(mode, moduleSuffixes) {
  const dir = join(ROOT, "apps/browser");
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile).config, ts.sys, dir);
  const desktop = walk("apps/desktop/src", /\.tsx?$/).filter((rel) => !TEST_FILE.test(rel)).map((rel) => join(ROOT, rel));
  const paths = { ...config.options.paths, ...platformSeams(mode) };
  return ts.createProgram([...config.fileNames, ...desktop], { ...config.options, paths, ...(moduleSuffixes ? { moduleSuffixes } : {}), noEmit: true });
}

function activityListeners() {
  const keys = Object.keys(JSON.parse(readFileSync(CONSENT_BASELINE, "utf8")));
  return new Set(keys.map((key) => / after (\w+) \| /.exec(key)?.[1]).filter((name) => name && LISTENER.test(name)));
}

export const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "");
const enclosing = (node) => {
  for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at)) return at;
  return null;
};
const isArgumentOf = (fn) => !!fn.parent && ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn);
const unwrapUp = (node) => {
  let at = node;
  while (at.parent && (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isNonNullExpression(at.parent) || (ts.isBinaryExpression(at.parent) && at.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))) at = at.parent;
  return at;
};
const unwrapDown = (node) => (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ? unwrapDown(node.expression) : node);

function continuation(fn, listeners) {
  if (!isArgumentOf(fn)) return null;
  const call = fn.parent;
  const name = calleeName(call);
  if (LATER.has(name)) return "later";
  if (ts.isPropertyAccessExpression(call.expression) && PROMISE.has(name)) return "later";
  if (LISTENER.test(name)) return listeners.has(name) ? "activity" : "later";
  return null;
}

const suspendsBefore = (at, node) =>
  (ts.isAwaitExpression(at) && (at.end <= node.pos || (at.pos >= node.pos && at.end <= node.end))) || (ts.isForOfStatement(at) && !!at.awaitModifier && node.pos >= at.expression.end);

function awaitsBefore(fn, node) {
  let found = false;
  const visit = (at) => {
    if (found || at.pos >= node.end) return;
    if (at !== fn && ts.isFunctionLike(at)) return;
    if (suspendsBefore(at, node)) found = true;
    ts.forEachChild(at, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return found;
}

function loopAwaitsAround(fn, node) {
  for (let at = node.parent; at && at !== fn; at = at.parent) {
    if (!ts.isIterationStatement(at, false)) continue;
    let found = false;
    const visit = (inner) => {
      if (found || (inner !== at.statement && ts.isFunctionLike(inner))) return;
      if (ts.isAwaitExpression(inner)) found = true;
      ts.forEachChild(inner, visit);
    };
    visit(at.statement);
    if (found) return true;
  }
  return false;
}

function chainOf(node, listeners) {
  const prefix = [];
  for (let fn = enclosing(node), inner = node; fn; inner = fn, fn = enclosing(fn)) {
    prefix.push(fn);
    const kind = continuation(fn, listeners);
    if (kind) return { prefix, direct: kind === "later" };
    if (awaitsBefore(fn, inner) || loopAwaitsAround(fn, inner)) return { prefix, direct: true };
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !isArgumentOf(fn)) break;
  }
  return { prefix, direct: false };
}

export function scopeFiles(program, scope = SCOPE) {
  return program.getSourceFiles().filter((file) => !file.isDeclarationFile && scope.test(relOf(file)) && !TEST_FILE.test(relOf(file)));
}

export function reachSinks(program, files, listeners) {
  const checker = program.getTypeChecker();
  const inScope = new Set(files);
  const calls = [];
  for (const file of files) {
    const visit = (node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const callee = new Map();
  const calleeOf = (call) => {
    if (!callee.has(call)) callee.set(call, declOf(checker, call.expression));
    return callee.get(call);
  };
  const reached = new Set();
  const work = [];
  const reach = (decl) => {
    if (decl && inScope.has(decl.getSourceFile()) && !reached.has(decl)) reached.add(decl), work.push(decl);
  };
  const chains = new Map();
  const waiting = new Map();
  for (const call of calls) {
    const chain = chainOf(call, listeners);
    chains.set(call, chain);
    if (chain.direct) reach(calleeOf(call));
    else for (const fn of chain.prefix) waiting.has(fn) ? waiting.get(fn).push(call) : waiting.set(fn, [call]);
  }
  for (const call of calls) {
    const name = calleeName(call);
    const later = LATER.has(name) || (ts.isPropertyAccessExpression(call.expression) && PROMISE.has(name)) || (LISTENER.test(name) && !listeners.has(name));
    if (!later) continue;
    for (const raw of call.arguments) {
      const arg = unwrapDown(raw);
      if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) reach(declOf(checker, arg));
    }
  }
  while (work.length) for (const call of waiting.get(work.pop()) ?? []) reach(calleeOf(call));

  const tokenSymbol = (symbol) => {
    const decl = symbol?.valueDeclaration;
    if (!decl) return false;
    if ((ts.isParameter(decl) || ts.isVariableDeclaration(decl) || ts.isPropertySignature(decl)) && decl.type && CONSENT_TYPE.test(decl.type.getText())) return true;
    return CONSENT_TYPE.test(checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, decl)));
  };
  const forwardsToken = (call) =>
    call.arguments.some((raw) => {
      const arg = unwrapDown(raw);
      if (ts.isIdentifier(arg)) return arg.text !== "undefined" && tokenSymbol(checker.getSymbolAtLocation(arg));
      if (ts.isObjectLiteralExpression(arg))
        return arg.properties.some((p) => (ts.isShorthandPropertyAssignment(p) ? tokenSymbol(checker.getShorthandAssignmentValueSymbol(p)) : ts.isPropertyAssignment(p) && ts.isIdentifier(unwrapDown(p.initializer)) && tokenSymbol(checker.getSymbolAtLocation(unwrapDown(p.initializer)))));
      return false;
    });
  const passesToken = (call, decl) => {
    const at = decl.parameters?.findIndex((p) => p.type && CONSENT_TYPE.test(p.type.getText())) ?? -1;
    const arg = at >= 0 ? call.arguments[at] : undefined;
    return (!!arg && !(ts.isIdentifier(arg) && arg.text === "undefined")) || forwardsToken(call);
  };
  const isTelemetryCall = (call) => SINK_NAME.test(calleeName(call)) || (calleeOf(call) && TELEMETRY.test(relOf(calleeOf(call))));
  const feedsTelemetryCall = (node) => {
    const at = unwrapUp(node);
    return !!at.parent && ts.isCallExpression(at.parent) && at.parent.arguments.includes(at) && isTelemetryCall(at.parent);
  };
  const usedOnlyByTelemetry = (take) => {
    const at = unwrapUp(take);
    if (!ts.isVariableDeclaration(at.parent) || at.parent.initializer !== at || !ts.isIdentifier(at.parent.name)) return feedsTelemetryCall(take);
    const symbol = checker.getSymbolAtLocation(at.parent.name);
    const scope = enclosing(at.parent) ?? at.getSourceFile();
    const uses = [];
    const visit = (node) => {
      if (ts.isIdentifier(node) && node !== at.parent.name && node.text === at.parent.name.text && checker.getSymbolAtLocation(node) === symbol) uses.push(node);
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return uses.length > 0 && uses.every(feedsTelemetryCall);
  };
  const sinkOf = (call) => {
    const name = calleeName(call);
    if (TOKEN_TAKERS.has(name)) return usedOnlyByTelemetry(call) ? name : null;
    const target = call.expression;
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === "console" && (name === "warn" || name === "error")) return "console";
    if (!NOTER.test(name)) return null;
    const decl = calleeOf(call);
    return decl && TELEMETRY.test(relOf(decl)) && !passesToken(call, decl) ? "noter" : null;
  };
  const sinks = [];
  for (const call of calls) {
    if (!chains.get(call).prefix.some((fn) => reached.has(fn))) continue;
    const kind = sinkOf(call);
    if (kind) sinks.push({ kind, rel: relOf(call), line: call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1, start: call.getStart() });
  }
  return { reached: reached.size, sinks };
}

export function reachSinksAcross(programs, listeners) {
  const sinks = new Map();
  let reached = 0;
  for (const program of programs) {
    const result = reachSinks(program, scopeFiles(program), listeners);
    reached = Math.max(reached, result.reached);
    for (const sink of result.sinks) sinks.set(`${sink.kind}|${sink.rel}|${sink.start}`, sink);
  }
  return { reached, sinks: [...sinks.values()] };
}

const bump = (section, key, n = 1) => void (section[key] = (section[key] ?? 0) + n);

export function analyze() {
  const programs = [buildProgram("linux"), ...DESKTOP_MODES.map((mode) => buildProgram(mode, desktopModuleSuffixes(mode)))];
  const [program] = programs;
  const files = scopeFiles(program);
  const found = Object.fromEntries(SECTIONS.map((s) => [s, {}]));
  const { reached, sinks } = reachSinksAcross(programs, activityListeners());
  for (const sink of sinks) bump(found[sink.kind], sink.rel);
  for (const rel of queueSection(files)) bump(found.queues, rel);
  for (const key of nativeEventSections()) bump(found.unstampedEvents, key);
  for (const key of arrivalStamps()) bump(found.arrivalStamps, key);
  const counters = unclearedCounters(program, files);
  for (const key of counters.uncleared) bump(found.unclearedCounters, key);
  return { found: sorted(found), reached, sinks, excludedTakes: counters.excluded };
}

export const sorted = (found) => Object.fromEntries(SECTIONS.map((s) => [s, Object.fromEntries(Object.entries(found[s] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))]));
export const total = (entries = {}) => Object.values(entries).reduce((sum, n) => sum + n, 0);

const NEW_HINT = {
  noter: "new site: take the token where the activity starts and pass it down",
  consentToken: "new site: take the token where the activity starts and pass it down",
  consentNow: "new site: take the token where the activity starts and pass it down",
  console: "new site: take the token where the activity starts and log with warnFor/errorFor",
  queues: "new buffer that emits telemetry: keep the token taken when each item was queued",
  unstampedEvents: "new unstamped native event: stamp its payload with ArdiaConsentStamp onto:",
  arrivalStamps: "new Linux event stamped on arrival: the engine has to stamp it when it is emitted",
  unclearedCounters: "new take function the consent-boundary drain never calls: drain it from takeHourlyExtras, emitCounts or consentBoundary",
};

export function compare(baseline, found) {
  const problems = [];
  for (const section of SECTIONS) {
    const lines = [];
    const keys = new Set([...Object.keys(baseline[section] ?? {}), ...Object.keys(found[section] ?? {})]);
    for (const key of [...keys].sort()) {
      const was = baseline[section]?.[key] ?? 0;
      const now = found[section]?.[key] ?? 0;
      if (now > was) lines.push(`  new    ${key}: ${now}${was ? ` (baseline ${was})` : ""}, ${NEW_HINT[section]}`);
      else if (now < was) lines.push(`  fixed  ${key}: ${now} (baseline ${was}), fixed: lower the baseline`);
    }
    if (lines.length) problems.push(`${section} (${lines.length})`, ...lines);
  }
  return problems;
}

export const scoreboard = (found) => SECTIONS.map((s) => `${s} ${Object.keys(found[s]).length} files / ${total(found[s])}`).join(", ");
export const readBaseline = () => (existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {});

export function writeBaseline({ found }) {
  const previous = readBaseline();
  for (const section of SECTIONS) {
    const added = Object.keys(found[section]).filter((key) => !(key in (previous[section] ?? {})));
    console.log(`${section}: ${total(previous[section])} -> ${total(found[section])}${added.length ? `, new entries: ${added.join(", ")}` : ""}`);
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(found, null, 2) + "\n");
  console.log(`Wrote ${relative(ROOT, BASELINE_PATH)}: ${scoreboard(found)}`);
}

function report(result) {
  console.log(`reachable functions ${result.reached}, ${scoreboard(result.found)}`);
  for (const section of SECTIONS) {
    const top = Object.entries(result.found[section]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`${section}: ${total(result.found[section])}`);
    for (const [key, n] of top) console.log(`  ${n} ${key}`);
  }
  console.log(`take functions left out as UI state: ${result.excludedTakes.join(", ")}`);
  const problems = compare(readBaseline(), result.found);
  console.log(problems.length ? `\nAgainst the baseline:\n${problems.join("\n")}` : "\nMatches the baseline.");
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) console.log(HELP);
  else if (process.argv.includes("--write")) writeBaseline(analyze());
  else process.exitCode = report(analyze());
}
