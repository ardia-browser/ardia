import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const TEST_FILE = /\.test\.[cm]?[jt]sx?$|\.d\.ts$|(?:^|\/)(?:test-native|fixtures)\//;
export const TELEMETRY = /^apps\/browser\/src\/state\/telemetry\//;
const BUFFER_NAME = /Queue|queue|Pending|pending|Waiting|waiting|Inflight|inflight|InFlight|Batch|batch|Retr|retr|Backlog|backlog|Held|held|Deferred|deferred/;
const RETRY_TEXT = /retry|retries|backoff|requeue|pending\.push|queue\.push|batch(?:es)?\.push/;
const TELEMETRY_SINK = /\bcapture\(|\bqueueLog\(|\bnote[A-Z]\w*\(|\bcount[A-Z]\w*\(|\bwarnFor\(|\berrorFor\(|\bconsole\.(?:warn|error)\(/;
const BUFFER_EXEMPT = new Set(["client", "daily", "transport", "localStore"].map((name) => `apps/browser/src/state/telemetry/${name}.ts`));
const NATIVE_DIRS = ["packages/ardiacore/ios", "packages/shell/ios"];
const NATIVE_FILE = /\.(?:mm|m|h|swift)$/;
const EMIT = /\[ArdiaEvents\s+emit:\s*@"([^"]+)"|\bArdiaEvents\.emit\(\s*"([^"]+)"/g;
const STAMP = /\bonto\s*[:(]/;
const TAKE = /^take[A-Z]\w*$/;
const PLATFORM_VARIANT = /\.(web|native|macos|ios|windows|linux)\.(tsx?)$/;
const DRAINS = [
  ["apps/browser/src/state/telemetry/usage.ts", ["emitCounts", "emitWindowUsage"]],
  ["apps/browser/src/state/telemetry/hourlyExtras.ts", ["takeHourlyExtras"]],
  ["apps/browser/src/state/telemetry/focusFeatureCounts.ts", null],
  ["apps/browser/src/state/telemetry/workCounts.ts", ["takeWorkCounts"]],
  ["apps/browser/src/state/telemetry/consentBoundary.ts", null],
  ["apps/browser/src/state/telemetry/tabPresses.ts", ["emitTabPresses"]],
];

export function walk(rel, match) {
  const out = [];
  if (!existsSync(join(ROOT, rel))) return out;
  for (const name of readdirSync(join(ROOT, rel))) {
    if (name === "node_modules") continue;
    const child = `${rel}/${name}`;
    if (statSync(join(ROOT, child)).isDirectory()) out.push(...walk(child, match));
    else if (match.test(name)) out.push(child);
  }
  return out;
}

export const relOf = (node) => relative(ROOT, node.getSourceFile().fileName).split("\\").join("/");

export function declOf(checker, expr) {
  const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
  let symbol = checker.getSymbolAtLocation(target);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!decl) return null;
  if (ts.isFunctionLike(decl)) return decl;
  const init = ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl) ? decl.initializer : null;
  return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
}

const bindingNames = (name) => (ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name))));

export function isTelemetryBuffer(file) {
  const declared = file.statements
    .filter((s) => ts.isVariableStatement(s) && s.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))
    .flatMap((s) => s.declarationList.declarations.flatMap((d) => bindingNames(d.name)));
  return (declared.some((name) => BUFFER_NAME.test(name)) || RETRY_TEXT.test(file.text)) && TELEMETRY_SINK.test(file.text);
}

export const queueSection = (files) => files.filter((file) => !BUFFER_EXEMPT.has(relOf(file)) && isTelemetryBuffer(file)).map(relOf);

function balanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "[" || c === "(" || c === "{") depth++;
    else if ((c === "]" || c === ")" || c === "}") && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const CONTROL = /^(?:if|for|while|switch|else|do|catch|guard|defer|repeat|@\w+)\b|\^\s*(?:\([^)]*\))?\s*$|\b(?:if|for|while|switch)\s*\(/;
const FUNCTION_HEADER = (header) => /\bfunc\b|\binit\s*\(|^[-+]\s*\(/.test(header) || (/\)\s*$/.test(header) && !CONTROL.test(header));

function enclosingFunctionStart(text, at) {
  const opens = [];
  for (let i = 0; i < at; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < at && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "{") opens.push(i);
    else if (c === "}") opens.pop();
  }
  for (let k = opens.length - 1; k >= 0; k--) {
    const open = opens[k];
    const before = text.slice(0, open);
    const header = before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}")) + 1).trim();
    if (FUNCTION_HEADER(header)) return open;
  }
  return 0;
}

function stampedBefore(text, at, name, swift) {
  const from = enclosingFunctionStart(text, at);
  const assignments = [...text.slice(from, at).matchAll(new RegExp(`\\b${name}\\s*=(?!=)`, "g"))];
  const last = assignments.at(-1);
  if (!last) return false;
  const rest = text.slice(from + last.index);
  const end = swift ? rest.indexOf("\n") : rest.indexOf(";");
  return STAMP.test(end < 0 ? rest : rest.slice(0, end));
}

export function unstampedEmits(rel, text) {
  const swift = rel.endsWith(".swift");
  const out = [];
  for (const match of text.matchAll(EMIT)) {
    const call = balanced(text, match[1] ? match.index : match.index + match[0].indexOf("("));
    if (STAMP.test(call)) continue;
    const data = /data:\s*([A-Za-z_]\w*)\s*[\])]$/.exec(call)?.[1];
    if (data && stampedBefore(text, match.index, data, swift)) continue;
    out.push(`${rel} | ${match[1] ?? match[2]}`);
  }
  return out;
}

export const arrivalStamps = () =>
  walk("apps/linux/src", /^host\w*\.tsx?$/)
    .filter((rel) => !TEST_FILE.test(rel))
    .flatMap((rel) => [...readFileSync(join(ROOT, rel), "utf8").matchAll(/name !== "(\w+)"[^\n]*\n(?:[^\n]*\n){0,3}?[^\n]*epoch: consentEpoch\(\)/g)].map((m) => `${rel} | ${m[1]}`));

export const nativeEventSections = () => NATIVE_DIRS.flatMap((dir) => walk(dir, NATIVE_FILE)).flatMap((rel) => unstampedEmits(rel, readFileSync(join(ROOT, rel), "utf8")));

function topFunctions(file) {
  const out = [];
  const isFunction = (init) => init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
  for (const s of file.statements) {
    const exported = !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(s) && s.name) out.push({ name: s.name.text, node: s, exported });
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && isFunction(d.initializer)) out.push({ name: d.name.text, node: d.initializer, exported });
  }
  return out;
}

const nameOf = (decl) => (decl.name && ts.isIdentifier(decl.name) ? decl.name.text : decl.parent && ts.isVariableDeclaration(decl.parent) && ts.isIdentifier(decl.parent.name) ? decl.parent.name.text : "");

function drainedFunctions(program, files) {
  const checker = program.getTypeChecker();
  const byRel = new Map(files.map((file) => [relOf(file), file]));
  const roots = DRAINS.flatMap(([rel, names]) => {
    const file = byRel.get(rel);
    if (!file) throw new Error(`the drain file ${rel} is gone: update DRAINS in apps/browser/scripts/consentStatic.mjs`);
    if (!names) return [file];
    return names.map((name) => {
      const fn = topFunctions(file).find((f) => f.name === name);
      if (!fn) throw new Error(`the drain ${name} is gone from ${rel}: update DRAINS in apps/browser/scripts/consentStatic.mjs`);
      return fn.node;
    });
  });
  const seen = new Set(roots);
  const work = [...roots];
  while (work.length) {
    const called = (node) => {
      const at = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
      return !!at.parent && ts.isCallExpression(at.parent) && (at.parent.expression === at || at.parent.arguments.includes(at));
    };
    const visit = (node) => {
      if (ts.isIdentifier(node) && called(node)) {
        const decl = declOf(checker, node);
        if (decl && !seen.has(decl) && !decl.getSourceFile().isDeclarationFile) {
          seen.add(decl);
          if (TELEMETRY.test(relOf(decl)) || TAKE.test(nameOf(decl))) work.push(decl);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(work.pop());
  }
  return seen;
}

export const COUNTER_SCOPE = /^apps\/(?:browser|linux)\/src\//;
const LINUX_TELEMETRY = /^apps\/linux\/src\/\w*[Tt]elemetry\w*\.tsx?$/;
export const telemetryModule = (rel) => TELEMETRY.test(rel) || LINUX_TELEMETRY.test(rel);

export function unclearedCounters(program, files) {
  const drained = drainedFunctions(program, files);
  const browser = files.filter((file) => COUNTER_SCOPE.test(relOf(file)));
  const telemetryText = browser.filter((file) => telemetryModule(relOf(file))).map((file) => file.text).join("\n");
  const byRel = new Map(browser.map((file) => [relOf(file), file]));
  const drainedInBase = (rel, name) => {
    const base = byRel.get(rel.replace(PLATFORM_VARIANT, ".$2"));
    return !!base && base !== byRel.get(rel) && topFunctions(base).some((fn) => fn.name === name && drained.has(fn.node));
  };
  const uncleared = [];
  const excluded = [];
  for (const file of browser) {
    const rel = relOf(file);
    for (const fn of topFunctions(file)) {
      if (!fn.exported || !TAKE.test(fn.name) || drained.has(fn.node) || drainedInBase(rel, fn.name)) continue;
      if (!telemetryModule(rel) && !new RegExp(`\\b${fn.name}\\b`).test(telemetryText)) excluded.push(fn.name);
      else uncleared.push(`${rel} | ${fn.name}`);
    }
  }
  return { uncleared, excluded: excluded.sort() };
}
