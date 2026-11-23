#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: generate.mjs [--check|--write]
Reads the host API schema in packages/hostapi/schema and writes, or checks, what it generates:
each domain's TypeScript call and event types and the manifest in packages/ardiacore/src/engine/generated,
the Swift module of every domain the Mac serves straight from the engine, and the call table of every domain
whose Mac module serves some calls itself, which that hand-written module builds with its own handlers.
For each module domain (positional Expo functions) it writes the package's TypeScript *Native types in
<package>/src/generated/native.ts, the Swift protocols its Mac modules conform to in <package>/ios/<Domain>Native.swift,
and the domain's entry under the manifest's modules.`;

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
const CLIENT_PACKAGE = "packages/ardiacore/package.json";
export const clientPackages = new Set(Object.keys(JSON.parse(readFileSync(ROOT + CLIENT_PACKAGE, "utf8")).dependencies ?? {}));
const isRelative = (path) => path.startsWith("./") || path.startsWith("../");
const RELATIVE_SPECIFIER = /^(?:\.\.?\/)+[A-Za-z0-9_@-][A-Za-z0-9._@-]*(?:\/[A-Za-z0-9_@-][A-Za-z0-9._@-]*)*$/;

const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const sortedKeys = (record) => Object.keys(record).sort();
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const MODULE_NAME = /^Ardia[A-Z][A-Za-z]*$/;
const PACKAGE = /^packages\/[a-z][a-z0-9-]*$/;
const PARAMETER = /^[a-z][a-zA-Z0-9]*$/;
const MODULE_BINDINGS = { mac: new Set(["custom", "absent"]), desktop: new Set(["custom", "host", "absent"]), windows: new Set(["custom", "absent"]) };
const SWIFT_TYPES = { string: "String", boolean: "Bool", number: "Double", void: "Void", "string[]": "[String]", "number[]": "[Double]", "boolean[]": "[Bool]" };
const RESERVED = new Set([
  "as", "associatedtype", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "defer", "deinit", "delete", "do", "else", "enum", "export", "extends", "extension",
  "fallthrough", "false", "fileprivate", "finally", "for", "func", "function", "guard", "if", "import", "in", "init", "inout", "instanceof", "internal", "is", "let", "new", "nil", "null", "open",
  "operator", "private", "promise", "protocol", "public", "repeat", "rethrows", "return", "self", "static", "struct", "subscript", "super", "switch", "this", "throw", "throws", "true", "try",
  "typealias", "typeof", "var", "void", "where", "while", "with", "yield",
]);

const SWIFT_KEYWORDS = new Set([
  "Any", "Self", "as", "associatedtype", "await", "break", "case", "catch", "class", "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough", "false",
  "fileprivate", "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil", "open", "operator", "precedencegroup", "private", "protocol", "public",
  "repeat", "rethrows", "return", "self", "some", "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while",
]);
export const swiftName = (name) => (SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name);
const digest = (text) => createHash("sha256").update(text).digest("hex");

const TS_GLOBAL_TYPES = new Set(["Array", "Boolean", "Date", "Error", "Function", "Map", "Number", "Object", "Omit", "Partial", "Pick", "Promise", "PromiseLike", "Readonly", "ReadonlyArray", "Record", "Required", "Set", "String", "Symbol"]);

const schema = () => import(new URL("./schema/index.ts", import.meta.url).href);

export async function loadDomains() {
  const { domains } = await schema();
  for (const [name, domain] of Object.entries(domains)) validate(name, domain);
  validateTopics(domains);
  return domains;
}

export async function loadModuleDomains() {
  const { domains, moduleDomains } = await schema();
  for (const [name, domain] of Object.entries(moduleDomains)) validateModuleDomain(name, domain);
  validateModuleNames(domains, moduleDomains);
  return moduleDomains;
}

export const nativeTypeOf = (module) => `${module.slice("Ardia".length)}Native`;
export const modulePaths = (name, pkg) => ({ types: `${pkg}/src/generated/native.ts`, swift: `${pkg}/ios/${capitalized(name)}Native.swift` });
const packageDependencies = (pkg) => {
  const at = `${ROOT}${pkg}/package.json`;
  if (!existsSync(at)) return null;
  return new Set(Object.keys(JSON.parse(readFileSync(at, "utf8")).dependencies ?? {}));
};
export const swiftTypeOf = (type, explicit) => explicit ?? SWIFT_TYPES[type];

export function validateModuleDomain(name, domain) {
  const fail = (message) => {
    throw new Error(`schema ${name}: ${message}`);
  };
  if (!NAME.test(name)) fail("the domain's name is lowerCamelCase letters");
  if (domain.kind !== "module") fail("kind is module: positional Expo functions, listed in moduleDomains");
  if (typeof domain.package !== "string" || !PACKAGE.test(domain.package)) fail("package is the folder of the Expo module package, packages/<name>");
  const dependencies = packageDependencies(domain.package);
  if (dependencies === null) fail(`package ${domain.package} has no package.json`);
  const declared = new Set();
  const declare = (type, what) => {
    if (TS_GLOBAL_TYPES.has(type)) fail(`${what} ${type} would shadow TypeScript's own ${type}, which the generated types use`);
    if (declared.has(type)) fail(`${what} ${type} is declared twice in the generated file`);
    declared.add(type);
  };
  declare(`${capitalized(name)}Modules`, "the domain's module map");
  for (const [path, names] of Object.entries(domain.imports ?? {})) {
    if (!isRelative(path) && !dependencies.has(path)) fail(`import ${path} is relative to the generated folder, or a package ${domain.package}/package.json depends on`);
    if (isRelative(path) && !RELATIVE_SPECIFIER.test(path)) fail(`import ${JSON.stringify(path)} is a relative path of letters, digits, dots, dashes, underscores and slashes`);
    for (const type of names) {
      if (!TYPE_NAME.test(type)) fail(`import ${type} from ${path} is a type name`);
      declare(type, "import");
    }
  }
  if (!isRecord(domain.types ?? {})) fail("types maps type names to the TypeScript types they stand for");
  for (const [type, body] of Object.entries(domain.types ?? {})) {
    if (!TYPE_NAME.test(type)) fail(`type ${type} is a type name`);
    if (typeof body !== "string" || !body.trim()) fail(`type ${type} names the TypeScript type it stands for`);
    declare(type, "type");
  }
  if (!isRecord(domain.modules) || Object.keys(domain.modules).length === 0) fail("modules lists at least one Expo module by its native name");
  for (const [module, entry] of Object.entries(domain.modules)) {
    if (!MODULE_NAME.test(module)) fail(`module ${module} is an Expo module name, Ardia followed by UpperCamelCase letters`);
    declare(nativeTypeOf(module), "module");
    if (!isRecord(entry) || !isRecord(entry.functions) || !isRecord(entry.events)) fail(`module ${module} is { functions, events }`);
    if (Object.keys(entry.events).length) declare(`${nativeTypeOf(module)}Events`, "module events");
    for (const [fn, row] of Object.entries(entry.functions)) validateModuleFunction(fail, `${module}.${fn}`, fn, row);
    for (const [event, row] of Object.entries(entry.events)) {
      const at = `${module}.${event}`;
      if (!NAME.test(event)) fail(`event ${at} is lowerCamelCase letters`);
      if (!isRecord(row)) fail(`event ${at} is { payload, mac, desktop, windows }`);
      if (typeof row.payload !== "string" || !row.payload.trim()) fail(`event ${at} names its payload type`);
      validateModuleBindings(fail, `event ${at}`, row);
      if (event === "event") fail(`event ${at} would generate send${capitalized(event)}, which is Expo's own Module.sendEvent`);
    }
    const members = new Map([["moduleName", "the module's name"], ["eventsDefinition", "the module's events"]]);
    for (const fn of Object.keys(entry.functions)) {
      for (const member of [fn, `${fn}Function`]) {
        if (members.has(member)) fail(`function ${module}.${fn} generates the Swift member ${member}, which ${members.get(member)} already generates`);
        members.set(member, `function ${module}.${fn}`);
      }
    }
  }
}

function validateModuleBindings(fail, what, row) {
  for (const host of HOSTS) {
    if (row[host] === undefined) fail(`${what} says how ${host} serves it: ${host} is one of ${[...MODULE_BINDINGS[host]].join(", ")}, never implied`);
    if (!MODULE_BINDINGS[host].has(row[host])) fail(`${what}.${host} is one of ${[...MODULE_BINDINGS[host]].join(", ")}`);
  }
}

function validateModuleFunction(fail, at, fn, row) {
  if (!NAME.test(fn)) fail(`function ${at} is lowerCamelCase letters`);
  if (!isRecord(row)) fail(`function ${at} is { args, result, async, mac, desktop, windows }`);
  if (!Array.isArray(row.args)) fail(`function ${at} lists its positional args as [name, type] or [name, type, swift]`);
  const names = new Set();
  for (const arg of row.args) {
    if (!Array.isArray(arg) || (arg.length !== 2 && arg.length !== 3) || !arg.every((part) => typeof part === "string" && part.trim())) fail(`function ${at}'s args are [name, type] or [name, type, swift]`);
    const [param, type, swift] = arg;
    if (!PARAMETER.test(param) || RESERVED.has(param)) fail(`function ${at}'s arg ${param} is a lowerCamelCase name neither TypeScript nor Swift reserves`);
    if (names.has(param)) fail(`function ${at} names arg ${param} twice`);
    names.add(param);
    if (type === "void") fail(`function ${at}'s arg ${param} has a type`);
    if (swiftTypeOf(type, swift) === undefined) fail(`function ${at}'s arg ${param} says its Swift type: ${type} isn't one of ${Object.keys(SWIFT_TYPES).filter((t) => t !== "void").join(", ")}`);
  }
  if (typeof row.result !== "string" || !row.result.trim()) fail(`function ${at} names its result type`);
  if (typeof row.async !== "boolean") fail(`function ${at} says whether it's async: true for a Promise, false for a synchronous value`);
  if (row.promise !== undefined && row.promise !== true) fail(`function ${at}.promise is true or left out`);
  if (row.promise && !row.async) fail(`function ${at} resolves a Promise itself, so it's async`);
  if (row.queue !== undefined && row.queue !== "main") fail(`function ${at}.queue is main or left out`);
  if (row.queue !== undefined && !row.async) fail(`function ${at} runs on a queue only when it's async`);
  if (row.swiftResult !== undefined && (typeof row.swiftResult !== "string" || !row.swiftResult.trim())) fail(`function ${at}.swiftResult is a Swift type`);
  if (row.promise && row.swiftResult !== undefined) fail(`function ${at} resolves a Promise itself, so its Swift body returns nothing and has no swiftResult`);
  if (!row.promise && swiftTypeOf(row.result, row.swiftResult) === undefined) fail(`function ${at} says its swiftResult: ${row.result} isn't one of ${Object.keys(SWIFT_TYPES).join(", ")}`);
  validateModuleBindings(fail, `function ${at}`, row);
}

export function validateModuleNames(domains, moduleDomains) {
  const engineModules = new Map(Object.keys(domains).map((name) => [`Ardia${capitalized(name)}`, name]));
  const owners = new Map();
  const packages = new Map();
  for (const [name, domain] of Object.entries(moduleDomains)) {
    if (Object.hasOwn(domains, name)) throw new Error(`schema ${name}: an engine domain already has the name`);
    if (packages.has(domain.package)) throw new Error(`schema ${name}: package ${domain.package} already holds module domain ${packages.get(domain.package)}`);
    packages.set(domain.package, name);
    for (const module of Object.keys(domain.modules)) {
      if (engineModules.has(module)) throw new Error(`schema ${name}: module ${module} is engine domain ${engineModules.get(module)}'s module`);
      if (owners.has(module)) throw new Error(`schema ${name}: module ${module} is already in module domain ${owners.get(module)}`);
      owners.set(module, name);
    }
  }
}

export function validateTopics(domains) {
  for (const host of HOSTS) {
    const owners = new Map();
    for (const [name, domain] of Object.entries(domains)) {
      for (const [event, row] of Object.entries(domain.events ?? {})) {
        if (eventBindingOf(row, host) !== "forward") continue;
        const topic = row.topic ?? `${name}.${event}`;
        if (owners.has(topic)) throw new Error(`schema ${name}: event ${event} and ${owners.get(topic)} both take engine topic ${topic} on ${host}, which forwards a topic as one event`);
        owners.set(topic, `${name}.${event}`);
      }
    }
  }
}

export function validate(name, domain) {
  const fail = (message) => {
    throw new Error(`schema ${name}: ${message}`);
  };
  if (!NAME.test(name)) fail("the domain's name is lowerCamelCase letters");
  if (domain.kind !== "engine") fail("kind is engine: JSON calls to ac_* services; positional module domains are listed in moduleDomains");
  for (const [path, names] of Object.entries(domain.imports ?? {})) {
    if (!isRelative(path) && !clientPackages.has(path)) fail(`import ${path} is relative to the generated folder, or a package ${CLIENT_PACKAGE} depends on`);
    if (isRelative(path) && !RELATIVE_SPECIFIER.test(path)) fail(`import ${JSON.stringify(path)} is a relative path of letters, digits, dots, dashes, underscores and slashes`);
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
    if (call.routeField !== undefined && (typeof call.routeField !== "string" || !NAME.test(call.routeField))) fail(`${verb}.routeField is a string: a lowerCamelCase field of the engine's reply, or "null" to answer null`);
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
  const paths = sortedKeys(domain.imports ?? {});
  for (const path of [...paths.filter((path) => !isRelative(path)), ...paths.filter(isRelative)]) {
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

const moduleSignature = (fn, row) => {
  const result = row.async ? `Promise<${row.result}>` : row.result;
  return `${fn}(${row.args.map(([param, type]) => `${param}: ${type}`).join(", ")}): ${result};`;
};

function moduleTypescript(name, domain) {
  const lines = [];
  const paths = sortedKeys(domain.imports ?? {});
  for (const path of [...paths.filter((path) => !isRelative(path)), ...paths.filter(isRelative)]) {
    lines.push(`import type { ${[...domain.imports[path]].sort().join(", ")} } from "${path}";`);
  }
  if (lines.length) lines.push("");
  for (const [type, body] of Object.entries(domain.types ?? {})) lines.push(`export type ${type} = ${body};`, "");
  const block = (typeName, rows) => (rows.length ? [`export type ${typeName} = {`, ...rows.map((row) => `  ${row}`), "};", ""] : [`export type ${typeName} = {};`, ""]);
  for (const [module, entry] of Object.entries(domain.modules)) {
    lines.push(...block(nativeTypeOf(module), Object.entries(entry.functions).map(([fn, row]) => moduleSignature(fn, row))));
    const events = Object.entries(entry.events);
    if (events.length) lines.push(...block(`${nativeTypeOf(module)}Events`, events.map(([event, row]) => `${event}: ${row.payload};`)));
  }
  lines.push(...block(`${capitalized(name)}Modules`, Object.keys(domain.modules).map((module) => `${module}: ${nativeTypeOf(module)};`)));
  return `${lines.slice(0, -1).join("\n")}\n`;
}

const onMac = (row) => row.mac === "custom";
const macModules = (domain) => Object.entries(domain.modules).filter(([, entry]) => Object.values(entry.functions).some(onMac) || Object.values(entry.events).some(onMac));

function swiftRequirement(fn, row) {
  const params = [...row.args.map(([param, type, swift]) => `_ ${param}: ${swiftTypeOf(type, swift)}`), ...(row.promise ? ["_ promise: Promise"] : [])];
  const result = row.promise ? "Void" : swiftTypeOf(row.result, row.swiftResult);
  return `  static func ${swiftName(fn)}(${params.join(", ")})${result === "Void" ? "" : ` -> ${result}`}`;
}

function swiftDefinition(fn, row) {
  const params = [...row.args.map(([param, type, swift]) => `${param}: ${swiftTypeOf(type, swift)}`), ...(row.promise ? ["promise: Promise"] : [])];
  const result = row.promise ? "Void" : swiftTypeOf(row.result, row.swiftResult);
  const forwarded = [...row.args.map(([param]) => param), ...(row.promise ? ["promise"] : [])].join(", ");
  const closure = `{ (${params.join(", ")})${result === "Void" ? "" : ` -> ${result}`} in Self.${swiftName(fn)}(${forwarded}) }`;
  return [
    `  static var ${fn}Function: AnyDefinition {`,
    `    ${row.async ? "AsyncFunction" : "Function"}("${fn}") ${closure}${row.queue === "main" ? ".runOnQueue(.main)" : ""}`,
    "  }",
  ];
}

function moduleSwift(domain) {
  const lines = ["import ExpoModulesCore"];
  for (const [module, entry] of macModules(domain)) {
    const protocol = nativeTypeOf(module);
    const functions = Object.entries(entry.functions).filter(([, row]) => onMac(row));
    const events = Object.keys(entry.events).filter((event) => onMac(entry.events[event]));
    lines.push("", functions.length ? `protocol ${protocol} {` : `protocol ${protocol} {}`);
    if (functions.length) lines.push(...functions.map(([fn, row]) => swiftRequirement(fn, row)), "}");
    lines.push("", `extension ${protocol} {`, `  static var moduleName: String { "${module}" }`);
    if (events.length) lines.push("", "  static var eventsDefinition: AnyDefinition {", `    Events(${events.map((event) => `"${event}"`).join(", ")})`, "  }");
    for (const [fn, row] of functions) lines.push("", ...swiftDefinition(fn, row));
    lines.push("}");
    if (events.length) {
      lines.push("", `extension ${protocol} where Self: Module {`);
      lines.push(...events.map((event) => `  func send${capitalized(event)}(_ payload: [String: Any?]) { sendEvent("${event}", payload) }`), "}");
    }
  }
  return `${lines.join("\n")}\n`;
}

const moduleSwiftPath = (name, domain) => (macModules(domain).length ? modulePaths(name, domain.package).swift : null);

const moduleBindings = (row) => Object.fromEntries(HOSTS.map((host) => [host, row[host]]));

function moduleManifest(name, domain) {
  const modules = {};
  for (const [module, entry] of Object.entries(domain.modules)) {
    modules[module] = {
      native: nativeTypeOf(module),
      functions: Object.fromEntries(Object.entries(entry.functions).map(([fn, row]) => [fn, { args: row.args.map(([param]) => param), async: row.async, ...moduleBindings(row) }])),
      events: Object.fromEntries(Object.entries(entry.events).map(([event, row]) => [event, moduleBindings(row)])),
    };
  }
  const swift = moduleSwiftPath(name, domain);
  const sha256 = { types: digest(moduleTypescript(name, domain)), ...(swift === null ? {} : { swift: digest(moduleSwift(domain)) }) };
  return { kind: domain.kind, package: domain.package, types: modulePaths(name, domain.package).types, swift, sha256, modules };
}

function manifest(domains, moduleDomains) {
  const out = { domains: {}, modules: {} };
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
  for (const name of Object.keys(moduleDomains)) out.modules[name] = moduleManifest(name, moduleDomains[name]);
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function outputs(domains, moduleDomains = {}) {
  const files = new Map();
  for (const name of Object.keys(domains)) {
    const domain = domains[name];
    files.set(`${GENERATED_TS}${name}.ts`, typescript(name, domain));
    files.set(swiftPath(name, domain), servedByEngine(domain) ? swiftModule(name, domain) : swiftCalls(name, domain));
  }
  for (const name of Object.keys(moduleDomains)) {
    const domain = moduleDomains[name];
    files.set(modulePaths(name, domain.package).types, moduleTypescript(name, domain));
    const swift = moduleSwiftPath(name, domain);
    if (swift !== null) files.set(swift, moduleSwift(domain));
  }
  files.set(MANIFEST, manifest(domains, moduleDomains));
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
  if (previous.modules !== undefined && !isRecord(previous.modules)) throw new Error(`${MANIFEST}'s modules isn't an object; restore it from git before regenerating`);
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
  const previous = previousManifest();
  for (const [name, entry] of Object.entries(previous.modules ?? {})) {
    if (!NAME.test(name) || !isRecord(entry) || entry.kind !== "module" || typeof entry.package !== "string" || !PACKAGE.test(entry.package)) continue;
    const paths = modulePaths(name, entry.package);
    for (const key of ["types", "swift"]) {
      if (entry[key] !== paths[key] || !existsSync(ROOT + paths[key])) continue;
      if (isRecord(entry.sha256) && entry.sha256[key] === digest(readFileSync(ROOT + paths[key], "utf8"))) owned.push(paths[key]);
    }
  }
  for (const [name, entry] of Object.entries(previous.domains)) {
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

const generatedFolders = (files) => new Set([GENERATED_TS, ...[...files.keys()].filter((path) => path.endsWith("/src/generated/native.ts")).map((path) => path.slice(0, -"native.ts".length))]);

const strays = (files) => {
  const owned = new Set(previouslyGenerated());
  return [...generatedFolders(files)]
    .filter((folder) => existsSync(ROOT + folder))
    .flatMap((folder) => readdirSync(ROOT + folder).map((file) => folder + file))
    .filter((path) => !files.has(path) && !owned.has(path));
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
  const files = outputs(await loadDomains(), await loadModuleDomains());
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
