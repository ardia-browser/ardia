#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: generate.mjs [--check|--write]
Reads the host API schema in packages/hostapi/schema and writes, or checks, what it generates:
each domain's TypeScript call and event types and the manifest in packages/ardiacore/src/engine/generated,
the Swift module of every domain the Mac serves straight from the engine, and the call table of every domain
whose Mac module serves some calls itself, which that hand-written module builds with its own handlers.`;

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const GENERATED_TS = "packages/ardiacore/src/engine/generated/";
export const MANIFEST = `${GENERATED_TS}manifest.json`;
export const SWIFT = "packages/ardiacore/ios/";
export const HOSTS = ["mac", "desktop", "windows"];
const BINDINGS = { mac: new Set(["service", "custom", "absent"]), desktop: new Set(["route", "custom", "absent"]), windows: new Set(["service", "custom", "absent"]) };
const EVENT_BINDINGS = new Set(["forward", "custom", "absent"]);
const NAME = /^[a-z][a-zA-Z]*$/;
const SERVICE = /^ac_[a-z][a-z_]*$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;
const TOPIC = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)?$/;

const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const sortedKeys = (record) => Object.keys(record).sort();
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export async function loadDomains() {
  const { domains } = await import(new URL("./schema/index.ts", import.meta.url).href);
  for (const [name, domain] of Object.entries(domains)) validate(name, domain);
  return domains;
}

export function validate(name, domain) {
  const fail = (message) => {
    throw new Error(`schema ${name}: ${message}`);
  };
  if (!NAME.test(name)) fail("the domain's name is lowerCamelCase letters");
  if (domain.kind !== "engine") fail("kind is engine: JSON calls to ac_* services; positional module domains have no generator yet");
  for (const [path, names] of Object.entries(domain.imports ?? {})) {
    if (!path.startsWith(".")) fail(`import ${path} is relative to the generated folder`);
    for (const type of names) if (!TYPE_NAME.test(type)) fail(`import ${type} from ${path} is a type name`);
  }
  for (const [verb, call] of Object.entries(domain.calls ?? {})) {
    if (!NAME.test(verb)) fail(`call ${verb} is lowerCamelCase letters`);
    if (typeof call.args !== "string" || !call.args.trim()) fail(`${verb} names its args type`);
    if (typeof call.result !== "string" || !call.result.trim()) fail(`${verb} names its result type`);
    if (call.desktop === undefined) fail(`${verb} says whether the desktop host routes it: desktop is route, custom or absent, never implied`);
    for (const host of HOSTS) if (call[host] !== undefined && !BINDINGS[host].has(call[host])) fail(`${verb}.${host} is one of ${[...BINDINGS[host]].join(", ")}`);
    if (call.service !== undefined && !SERVICE.test(call.service)) fail(`${verb}'s service is an ac_* call`);
    if (call.routeField !== undefined && call.desktop !== "route") fail(`${verb}.routeField picks the field of the engine's reply a desktop route answers with, so it goes only with desktop: route`);
    if (call.routeField !== undefined && !NAME.test(call.routeField)) fail(`${verb}.routeField is a lowerCamelCase field of the engine's reply, or null to answer null`);
    if (call.service === undefined && HOSTS.some((host) => passesStraight(call, host))) fail(`${verb}'s service is an ac_* call: a host passes it straight to the engine`);
  }
  for (const [event, row] of Object.entries(domain.events ?? {})) {
    if (!NAME.test(event)) fail(`event ${event} is lowerCamelCase letters`);
    if (!isRecord(row)) fail(`event ${event} is { payload, desktop } with any mac or windows binding`);
    if (typeof row.payload !== "string" || !row.payload.trim()) fail(`event ${event} names its payload type`);
    if (row.desktop === undefined) fail(`event ${event} says whether the desktop host forwards it: desktop is forward, custom or absent, never implied`);
    for (const host of HOSTS) if (row[host] !== undefined && !EVENT_BINDINGS.has(row[host])) fail(`event ${event}.${host} is one of ${[...EVENT_BINDINGS].join(", ")}`);
    if (row.topic === undefined) continue;
    if (typeof row.topic !== "string" || !TOPIC.test(row.topic)) fail(`event ${event}'s topic is the engine topic a host forwards, letters with at most one dot`);
    if (row.topic === `${name}.${event}`) fail(`event ${event} leaves out topic when the engine topic is the event's own name`);
    if (row.desktop === "forward") fail(`event ${event} is renamed from topic ${row.topic}, and the desktop host forwards a topic only under its own name`);
    if (!HOSTS.some((host) => eventBindingOf(row, host) === "forward")) fail(`event ${event}'s topic is only for a host that forwards it`);
  }
}

export const bindingOf = (call, host) => call[host] ?? "service";
export const eventBindingOf = (event, host) => event[host] ?? "forward";
const passesStraight = (call, host) => bindingOf(call, host) === (host === "desktop" ? "route" : "service");

function typescript(name, domain) {
  const lines = [];
  for (const path of sortedKeys(domain.imports ?? {})) {
    lines.push(`import type { ${[...domain.imports[path]].sort().join(", ")} } from "${path}";`);
  }
  if (lines.length) lines.push("");
  const block = (typeName, rows) => {
    if (!rows.length) return [`export type ${typeName} = {};`];
    return [`export type ${typeName} = {`, ...rows.map((row) => `  ${row}`), "};"];
  };
  const calls = Object.entries(domain.calls ?? {}).map(([verb, call]) => `"${name}.${verb}": [${call.args}, ${call.result}];`);
  const events = Object.entries(domain.events ?? {}).map(([event, row]) => `"${name}.${event}": ${row.payload};`);
  lines.push(...block(`${capitalized(name)}Calls`, calls), "", ...block(`${capitalized(name)}Events`, events));
  return `${lines.join("\n")}\n`;
}

const servedByEngine = (domain) => Object.values(domain.calls ?? {}).every((call) => bindingOf(call, "mac") === "service");

export const swiftPath = (name, domain) => `${SWIFT}${capitalized(name)}${servedByEngine(domain) ? "Module" : "Calls"}.swift`;

const swiftRow = (verb, call) => {
  const binding = bindingOf(call, "mac");
  if (binding === "service") return `    "${verb}": EngineCall.passing("${call.service}"),`;
  if (binding === "custom") return `    "${verb}": ${verb}Handler,`;
  return null;
};

function swiftModule(name, domain) {
  const hasEvents = Object.keys(domain.events ?? {}).length > 0;
  const lines = [
    "import ExpoModulesCore",
    "",
    `public class ${capitalized(name)}Module: Module {`,
    "  public func definition() -> ModuleDefinition {",
    "    Name(Self.calls.moduleName)",
    ...(hasEvents ? ["    Events(Self.calls.domain)", "    Self.calls.forwardEvents(to: self)"] : []),
    "",
    "    Self.calls.function",
    "  }",
    "",
    ...swiftHandlers("  static let calls = ", name, Object.entries(domain.calls ?? {}).map(([verb, call]) => `    "${verb}": EngineCall.passing("${call.service}"),`)),
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

const SWIFT_UNLABELABLE = new Set(["inout", "var", "let"]);
const swiftLabel = (verb) => (SWIFT_UNLABELABLE.has(verb) ? `\`${verb}\`` : verb);

function swiftHandlers(prefix, name, rows) {
  if (rows.length === 0) return [`${prefix}CallTable(domain: "${name}", handlers: [:])`];
  return [`${prefix}CallTable(domain: "${name}", handlers: [`, ...rows, "  ])"];
}

function swiftCalls(name, domain) {
  const custom = Object.entries(domain.calls ?? {}).filter(([, call]) => bindingOf(call, "mac") === "custom").map(([verb]) => verb);
  const lines = [
    "import ExpoModulesCore",
    "",
    `func ${name}CallTable(${custom.map((verb) => `${swiftLabel(verb)} ${verb}Handler: @escaping CallHandler`).join(", ")}) -> CallTable {`,
    ...swiftHandlers("  ", name, Object.entries(domain.calls ?? {}).map(([verb, call]) => swiftRow(verb, call)).filter((row) => row !== null)),
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

function manifest(domains) {
  const out = { domains: {} };
  for (const name of Object.keys(domains)) {
    const domain = domains[name];
    const calls = {};
    for (const [verb, call] of Object.entries(domain.calls ?? {})) {
      calls[verb] = {
        ...(call.service === undefined ? {} : { service: call.service }),
        ...Object.fromEntries(HOSTS.map((host) => [host, bindingOf(call, host)])),
        ...(call.routeField === undefined ? {} : { routeField: call.routeField }),
      };
    }
    const events = {};
    for (const [event, row] of Object.entries(domain.events ?? {})) {
      events[event] = { topic: row.topic ?? `${name}.${event}`, ...Object.fromEntries(HOSTS.map((host) => [host, eventBindingOf(row, host)])) };
    }
    out.domains[name] = {
      kind: domain.kind,
      types: `${GENERATED_TS}${name}.ts`,
      swift: swiftPath(name, domain),
      calls,
      events,
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function outputs(domains) {
  const files = new Map();
  for (const name of Object.keys(domains)) {
    const domain = domains[name];
    files.set(`${GENERATED_TS}${name}.ts`, typescript(name, domain));
    files.set(swiftPath(name, domain), servedByEngine(domain) ? swiftModule(name, domain) : swiftCalls(name, domain));
  }
  files.set(MANIFEST, manifest(domains));
  return files;
}

function previousManifest() {
  if (!existsSync(ROOT + MANIFEST)) return { domains: {} };
  let previous;
  try {
    previous = JSON.parse(readFileSync(ROOT + MANIFEST, "utf8"));
  } catch (error) {
    throw new Error(`${MANIFEST} isn't valid JSON (${error.message}); restore it from git before regenerating`);
  }
  if (previous === null || typeof previous !== "object" || previous.domains === null || typeof previous.domains !== "object" || Array.isArray(previous.domains)) {
    throw new Error(`${MANIFEST} has no domains object; restore it from git before regenerating`);
  }
  return previous;
}

function previousDomain(name, entry) {
  if (!NAME.test(name) || !isRecord(entry) || entry.kind !== "engine" || !isRecord(entry.calls)) return null;
  const events = Array.isArray(entry.events) ? entry.events : isRecord(entry.events) ? Object.keys(entry.events) : entry.events === undefined ? [] : null;
  if (events === null || !events.every((event) => typeof event === "string" && NAME.test(event))) return null;
  for (const [verb, call] of Object.entries(entry.calls)) {
    if (!NAME.test(verb) || !isRecord(call)) return null;
    if (call.service !== undefined && (typeof call.service !== "string" || !SERVICE.test(call.service))) return null;
    if (call.mac !== undefined && !BINDINGS.mac.has(call.mac)) return null;
    if (call.service === undefined && bindingOf(call, "mac") === "service") return null;
  }
  return { calls: entry.calls, events: Object.fromEntries(events.map((event) => [event, ""])) };
}

function previouslyGenerated() {
  const owned = [];
  for (const [name, entry] of Object.entries(previousManifest().domains)) {
    const domain = previousDomain(name, entry);
    if (domain === null) continue;
    const types = `${GENERATED_TS}${name}.ts`;
    if (entry.types === types && existsSync(ROOT + types)) owned.push(types);
    const swift = swiftPath(name, domain);
    if (entry.swift === swift && existsSync(ROOT + swift)) {
      const expected = servedByEngine(domain) ? swiftModule(name, domain) : swiftCalls(name, domain);
      if (readFileSync(ROOT + swift, "utf8") === expected) owned.push(swift);
    }
  }
  return owned;
}

const retired = (files) => [...new Set(previouslyGenerated())].filter((path) => !files.has(path));

const blocked = (files) => {
  const owned = new Set(previouslyGenerated());
  return [...files].filter(([path, text]) => path !== MANIFEST && existsSync(ROOT + path) && readFileSync(ROOT + path, "utf8") !== text && !owned.has(path)).map(([path]) => path);
};

const strays = (files) => {
  if (!existsSync(ROOT + GENERATED_TS)) return [];
  const owned = new Set(previouslyGenerated());
  return readdirSync(ROOT + GENERATED_TS).map((file) => GENERATED_TS + file).filter((path) => !files.has(path) && !owned.has(path));
};

export function stale(files) {
  const problems = [];
  for (const [path, text] of files) {
    const at = ROOT + path;
    if (!existsSync(at)) problems.push(`missing ${path}`);
    else if (readFileSync(at, "utf8") !== text) problems.push(`out of date ${path}`);
  }
  for (const path of retired(files)) problems.push(`not generated by the schema ${path}`);
  for (const path of strays(files)) problems.push(`not written by the generator, remove it by hand: ${path}`);
  for (const path of blocked(files)) problems.push(`the schema would overwrite a file the generator didn't write: ${path}`);
  return problems;
}

async function main(argv) {
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "--check" && mode !== "--write")) {
    console.error(USAGE);
    process.exit(2);
  }
  const files = outputs(await loadDomains());
  try {
    retired(files);
    const left = strays(files).map((path) => `not written by the generator, remove it by hand: ${path}`);
    const kept = blocked(files).map((path) => `the schema would overwrite a file the generator didn't write: ${path}`);
    if (mode === "--write" && (left.length || kept.length)) throw new Error([...left, ...kept].join("\n"));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (mode === "--write") {
    for (const path of retired(files)) rmSync(ROOT + path);
    for (const [path, text] of files) {
      mkdirSync(dirname(ROOT + path), { recursive: true });
      writeFileSync(ROOT + path, text);
    }
    console.log(`wrote ${[...files.keys()].map((path) => relative(ROOT, ROOT + path)).join(", ")}`);
    return;
  }
  const problems = stale(files);
  if (problems.length) {
    console.error(`${problems.join("\n")}\nrun: node packages/hostapi/generate.mjs --write`);
    process.exit(1);
  }
  console.log(`up to date: ${files.size} files`);
}

const runAsScript = import.meta.main ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
if (runAsScript) await main(process.argv.slice(2));
