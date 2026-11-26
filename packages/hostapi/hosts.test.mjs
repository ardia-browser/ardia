import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { DESKTOP_ROUTES, MANIFEST, ROOT } from "./generate.mjs";

const read = (path) => readFileSync(ROOT + path, "utf8");
const manifest = JSON.parse(read(MANIFEST));
const domains = Object.entries(manifest.domains);
const LINUX_ONLY_EVENTS = ["downloads.removed", "history.imported"];
const NO_WINDOWS_MODULE = ["webKit"];

export function stripComments(written) {
  const source = written.replace(/\\[ \t]*\r?\n/g, "");
  let out = "";
  for (let at = 0; at < source.length; ) {
    const two = source.slice(at, at + 2);
    if (two === "//") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new Error("a block comment never closes");
      out += " ";
      at = end + 2;
    } else if (source[at] === '"' || source[at] === "'") {
      const quote = source[at];
      let end = at + 1;
      while (end < source.length && source[end] !== quote) end += source[end] === "\\" ? 2 : 1;
      out += source.slice(at, end + 1);
      at = end + 1;
    } else {
      out += source[at++];
    }
  }
  return out;
}

const between = (text, from, to) => {
  const start = text.indexOf(from);
  if (start < 0 || text.indexOf(from, start + 1) >= 0) throw new Error(`the source declares ${from} exactly once`);
  return text.slice(start, text.indexOf(to, start));
};

export function linuxEventNames(header) {
  const body = between(stripComments(header), "EventName(std::string_view topic)", "\n}");
  const opening = /for\s*\(\s*const\s+auto\s+name\s*:\s*\{/g;
  const open = opening.exec(body);
  if (!open || opening.exec(body)) throw new Error("EventName loops over exactly one braced list of topics");
  const entry = /\s*"([^"\\\n]*)"\s*/y;
  const separator = /,?\s*\}\s*\)|,/y;
  const names = [];
  let at = open.index + open[0].length;
  for (;;) {
    entry.lastIndex = at;
    const name = entry.exec(body);
    if (!name) throw new Error(`EventName's topic list has an entry the scan can't read: ${JSON.stringify(body.slice(at, at + 80))}`);
    if (names.includes(name[1])) throw new Error(`EventName lists ${name[1]} twice`);
    names.push(name[1]);
    separator.lastIndex = entry.lastIndex;
    const next = separator.exec(body);
    if (!next) throw new Error(`EventName's topic list has an entry the scan can't read: ${JSON.stringify(body.slice(entry.lastIndex, entry.lastIndex + 80))}`);
    at = separator.lastIndex;
    if (next[0] !== ",") return new Set(names);
  }
}

export function macForwarding(bridgeSource) {
  const source = stripComments(bridgeSource);
  const topics = [...between(source, "*ForwardedTopics() {", "];").matchAll(/@"([^"]+)"/g)].map((match) => match[1]);
  const renamed = new Map([...between(source, "NSString *AppEventOfTopic(", "\n}").matchAll(/isEqualToString:@"([^"]+)"\] \? @"([^"]+)"/g)].map((match) => [match[1], match[2]]));
  return { topics, renamed };
}

const linuxContract = stripComments(read("engine/ardiacore-linux/src/ardia/linux/ac_linux_contract.h"));
export function parseRoutes(header) {
  const opening = /\bkRoutes\s*=\s*\{\{/g;
  const open = opening.exec(header);
  if (!open || opening.exec(header)) throw new Error("the header declares kRoutes exactly once");
  const row = /\s*\{\s*"([^"\\]*)"\s*,\s*"([^"\\]*)"\s*,\s*"([^"\\]*)"\s*\}\s*,?/y;
  const routes = [];
  let at = open.index + open[0].length;
  for (row.lastIndex = at; ; row.lastIndex = at) {
    const match = row.exec(header);
    if (!match) break;
    const [, name, service, field] = match;
    if (routes.some((route) => route.name === name)) throw new Error(`kRoutes routes ${name} twice; FindRoute would take the first`);
    routes.push({ name, service, field });
    at = row.lastIndex;
  }
  const close = /\s*\}\}\s*;/y;
  close.lastIndex = at;
  if (!close.test(header)) throw new Error(`kRoutes has a row the scan can't read: ${JSON.stringify(header.slice(at, at + 80))}`);
  return routes;
}

const linuxRoutes = parseRoutes(stripComments(read(DESKTOP_ROUTES)));

const LINUX = "engine/ardiacore-linux/src/ardia/linux/";
const CUSTOM_ONLY_DOMAINS = ["autofill", "contentBlocker", "media", "passwords", "profiles", "webKit", "webView", "windows"];

export function namesIn(source, list) {
  const opening = new RegExp(`\\b${list}\\[\\]\\s*=\\s*\\{`, "g");
  const open = opening.exec(source);
  if (!open || opening.exec(source)) throw new Error(`the source declares ${list} exactly once`);
  const close = source.indexOf("}", open.index + open[0].length);
  const body = source.slice(open.index + open[0].length, close);
  const names = [...body.matchAll(/"([^"\\\n]*)"/g)].map((match) => match[1]);
  if (body.replace(/"[^"\\\n]*"/g, "").replace(/[\s,]/g, "")) throw new Error(`${list} has an entry the scan can't read: ${JSON.stringify(body.trim().slice(0, 80))}`);
  return names;
}

export function constantIn(source, name) {
  const found = [...source.matchAll(new RegExp(`\\b${name}\\[\\]\\s*=\\s*"([^"\\\\]*)"\\s*;`, "g"))];
  if (found.length !== 1) throw new Error(`the source declares ${name} exactly once`);
  return found[0][1];
}

export function linuxServed(read) {
  const native = (file) => stripComments(read(LINUX + file));
  const siteControls = native("ac_linux_site_controls.cc");
  const notAdvertised = new Set([...between(siteControls, "Capabilities() {", "\n}").matchAll(/name != "([^"]+)"/g)].map((match) => match[1]));
  const credentials = native("ac_linux_credentials.cc");
  const typedMethods = new Set(namesIn(native("ac_linux_credentials.h"), "kCapabilities"));
  const typedMethodOf = (name) => `Ardia${name[0].toUpperCase()}${name.slice(1)}`;
  const dispatched = [...native("ac_linux_host.cc").matchAll(/\bname == "([a-zA-Z]+\.[a-zA-Z]+)"/g)].map((match) => match[1]);
  return new Set([
    ...[...namesIn(siteControls, "kServiceCalls"), ...namesIn(siteControls, "kBlockerCalls")].filter((name) => !notAdvertised.has(name)),
    ...namesIn(credentials, "kManagedNames"),
    ...namesIn(credentials, "kSecretNames").filter((name) => typedMethods.has(typedMethodOf(name))),
    ...namesIn(native("ac_linux_cast_core.h"), "kCastCapabilities"),
    ...namesIn(native("ac_linux_capture.h"), "kCaptureCapabilities"),
    ...namesIn(native("ac_linux_page_messages.h"), "kLinuxPageMessageRoutes"),
    ...namesIn(native("ac_linux_link_tabs.h"), "kLinuxLinkTabRoutes"),
    constantIn(native("ac_linux_idle_profiles.h"), "kLinuxUnloadIdleProfileCall"),
    ...dispatched,
  ]);
}

const linuxEvents = linuxEventNames(linuxContract);
const { topics: macTopics, renamed: macRenamed } = macForwarding(read("packages/ardiacore/ios/ArdiaEngineBridge.mm"));
const generatedEvent = (name) => domains.some(([domain]) => name.startsWith(`${domain}.`));
const eventsOf = (host, binding) => domains.flatMap(([domain, entry]) => Object.entries(entry.events).filter(([, event]) => event[host] === binding).map(([event, row]) => ({ name: `${domain}.${event}`, topic: row.topic })));

test("the scans find the hosts' tables", () => {
  assert.ok(domains.length > 0);
  assert.ok(linuxRoutes.length > 30);
  assert.ok(linuxEvents.size > 3);
  assert.ok(macTopics.length > 3);
  assert.ok(macRenamed.size > 0);
});

test("the kRoutes scan reads rows however they're wrapped and refuses what it can't read or a name routed twice", () => {
  const header = (rows) => `inline constexpr std::array<Route, 2> kRoutes = {{\n${rows}\n}};\n\ninline const Route* FindRoute(std::string_view name) {}\n`;
  assert.deepEqual(parseRoutes(header('    {\n"history.query",\n "ac_history_query", ""},\n    {"downloads.pause", "ac_downloads_command", "null"}')), [
    { name: "history.query", service: "ac_history_query", field: "" },
    { name: "downloads.pause", service: "ac_downloads_command", field: "null" },
  ]);
  assert.throws(() => parseRoutes(header('    {\n"history.query", "ac_evil", ""},\n    {"history.query", "ac_history_query", ""},')), /twice/);
  assert.throws(() => parseRoutes(header('    {"history.query", "ac_history_query", ""},\n    {kName, "ac_history_add", ""},')), /can't read/);
  assert.throws(() => parseRoutes(header('    {"history.query", "ac_history_query"},')), /can't read/);
  assert.throws(() => parseRoutes("struct Route {};"), /exactly once/);
});

test("the Linux and Windows hosts route through the generated header and keep no route table of their own", () => {
  for (const name of ["FindRoute", "kRoutes", "Route"]) assert.ok(linuxContract.includes(`using ardia::desktop_routes::${name};`), name);
  assert.ok(linuxContract.includes('#include "ardia/desktop/generated/ac_desktop_routes.h"'));
  assert.doesNotMatch(linuxContract, /\bstruct Route\b|\bkRoutes\s*(\[\])?\s*=/);
  assert.ok(read("engine/ardiacore-desktop/src/ardia/desktop/BUILD.gn").includes('"generated/ac_desktop_routes.h",'));
  const windowsShell = ["webui_host_view.cc", "webui_host_calls.cc"]
    .map((file) => stripComments(read(`scripts/windows/engine/src/ardia/win/webui/${file}`)))
    .join("\n");
  assert.ok(windowsShell.includes("ardia::desktop_routes::kRoutes") && windowsShell.includes("ardia::desktop_routes::FindRoute("));
  assert.doesNotMatch(windowsShell, /\bkRoutes\s*(\[\])?\s*=/);
});

test("the hosts advertise the routes in the order they always have: engine, tabs, downloads' settings before its commands, then the rest", () => {
  assert.deepEqual(linuxRoutes.slice(0, 8).map(({ name }) => name), ["engine.components", "engine.tasks", "engine.batterySaver", "engine.trimMemory", "engine.openTaskManager", "tabs.lastTabPolicy", "downloads.settings", "downloads.setSettings"]);
  const domainsInOrder = [...new Set(linuxRoutes.map(({ name }) => name.split(".")[0]))];
  assert.deepEqual(domainsInOrder, ["engine", "tabs", "downloads", "history", "bookmarks", "favicons", "extensions", "search", "permissions"]);
  assert.deepEqual(linuxRoutes.at(-1).name, "permissions.removeExternalAppAllowance");
});

test("the generated desktop routes are exactly each generated domain's desktop-routed calls, to the same service", () => {
  for (const [domain, entry] of domains) {
    const routed = linuxRoutes.filter((route) => route.name.startsWith(`${domain}.`)).sort((a, b) => a.name.localeCompare(b.name));
    const schema = Object.entries(entry.calls)
      .filter(([, call]) => call.desktop === "route")
      .map(([verb, call]) => ({ name: `${domain}.${verb}`, service: call.service, field: call.routeField ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(routed, schema, `kRoutes' ${domain} rows`);
  }
});

test("comments never count as table entries: a commented-out row is read as gone", () => {
  assert.equal(stripComments('a // "x.y"\nb /* @"z" */ c "/* kept */" \'/\''), 'a \nb   c "/* kept */" \'/\'');
  assert.throws(() => stripComments("a /* open"), /never closes/);
  const header = 'inline std::string_view EventName(std::string_view topic) {\n  for (const auto name : {"history.changed", /* "bookmarks.changed", */ "downloads.changed"}) {\n  // "extensions.sync"\n  }\n}\n';
  assert.deepEqual([...linuxEventNames(header)], ["history.changed", "downloads.changed"]);
  assert.equal(stripComments('a // b \\\nc\nd'), "a \nd");
  assert.equal(stripComments('a // b \\\r\nc\r\nd'), "a \nd");
  assert.equal(stripComments('a // b \\ \t\nc\nd'), "a \nd");
  assert.equal(stripComments('a // b \\\t \r\nc\r\nd'), "a \nd");
  const contract = read("engine/ardiacore-linux/src/ardia/linux/ac_linux_contract.h");
  const loop = '  for (const auto name : {"history.changed",';
  assert.ok(contract.includes(loop));
  assert.throws(() => linuxEventNames(contract.replace(loop, `  // topics \\\n${loop}`)), /exactly one braced list/);
  assert.throws(() => linuxEventNames(contract.replace(loop, `  // topics \\ \t\n${loop}`)), /exactly one braced list/);
});

test("the EventName scan reads every topic however it's spelled and refuses what it can't read", () => {
  const header = (list) => `inline std::string_view EventName(std::string_view topic) {\n  for (const auto name : {${list}}) {\n    if (topic == name) return name;\n  }\n  return {};\n}\n`;
  assert.deepEqual([...linuxEventNames(header('"history.changed",\n   "downloads.test-extra", "a.b_c:d",'))], ["history.changed", "downloads.test-extra", "a.b_c:d"]);
  assert.deepEqual([...linuxEventNames(header('"history.changed"'))], ["history.changed"]);
  assert.throws(() => linuxEventNames(header('"history.changed", kExtraTopic')), /can't read/);
  assert.throws(() => linuxEventNames(header('"history.changed" "downloads.changed"')), /can't read/);
  assert.throws(() => linuxEventNames(header('"history.changed", "history.changed"')), /twice/);
  assert.throws(() => linuxEventNames(header('"history.\\"changed"')), /can't read/);
  const contract = read("engine/ardiacore-linux/src/ardia/linux/ac_linux_contract.h");
  const extra = contract.replace('"downloads.removed"}', '"downloads.removed", "downloads.test-extra"}');
  assert.notEqual(extra, contract);
  assert.ok(linuxEventNames(extra).has("downloads.test-extra"));
  const bridgeSource = read("packages/ardiacore/ios/ArdiaEngineBridge.mm");
  const commented = bridgeSource.replace('@"extensions.action", ', '/* @"extensions.action", */ ');
  assert.notEqual(commented, bridgeSource);
  assert.ok(macForwarding(bridgeSource).topics.includes("extensions.action"));
  assert.ok(!macForwarding(commented).topics.includes("extensions.action"));
  assert.ok(!macForwarding(bridgeSource.replace('@"extensions.action", ', '\n// @"extensions.action",\n')).topics.includes("extensions.action"));
});

test("the desktop UI's request deadlines are the generated maps, looked up by the engine call's or host method's own name", () => {
  const bootstrap = read("engine/ardiacore-linux/src/ardia/linux/bootstrap.js");
  assert.ok(bootstrap.includes('request("engine.call", { name, profile, args }, engineDeadlines.get(name))'));
  assert.ok(bootstrap.includes('request("host.invoke", { method, args }, hostDeadlines.get(method))'));
  assert.equal(bootstrap.match(/new Map\(\[/g).length, 2, "bootstrap.js keeps no deadline table but the two generated ones");
  const windowsBuild = read("scripts/windows/engine/src/ardia/win/BUILD.gn");
  assert.ok(windowsBuild.includes('sources = [ "//ardia/linux/bootstrap.js" ]'), "Windows embeds the same bootstrap");
});

test("the custom-only domains are exactly the ones no host passes any call of straight to the engine", () => {
  const engineFree = domains.filter(([, entry]) => Object.values(entry.calls).every((call) => call.service === undefined)).map(([domain]) => domain);
  assert.deepEqual(engineFree.sort(), CUSTOM_ONLY_DOMAINS);
});

test("the Linux host serves exactly a custom-only domain's desktop custom calls: each is in a native dispatch list it advertises or a branch of its own, and nothing it refuses is custom", () => {
  const served = linuxServed(read);
  assert.ok(served.has("contentBlocker.state") && served.has("passwords.unlock") && served.has("profiles.unloadIdle"));
  assert.ok(!served.has("contentBlocker.devDelayNextLoad"), "Linux refuses contentBlocker.devDelayNextLoad as unavailable");
  for (const domain of CUSTOM_ONLY_DOMAINS) {
    const entry = manifest.domains[domain];
    const custom = Object.entries(entry.calls).filter(([, call]) => call.desktop === "custom").map(([verb]) => `${domain}.${verb}`).sort();
    const nativelyServed = Object.keys(entry.calls).map((verb) => `${domain}.${verb}`).filter((name) => served.has(name)).sort();
    assert.deepEqual(custom, nativelyServed, `${domain}'s desktop custom calls`);
    for (const [verb, call] of Object.entries(entry.calls)) assert.notEqual(call.desktop, "route", `${domain}.${verb} has no engine service to route to`);
  }
});

test("the Linux dispatch scans read every list however it's spelled and refuse what they can't read", () => {
  assert.deepEqual(namesIn('constexpr std::string_view kNames[] = {\n  "a.b", "c.d",\n};', "kNames"), ["a.b", "c.d"]);
  assert.throws(() => namesIn('constexpr std::string_view kNames[] = {"a.b", kOther};', "kNames"), /can't read/);
  assert.throws(() => namesIn('kNames[] = {"a.b"}; kNames[] = {"c.d"};', "kNames"), /exactly once/);
  assert.equal(constantIn('inline constexpr char kCall[] = "profiles.unloadIdle";', "kCall"), "profiles.unloadIdle");
  assert.throws(() => constantIn("inline constexpr char kCall[] = kOther;", "kCall"), /exactly once/);
  const siteControls = read(`${LINUX}ac_linux_site_controls.cc`);
  const exclusion = 'if (name != "contentBlocker.devDelayNextLoad") names.push_back(name);';
  assert.ok(siteControls.includes(exclusion));
  const advertisedAll = (path) => (path.endsWith("ac_linux_site_controls.cc") ? siteControls.replace(exclusion, "names.push_back(name);") : read(path));
  assert.ok(linuxServed(advertisedAll).has("contentBlocker.devDelayNextLoad"));
  const commented = (path) => (path.endsWith("ac_linux_host.cc") ? read(path).replace('if (name == "profiles.loaded") {', 'if (false /* name == "profiles.loaded" */) {') : read(path));
  assert.ok(!linuxServed(commented).has("profiles.loaded"));
});

test("the Linux host forwards exactly the desktop-forwarded events and its own Linux-only topics, nothing undeclared", () => {
  const forwarded = eventsOf("desktop", "forward");
  for (const { name, topic } of forwarded) assert.equal(topic, name, `${name} reaches Linux under its own topic`);
  for (const name of LINUX_ONLY_EVENTS) {
    const [domain, event] = name.split(".");
    assert.equal(manifest.domains[domain]?.events[event], undefined, `${name} is Linux-only, so it isn't in the schema`);
  }
  assert.deepEqual([...linuxEvents].sort(), [...forwarded.map(({ name }) => name), ...LINUX_ONLY_EVENTS].sort(), "EventName's topics");
});

test("each host forwards an engine topic as one event only", () => {
  for (const host of ["mac", "desktop"]) {
    const topics = eventsOf(host, "forward").map(({ topic }) => topic);
    assert.deepEqual(topics.filter((topic, index) => topics.indexOf(topic) !== index), [], `${host} forwards a topic twice`);
  }
});

test("the Mac forwards exactly each generated domain's Mac-forwarded engine topics, under the event's name", () => {
  const forwarded = eventsOf("mac", "forward");
  const generatedTopics = macTopics.filter((topic) => generatedEvent(macRenamed.get(topic) ?? topic));
  assert.deepEqual([...generatedTopics].sort(), forwarded.map(({ topic }) => topic).sort());
  for (const { name, topic } of forwarded) assert.equal(macRenamed.get(topic) ?? topic, name, `the Mac emits topic ${topic} as ${name}`);
});

test("the Mac's call table for each domain is the generated one: each service-backed call passes to its service and each custom one to its module's handler", () => {
  for (const [domain, entry] of domains) {
    const swift = read(entry.swift);
    assert.match(swift, new RegExp(`CallTable\\(domain: "${domain}"`));
    for (const [verb, call] of Object.entries(entry.calls)) {
      const row = { service: `"${verb}": EngineCall.passing("${call.service}"),`, custom: `"${verb}": ${verb}Handler,` }[call.mac];
      if (row) assert.ok(swift.includes(row), `${domain}.${verb}`);
      else assert.ok(!swift.includes(`"${verb}": `), `${domain}.${verb} is absent on the Mac`);
    }
  }
});

test("a domain the Mac serves partly or wholly by hand builds its module's table from the generated one", () => {
  const mixed = domains.filter(([, entry]) => entry.swift.endsWith("Calls.swift"));
  assert.deepEqual(mixed.map(([domain]) => domain).sort(), ["autofill", "bookmarks", "contentBlocker", "downloads", "engine", "extensions", "favicons", "media", "passwords", "permissions", "profiles", "search", "sites", "tabs", "webKit", "webView", "windows"]);
  for (const [domain, entry] of mixed) {
    const module = read(entry.swift.replace(/Calls\.swift$/, "Module.swift"));
    assert.match(module, new RegExp(`static let calls = ${domain}CallTable\\(`), `${domain}'s module`);
    assert.doesNotMatch(module, /CallTable\(domain:/, `${domain}'s module lists no rows of its own`);
  }
});

const moduleDomains = Object.entries(manifest.modules);
const filesUnder = (dir, pattern) => readdirSync(ROOT + dir, { recursive: true }).filter((file) => pattern.test(file)).map((file) => `${dir}${file}`.replaceAll("\\", "/")).sort();
const moduleFunctions = moduleDomains.flatMap(([domain, entry]) => Object.entries(entry.modules).flatMap(([module, row]) => Object.entries(row.functions).map(([fn, binding]) => ({ domain, module, fn, binding }))));
const moduleEvents = moduleDomains.flatMap(([domain, entry]) => Object.entries(entry.modules).flatMap(([module, row]) => Object.entries(row.events).map(([event, binding]) => ({ domain, module, event, binding }))));
const moduleConstants = moduleDomains.flatMap(([domain, entry]) => Object.entries(entry.modules).flatMap(([module, row]) => Object.entries(row.constants ?? {}).map(([constant, binding]) => ({ domain, module, constant, binding }))));
const reachesLinuxHost = (binding) => binding.desktop === "host" || binding.desktop === "adapted";

function skipQuoted(text, at) {
  const quote = text[at];
  let end = at + 1;
  while (end < text.length && text[end] !== quote) end += text[end] === "\\" ? 2 : 1;
  return end;
}

export function skipCppLiteral(text, at) {
  if (text[at] === "'" && /[0-9A-Za-z]/.test(text[at - 1] ?? "") && /[0-9A-Za-z]/.test(text[at + 1] ?? "")) return at;
  const raw = text[at] === '"' && text[at - 1] === "R" ? /^"([^()\\\s]{0,16})\(/.exec(text.slice(at)) : null;
  if (raw) {
    const end = text.indexOf(`)${raw[1]}"`, at + raw[0].length);
    if (end < 0) throw new Error("a raw string never closes");
    return end + raw[1].length + 1;
  }
  return skipQuoted(text, at);
}

export function stripCppComments(source) {
  let out = "";
  for (let at = 0; at < source.length; ) {
    const two = source.slice(at, at + 2);
    if (two === "//") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new Error("a block comment never closes");
      out += " ";
      at = end + 2;
    } else if (source[at] === '"' || source[at] === "'") {
      const end = skipCppLiteral(source, at);
      out += source.slice(at, end + 1);
      at = end + 1;
    } else {
      out += source[at++];
    }
  }
  return out;
}

export function maskCppLiterals(code) {
  let out = "";
  for (let at = 0; at < code.length; at++) {
    if (code[at] !== '"' && code[at] !== "'") {
      out += code[at];
      continue;
    }
    const end = skipCppLiteral(code, at);
    out += end === at ? code[at] : `${code[at]}${" ".repeat(end - at - 1)}${code[end]}`;
    at = end;
  }
  return out;
}

export function closing(text, open, skip = skipQuoted) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[text[open]];
  if (!want) throw new Error(`a group opens with ( { or [, not ${JSON.stringify(text.slice(open, open + 20))}`);
  const stack = [];
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") at = skip(text, at);
    else if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return at;
    }
  }
  throw new Error("a group never closes");
}

const CPP_CONTROL = /^(?:else\s+)?(?:(?:if|for|while|switch|catch)\s*\(|(?:else|do|try)$)/;
const CPP_FUNCTION_TAIL = /\)\s*(?:(?:const|override|final|noexcept|mutable|volatile|&&?)\s*)*(?:->\s*([^{;()]+?))?\s*$/;
const CPP_BOOL_DECLARED = /^(?:(?:static|inline|constexpr|virtual|friend|explicit|\[\[[^\]]*\]\])\s+)*bool\s+[\w:~<>]+\s*\(/;

export function cppFunctions(masked) {
  const functions = [];
  const frames = [];
  let boundary = 0;
  let parens = 0;
  for (let at = 0; at < masked.length; at++) {
    const char = masked[at];
    if (char === '"' || char === "'") at = skipCppLiteral(masked, at);
    else if (char === "(") parens++;
    else if (char === ")") parens--;
    else if (char === ";" && parens === 0) boundary = at + 1;
    else if (char === "{") {
      const header = masked.slice(boundary, at).trim();
      const tail = CPP_FUNCTION_TAIL.exec(header);
      const isFunction = tail !== null && !CPP_CONTROL.test(header);
      frames.push({ open: at, header, isFunction, returns: tail?.[1]?.trim(), parens });
      parens = 0;
      boundary = at + 1;
    } else if (char === "}") {
      const frame = frames.pop();
      if (!frame) continue;
      parens = frame.parens;
      boundary = at + 1;
      if (!frame.isFunction) continue;
      let body = masked.slice(frame.open + 1, at);
      for (const nested of functions.filter((fn) => fn.open > frame.open && fn.close < at)) {
        const start = nested.open - frame.open - 1;
        body = body.slice(0, start) + " ".repeat(nested.close - nested.open + 1) + body.slice(nested.close - frame.open);
      }
      const returns = [...body.matchAll(/\breturn\b([^;]*);/g)].map((match) => match[1].trim());
      const onlyBooleans = returns.length > 0 && returns.every((value) => value === "true" || value === "false");
      const boolean = CPP_BOOL_DECLARED.test(frame.header) || frame.returns === "bool" || onlyBooleans;
      functions.push({ open: frame.open, close: at, header: frame.header, boolean });
    }
  }
  return functions;
}

const CPP_STRING_CONSTANT = /\b(?:(?:inline|static|constexpr|const)\s+)+(?:char|std::string_view|const\s+char\s*\*|char\s+const\s*\*)\s*(?:const\s+)?(k\w+)\s*(?:\[\s*\])?\s*=\s*"/g;

export function cppStringConstants(sources) {
  return sources.map((written) => {
    const code = stripCppComments(written);
    const masked = maskCppLiterals(code);
    const spaces = [...masked.matchAll(/\bnamespace\s+([\w:]+)\s*\{/g)].map((match) => {
      const open = match.index + match[0].length - 1;
      return { name: match[1], open, close: closing(masked, open, skipCppLiteral) };
    });
    const constants = new Map();
    for (const match of masked.matchAll(CPP_STRING_CONSTANT)) {
      const quote = match.index + match[0].length - 1;
      const value = code.slice(quote + 1, skipCppLiteral(code, quote));
      const prefix = spaces.filter((space) => space.open < match.index && match.index < space.close).sort((a, b) => a.open - b.open).map((space) => space.name);
      constants.set([...prefix, match[1]].join("::"), value);
    }
    return constants;
  });
}

export const cppNamespaceAliases = (code) => new Map([...code.matchAll(/\bnamespace\s+(\w+)\s*=\s*((?:::)?[\w:]+)\s*;/g)].map(([, alias, target]) => [alias, target.replace(/^::/, "")]));

export function resolveCppConstant(usage, own, all, aliases = new Map()) {
  const [head, ...rest] = usage.replace(/^::/, "").split("::");
  const name = rest.length && aliases.has(head) ? [aliases.get(head), ...rest].join("::") : [head, ...rest].join("::");
  const values = (tables) => new Set(tables.flatMap((table) => [...table].filter(([full]) => full === name || full.endsWith(`::${name}`)).map(([, value]) => value)));
  for (const found of [values([own]), values(all)]) if (found.size === 1) return [...found][0];
  return undefined;
}

const MODULE_METHOD = /^Ardia[A-Za-z]+\.[a-z][A-Za-z]*$/;

export function linuxModuleDispatch(sources) {
  const methods = new Set();
  const events = new Set();
  const tables = cppStringConstants(sources);
  for (const [index, written] of sources.entries()) {
    const code = stripCppComments(written);
    const masked = maskCppLiterals(code);
    const aliases = cppNamespaceAliases(code);
    const flags = [...code.matchAll(/\bconst\s+bool\s+(\w+)\s*=\s*(?:method|name)\s*==\s*"(Ardia[A-Za-z]+\.[a-z][A-Za-z]*)"\s*;/g)].map((match) => ({ flag: match[1], method: match[2], at: match.index }));
    const literalOrConstant = (literal, constant) => literal ?? (constant === undefined ? undefined : resolveCppConstant(constant, tables[index], tables, aliases));
    for (const match of masked.matchAll(/\b(?:Send)?Event\(\s*"/g)) {
      const call = /^(?:Send)?Event\(\s*"(Ardia[A-Za-z]+)"\s*,\s*(?:"([a-zA-Z]+)"|((?:::)?[A-Za-z_][\w]*(?:::[A-Za-z_]\w*)*))\s*[,)]/.exec(code.slice(match.index));
      const event = call && literalOrConstant(call[2], call[3]);
      if (event && /^[a-zA-Z]+$/.test(event)) events.add(`${call[1]}.${event}`);
    }
    for (const row of masked.matchAll(/\{\s*"/g)) {
      const entry = /^\{\s*"(Ardia[A-Za-z]+\.[a-z][A-Za-z]*)"\s*,\s*Route::k\w+\s*\}/.exec(code.slice(row.index));
      if (entry) methods.add(entry[1]);
    }
    const functions = cppFunctions(masked);
    const ownerOf = (pos) => functions.filter((fn) => fn.open < pos && pos < fn.close).sort((a, b) => a.close - a.open - (b.close - b.open))[0];
    const ownedFlags = flags.map((entry) => ({ ...entry, owner: ownerOf(entry.at) }));
    for (const branch of masked.matchAll(/\bif\s*\((?=\s*(?:method|name)\s*==)/g)) {
      const owner = ownerOf(branch.index);
      if (!owner || owner.boolean) continue;
      const open = branch.index + branch[0].length - 1;
      const close = closing(masked, open, skipCppLiteral);
      const condition = code.slice(open + 1, close);
      const flagIn = (part) => ownedFlags.find(({ flag, at, owner: flagOwner }) => flag === part.trim() && flagOwner === owner && at < branch.index)?.method;
      if (maskCppLiterals(condition).includes("&&")) continue;
      const parts = condition.split("||").map((part) => {
        const compare = /^\s*(?:method|name)\s*==\s*(?:"([^"]*)"|((?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*))\s*$/.exec(part);
        if (!compare) return flagIn(part) ?? (/\b(?:method|name)\b/.test(maskCppLiterals(part)) ? null : undefined);
        const name = literalOrConstant(compare[1], compare[2]);
        return name !== undefined && MODULE_METHOD.test(name) ? name : null;
      });
      if (parts.includes(null) || !parts.some(Boolean)) continue;
      let at = close + 1;
      while (/\s/.test(masked[at] ?? "")) at++;
      const statement = masked[at] === "{" ? masked.slice(at + 1, closing(masked, at, skipCppLiteral)) : masked.slice(at, masked.indexOf(";", at) + 1);
      if (/^\s*return\s+(?:true|false)\s*;\s*$/.test(statement)) continue;
      for (const name of parts.filter(Boolean)) methods.add(name);
    }
  }
  return { methods, events };
}

export function swiftBlock(text, open) {
  const end = closing(text, open);
  return { start: open, end: end + 1, body: text.slice(open + 1, end) };
}

const SWIFT_CONTINUES = /(?:[=:,([{+\-*/%&|^<>?!.]|->|\b(?:return|in|as|is|try|await|throw|let|var|where))\s*$/;
const SWIFT_CONTINUATION = /^(?:[.?:=+\-*/%&|^<>,]|->|(?:as|is|in|where)\b)/;

export function topLevelStatements(body) {
  const statements = [];
  let current = "";
  const lineEnds = () => {
    const statement = current.trim();
    if (!statement) return;
    if (SWIFT_CONTINUES.test(statement)) return;
    statements.push(statement);
    current = "";
  };
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char === '"' || "({[".includes(char)) {
      const end = char === '"' ? skipQuoted(body, at) : closing(body, at);
      current += body.slice(at, end + 1);
      at = end;
    } else if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else if (char === "\n") {
      const rest = body.slice(at + 1).trimStart();
      if (current.trim() && SWIFT_CONTINUATION.test(rest)) current += "\n";
      else {
        lineEnds();
        if (current) current += "\n";
      }
    } else current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function swiftRegistrations(source, className) {
  const declared = new RegExp(`\\bclass ${className}\\b[^{]*\\{`).exec(source);
  if (!declared) throw new Error(`the source declares no class ${className}`);
  const classBody = swiftBlock(source, declared.index + declared[0].length - 1).body;
  const definition = /\bfunc definition\(\)\s*->\s*ModuleDefinition\s*\{/.exec(classBody);
  if (!definition) throw new Error(`${className} has no definition()`);
  let body = swiftBlock(classBody, definition.index + definition[0].length - 1).body;
  for (let view = /\bView\s*\([^)]*\)\s*\{/.exec(body); view; view = /\bView\s*\([^)]*\)\s*\{/.exec(body)) {
    const { end } = swiftBlock(body, view.index + view[0].length - 1);
    body = body.slice(0, view.index) + body.slice(end);
  }
  const statements = topLevelStatements(body);
  const name = statements.filter((statement) => /^Name\s*\(\s*Self\s*\.\s*moduleName\s*\)$/.test(statement));
  const rest = statements.filter((statement) => !name.includes(statement));
  const generatedMember = (kind) => rest.map((statement) => new RegExp(`^(?:(?:Self|self)\\s*\\.\\s*)?([a-z]\\w*)${kind}$`).exec(statement)?.[1]).filter(Boolean);
  return {
    generated: generatedMember("Function"),
    constants: generatedMember("Constant"),
    events: rest.some((statement) => /^Self\s*\.\s*eventsDefinition$/.test(statement)),
    name: name.length === 1,
    handWritten: [
      ...[...rest.join("\n").matchAll(/\b(Name|Function|AsyncFunction|Events|Property|Constant|Constants)\s*\(/g)].map((match) => match[1]),
      ...name.slice(1).map(() => "Name"),
      ...rest.filter((statement) => /\b(?:Self|self)\s*\.\s*(?:\w+(?:Function|Constant)|eventsDefinition)\b/.test(statement) && !/^(?:(?:Self|self)\s*\.\s*)?(?:\w+(?:Function|Constant))$|^Self\s*\.\s*eventsDefinition$/.test(statement)),
    ],
  };
}

const parseTs = (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const isWrapper = (node) => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node);
const unwrap = (node) => {
  while (node && isWrapper(node)) node = node.expression;
  return node;
};
const isFunctionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isClassLike(node);
const keyOf = (property) => {
  const named = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property);
  return named && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
};
function walk(node, visit, { intoFunctions = true } = {}) {
  ts.forEachChild(node, (child) => {
    if (visit(child) === false) return;
    if (!intoFunctions && isFunctionLike(child)) return;
    walk(child, visit, { intoFunctions });
  });
}

const endsAbruptly = (block) => block.statements.some((statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement));

export function ownReturnedExpressions(fn) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const expressions = [];
  const collect = (node) => {
    walk(node, (child) => {
      if (ts.isTryStatement(child) && child.finallyBlock && endsAbruptly(child.finallyBlock)) {
        collect(child.finallyBlock);
        return false;
      }
      if (ts.isReturnStatement(child) && child.expression) expressions.push(child.expression);
    }, { intoFunctions: false });
  };
  collect(fn.body);
  return expressions;
}

const NATIVE_MODULE_CALLS = new Set(["requireNativeModule", "requireOptionalNativeModule"]);

export function nativeModuleTypingProblems(source, domain, modules, path = "source.ts") {
  const map = `${domain[0].toUpperCase()}${domain.slice(1)}Modules`;
  const file = parseTs(path, source);
  const problems = [];
  let typed = 0;
  const calls = [];
  walk(file, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && NATIVE_MODULE_CALLS.has(node.expression.text)) calls.push(node);
  });
  const enclosingFunction = (node) => {
    for (let at = node.parent; at; at = at.parent) if (ts.isArrowFunction(at) || ts.isFunctionExpression(at) || ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) return at;
    return null;
  };
  const wrappers = new Set();
  for (const call of calls) {
    const text = call.getText(file).replace(/\s+/g, " ");
    const type = call.typeArguments?.[0];
    const argument = call.arguments[0];
    if (argument && ts.isStringLiteralLike(argument)) {
      const row = modules[argument.text];
      if (!row) continue;
      const literalIndex = type && ts.isIndexedAccessTypeNode(type) && type.objectType.getText(file) === map && ts.isLiteralTypeNode(type.indexType) && ts.isStringLiteral(type.indexType.literal) && type.indexType.literal.text === argument.text;
      if (type?.getText(file) === row.native || literalIndex) typed++;
      else problems.push(`${text} types ${argument.text} as ${type?.getText(file) ?? "nothing"} instead of ${row.native}`);
      continue;
    }
    const fn = enclosingFunction(call);
    const index = type && ts.isIndexedAccessTypeNode(type) && type.objectType.getText(file) === map && ts.isTypeReferenceNode(type.indexType) ? type.indexType.typeName.getText(file) : null;
    const parameter = fn?.typeParameters?.find((entry) => entry.name.text === index);
    const constrained = parameter?.constraint && ts.isTypeOperatorNode(parameter.constraint) && parameter.constraint.operator === ts.SyntaxKind.KeyOfKeyword && parameter.constraint.type.getText(file) === map;
    const passed = argument && ts.isIdentifier(argument) && fn?.parameters.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === argument.text && entry.type?.getText(file) === index);
    if (!constrained || !passed) {
      problems.push(`${text} takes a module name without the generated ${map} type`);
      continue;
    }
    typed++;
  }
  const named = [];
  walk(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) named.push([node.name.text, node]);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) named.push([node.name.text, value]);
    }
  });
  const reachesNative = (expression) => {
    const value = unwrap(expression);
    return value && ts.isCallExpression(value) && ts.isIdentifier(value.expression) && (NATIVE_MODULE_CALLS.has(value.expression.text) || wrappers.has(value.expression.text));
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, fn] of named) {
      if (wrappers.has(name) || !ownReturnedExpressions(fn).some(reachesNative)) continue;
      wrappers.add(name);
      grew = true;
    }
  }
  const sites = [...calls];
  walk(file, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && wrappers.has(node.expression.text)) sites.push(node);
  });
  const bound = new Set();
  for (const site of sites) {
    let at = site;
    while (at.parent && isWrapper(at.parent) && !ts.isAsExpression(at.parent) && !ts.isTypeAssertionExpression(at.parent)) at = at.parent;
    if (ts.isVariableDeclaration(at.parent) && at.parent.initializer === at && ts.isIdentifier(at.parent.name)) bound.add(at.parent.name.text);
  }
  walk(file, (node) => {
    if (ts.isIdentifier(node) && bound.has(node.text) && !ts.isVariableDeclaration(node.parent)) sites.push(node);
  });
  for (const site of sites) {
    for (let at = site; at.parent && isWrapper(at.parent); at = at.parent) {
      const cast = at.parent;
      if ((ts.isAsExpression(cast) || ts.isTypeAssertionExpression(cast)) && cast.type.getText(file) !== "const") {
        problems.push(`${cast.getText(file).replace(/\s+/g, " ")} casts a native module past its generated type`);
        break;
      }
    }
  }
  return { problems, typed };
}

const exists = (path) => existsSync(ROOT + path);
const linuxSources = () => ["engine/ardiacore-linux/src/", "engine/ardiacore-desktop/src/"].flatMap((dir) => filesUnder(dir, /\.(cc|h|mm)$/)).map(read);

test("the module-domain scans find the shaders pilot and read the hosts' real tables", () => {
  assert.ok(moduleDomains.some(([domain]) => domain === "shaders"));
  assert.ok(moduleFunctions.length >= 4);
  const linux = linuxModuleDispatch(linuxSources());
  for (const name of ["ArdiaCalendar.status", "ArdiaConfig.watch", "ArdiaConfig.readFile", "ArdiaAutomation.start"]) assert.ok(linux.methods.has(name), name);
  assert.ok(linux.events.has("ArdiaShell.shell"));
});

export function macModuleProblems(domain, entry, read, swiftFiles) {
  const problems = [];
  const generated = entry.swift === null ? null : read(entry.swift);
  const sources = swiftFiles.filter((path) => path !== entry.swift).map((path) => [path, stripComments(read(path))]);
  let listed;
  const registeredModules = () => (listed ??= JSON.parse(read(`${entry.package}/expo-module.config.json`)).apple?.modules ?? []);
  for (const [module, row] of Object.entries(entry.modules)) {
    const onMac = (binding) => binding.mac === "custom";
    const functions = Object.keys(row.functions).filter((fn) => onMac(row.functions[fn]));
    const constants = Object.keys(row.constants ?? {}).filter((constant) => onMac(row.constants[constant]));
    const events = Object.keys(row.events).filter((event) => onMac(row.events[event]));
    const conforming = sources.flatMap(([path, text]) => [...text.matchAll(new RegExp(`\\bclass (\\w+)\\s*:\\s*Module\\s*,\\s*${row.native}\\b`, "g"))].map((match) => ({ path, text, name: match[1] })));
    for (const [path, text] of sources) if (new RegExp(`Name\\s*\\(\\s*"${module}"\\s*\\)`).test(text)) problems.push(`${path} names ${module} itself instead of Name(Self.moduleName)`);
    if (!functions.length && !constants.length && !events.length) {
      if (conforming.length) problems.push(`${module} has nothing on the Mac, yet ${conforming.map(({ name }) => name).join(", ")} conforms to ${row.native}`);
      continue;
    }
    if (generated === null) {
      problems.push(`${domain} ${module} has Mac functions or events, but the manifest names no generated Swift for the domain`);
      continue;
    }
    if (!new RegExp(`protocol ${row.native}\\b`).test(generated)) problems.push(`${entry.swift} doesn't declare ${row.native}`);
    if (conforming.length !== 1) {
      problems.push(`${conforming.length} Mac modules in ${entry.package}/ios conform to ${row.native}, not exactly one`);
      continue;
    }
    const [{ path, text, name }] = conforming;
    if (!registeredModules().includes(name)) problems.push(`${entry.package}/expo-module.config.json doesn't register ${name}`);
    const registered = swiftRegistrations(text, name);
    if (!registered.name) problems.push(`${path}: ${name} doesn't take its name from ${row.native}`);
    if (registered.generated.sort().join() !== [...functions].sort().join()) problems.push(`${path}: ${name} registers ${registered.generated.join(", ") || "no"} generated functions, not ${functions.join(", ")}`);
    if (registered.constants.sort().join() !== [...constants].sort().join()) problems.push(`${path}: ${name} registers ${registered.constants.join(", ") || "no"} generated constants, not ${constants.join(", ")}`);
    if (registered.events !== events.length > 0) problems.push(`${path}: ${name} ${events.length ? "doesn't declare" : "declares"} its events from ${row.native}`);
    if (registered.handWritten.length) problems.push(`${path}: ${name} registers ${registered.handWritten.join(", ")} by hand`);
  }
  return problems;
}

test("each Mac module of a module domain conforms to its generated protocol and registers exactly its generated name, events and functions, with no hand-written ones beside its views", () => {
  for (const [domain, entry] of moduleDomains) {
    const swiftFiles = exists(`${entry.package}/ios`) ? filesUnder(`${entry.package}/ios/`, /\.swift$/) : [];
    assert.deepEqual(macModuleProblems(domain, entry, read, swiftFiles), [], domain);
  }
});

test("a module domain with nothing on the Mac has no generated Swift, and the Mac check reads that instead of a file named null", () => {
  const entry = { package: "packages/quiet", swift: null, modules: { ArdiaQuiet: { native: "QuietNative", functions: { probe: { args: [], async: true, mac: "absent", desktop: "custom", windows: "absent" } }, events: {} } } };
  const files = { "packages/quiet/expo-module.config.json": '{"apple":{"modules":[]}}', "packages/quiet/ios/Other.swift": "public class OtherModule: Module {}\n" };
  const readFile = (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`ENOENT ${path}`);
    return files[path];
  };
  assert.deepEqual(macModuleProblems("quiet", entry, readFile, []), []);
  assert.deepEqual(macModuleProblems("quiet", entry, readFile, ["packages/quiet/ios/Other.swift"]), []);
  files["packages/quiet/ios/Quiet.swift"] = "public class QuietModule: Module, QuietNative {}\n";
  assert.match(macModuleProblems("quiet", entry, readFile, ["packages/quiet/ios/Quiet.swift"]).join("\n"), /has nothing on the Mac, yet QuietModule conforms to QuietNative/);
  const onMac = { ...entry, modules: { ArdiaQuiet: { ...entry.modules.ArdiaQuiet, functions: { probe: { ...entry.modules.ArdiaQuiet.functions.probe, mac: "custom" } } } } };
  assert.match(macModuleProblems("quiet", onMac, readFile, []).join("\n"), /names no generated Swift/);
  delete files["packages/quiet/expo-module.config.json"];
  assert.deepEqual(macModuleProblems("quiet", entry, readFile, ["packages/quiet/ios/Other.swift"]), [], "a Windows-only package with no expo-module.config.json is never read for one");
  const constantOnly = { ...entry, swift: "packages/quiet/ios/QuietNative.swift", modules: { ArdiaQuiet: { ...entry.modules.ArdiaQuiet, constants: { level: { mac: "custom", desktop: "absent", windows: "absent" } } } } };
  files["packages/quiet/ios/QuietNative.swift"] = "protocol QuietNative {\n  static var level: Int { get }\n}\n";
  files["packages/quiet/expo-module.config.json"] = '{"apple":{"modules":["QuietModule"]}}';
  files["packages/quiet/ios/Quiet.swift"] = "public class QuietModule: Module, QuietNative {\n  static var level: Int { 1 }\n  public func definition() -> ModuleDefinition {\n    Name(Self.moduleName)\n  }\n}\n";
  assert.match(macModuleProblems("quiet", constantOnly, readFile, ["packages/quiet/ios/Quiet.swift"]).join("\n"), /registers no generated constants, not level/);
  files["packages/quiet/ios/Quiet.swift"] = files["packages/quiet/ios/Quiet.swift"].replace("Name(Self.moduleName)\n", "Name(Self.moduleName)\n    Self.levelConstant\n");
  assert.deepEqual(macModuleProblems("quiet", constantOnly, readFile, ["packages/quiet/ios/Quiet.swift"]), []);
});

test("a module domain's package reaches each of its Expo modules only through the generated types", () => {
  for (const [domain, entry] of moduleDomains) {
    const sources = filesUnder(`${entry.package}/src/`, /\.tsx?$/).filter((path) => path !== entry.types).map((path) => [path, read(path)]);
    let typed = 0;
    let imported = false;
    for (const [path, text] of sources) {
      walk(parseTs(path, text), (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^\.\/generated\/native(?:\.ts)?$/.test(node.moduleSpecifier.text)) imported = true;
      });
      const found = nativeModuleTypingProblems(text, domain, entry.modules, path);
      assert.deepEqual(found.problems, [], path);
      typed += found.typed;
    }
    assert.ok(imported, `${entry.package}/src imports its generated types`);
    assert.ok(typed > 0, `${entry.package}/src reaches a module through its generated types`);
  }
});

test("the Linux host dispatches a module function or constant exactly when its desktop binding is host or adapted, and sends a module event under its own name exactly when it is host", () => {
  const linux = linuxModuleDispatch(linuxSources());
  for (const { module, fn, binding } of moduleFunctions) assert.equal(linux.methods.has(`${module}.${fn}`), reachesLinuxHost(binding), `${module}.${fn} is ${binding.desktop} on the desktop host`);
  for (const { module, constant, binding } of moduleConstants) assert.equal(linux.methods.has(`${module}.${constant}`), reachesLinuxHost(binding), `constant ${module}.${constant} is ${binding.desktop} on the desktop host`);
  for (const { module, event, binding } of moduleEvents) assert.equal(linux.events.has(`${module}.${event}`), binding.desktop === "host", `event ${module}.${event} is ${binding.desktop} on the desktop host`);
});

test("the Linux scan counts an if that dispatches inside a function that isn't a boolean helper, skips literals, and reads raw strings and digit separators", () => {
  const helpers = [
    'bool HandlesHold(std::string_view method) { return method == "ArdiaDemo.hold"; }',
    'bool Handles(std::string_view method) {\n  if (method == "ArdiaDemo.logged") {\n    LOG(INFO) << "handled";\n    return true;\n  }\n  return false;\n}',
    'static inline bool Knows(const std::string& name) {\n  if (name == "ArdiaDemo.known") { Note(name); return true; }\n  return false;\n}',
    'auto handles = [](std::string_view method) {\n  if (method == "ArdiaDemo.lambda") { Count(); return true; }\n  return false;\n};',
    'auto typed = [](std::string_view method) -> bool {\n  if (method == "ArdiaDemo.typed") { Count(); return Check(); }\n  return Fallback();\n};',
    'void Run(std::string_view method) {\n  if (method == "ArdiaDemo.peek") return true;\n  if (method == "ArdiaDemo.mixed" && ready) return Run();\n  const bool held = name == "ArdiaDemo.held" ? Go() : false;\n}',
    'if (method == "ArdiaDemo.outside") Run();',
  ].join("\n");
  assert.deepEqual([...linuxModuleDispatch([helpers]).methods], []);
  const dispatching = [
    "constexpr int kLimit = 5'000;",
    'const char* kPage = R"html(<a href="//x">)</a> void F(std::string_view method) { if (method == "ArdiaDemo.inRaw") Run(); })html";',
    "void Invoke(std::string_view method, Done done) {",
    "  for (int i = 0; i < kLimit; i++) {}",
    '  if (method == "ArdiaDemo.probe" || name == "ArdiaDemo.peek") {',
    "    LOG(INFO) << \"probing\";",
    "    return Probe(std::move(done));",
    "  }",
    '  if (method == "ArdiaDemo.open") return Open(kLimit);',
    "  PostTask(base::BindOnce([](std::string_view method, Done done) {",
    '    if (method == "ArdiaDemo.later") return Later(std::move(done));',
    "  }, method, std::move(done)));",
    "}",
    'Outcome Core::Dispatch(std::string_view method) {\n  if (method == "ArdiaDemo.outcome") return Outcome::Ok();\n  return Outcome::Unknown();\n}',
  ].join("\n");
  assert.deepEqual([...linuxModuleDispatch([dispatching]).methods].sort(), ["ArdiaDemo.later", "ArdiaDemo.open", "ArdiaDemo.outcome", "ArdiaDemo.peek", "ArdiaDemo.probe"]);
  assert.deepEqual([...linuxModuleDispatch(['const char* kHelp = "SendEvent(\\"ArdiaDemo\\", \\"tone\\")";\nSendEvent("ArdiaDemo", "real", payload);']).events], ["ArdiaDemo.real"]);
  assert.equal(stripCppComments('int a = 1\'000; // gone\nconst char* b = R"x(// kept)x"; /* gone */'), 'int a = 1\'000; \nconst char* b = R"x(// kept)x";  ');
  assert.equal(maskCppLiterals('f("a{b", R"x(})x", 1\'0, \'}\')'), 'f("   ", R"     ", 1\'0, \' \')');
});

test("the Linux scan counts a row of a method route table as a dispatched module function, never one inside a comment or a literal", () => {
  const source = 'inline constexpr Method kMethods[] = {\n    {"ArdiaSync.chooseFolder", Route::kChooseFolder},\n    // {"ArdiaSync.ghost", Route::kCore},\n    {"ArdiaSync.core",\n     Route::kCore},\n};\nconst char* kText = "{\\"ArdiaSync.fake\\", Route::kCore}";\n';
  assert.deepEqual([...linuxModuleDispatch([source]).methods].sort(), ["ArdiaSync.chooseFolder", "ArdiaSync.core"]);
});

test("the Linux scan resolves a method or event named by a string constant, through namespaces, aliases and a bool flag, and skips one it can't pin to a single value", () => {
  const header = 'namespace ardia::desktop_report {\ninline constexpr char kEvent[] = "onReport";\n}\nnamespace ardia::linux_hardware {\ninline constexpr char kHardwareInfoCall[] = "ArdiaApp.hardwareInfo";\n}\nnamespace one {\ninline constexpr char kCall[] = "ArdiaApp.first";\n}\nnamespace two {\ninline constexpr char kCall[] = "ArdiaApp.second";\n}\n';
  const host = 'namespace hardware = ardia::linux_hardware;\nvoid Host::Run(std::string_view method) {\n  host->Event("ArdiaReport", ardia::desktop_report::kEvent, base::Value());\n  if (method == hardware::kHardwareInfoCall) return Reply();\n  auto nested = [](std::string_view method) {\n    const bool changing = method == "ArdiaSystem.nested";\n    return changing;\n  };\n  const bool changing = method == "ArdiaSystem.setAsDefaultBrowser";\n  if (method == "ArdiaSystem.isDefaultBrowser" || changing) return Reply();\n  if (method == kCall) return Reply();\n  if (method == "ArdiaApp.gated" && ready) return Reply();\n  const bool other = method == "ArdiaSystem.otherFlag";\n}\nvoid Other::Run(std::string_view method) {\n  if (method == "ArdiaSystem.elsewhere" || other) return Reply();\n}\n';
  const found = linuxModuleDispatch([header, host]);
  assert.deepEqual([...found.events], ["ArdiaReport.onReport"]);
  assert.deepEqual([...found.methods].sort(), ["ArdiaApp.hardwareInfo", "ArdiaSystem.elsewhere", "ArdiaSystem.isDefaultBrowser", "ArdiaSystem.setAsDefaultBrowser"], "a flag declared in another function never names a method here");
  assert.equal(resolveCppConstant("two::kCall", new Map(), cppStringConstants([header])), "ArdiaApp.second");
});

test("the Linux event scan reads a module event sent by name through SendEvent or a host's Event, never one inside a literal", () => {
  const source = 'void Host::Run() {\n  host->Event("ArdiaImport", "onImportEvent", base::Value());\n  Event("ArdiaShell", "onOpenURLs", base::Value());\n  SendEvent("ArdiaShell", "shell", base::Value());\n  Log("Event(\\"ArdiaFake\\", \\"onGhost\\")");\n  sink_.Run(caller, "onChange", base::Value());\n}\n';
  assert.deepEqual([...linuxModuleDispatch([source]).events].sort(), ["ArdiaImport.onImportEvent", "ArdiaShell.onOpenURLs", "ArdiaShell.shell"]);
});

test("the Mac registration scan counts only a generated definition that stands as its own statement, across lines, and sees a hand-written registration however it's spaced", () => {
  const module = (definition) => `public class DemoModule: Module, DemoNative {\n  static func hold(_ on: Bool) {}\n\n  public func definition() -> ModuleDefinition {\n${definition}\n  }\n}\n`;
  assert.deepEqual(swiftRegistrations(module('    Name(Self.moduleName)\n    Self.holdFunction\n    View(DemoView.self) {\n      Prop("on") { (view: DemoView, on: Bool) in view.on = on }\n      Events("onTone")\n    }'), "DemoModule"), { generated: ["hold"], constants: [], events: false, name: true, handWritten: [] });
  assert.deepEqual(swiftRegistrations(module('    Name(Self.moduleName)\n    Self.holdFunction\n    AsyncFunction("extra") { () in }'), "DemoModule").handWritten, ["AsyncFunction"]);
  assert.deepEqual(swiftRegistrations(module('    Name(Self.moduleName)\n    Events("tone")\n    Self.holdFunction'), "DemoModule").handWritten, ["Events"]);
  assert.deepEqual(swiftRegistrations(module('    Name("ArdiaDemo")\n    Self.holdFunction'), "DemoModule"), { generated: ["hold"], constants: [], events: false, name: false, handWritten: ["Name"] });
  const assigned = swiftRegistrations(module('    Name(Self.moduleName)\n    let _ = Self.holdFunction\n    Function ("extra") { 1 }'), "DemoModule");
  assert.deepEqual(assigned, { generated: [], constants: [], events: false, name: true, handWritten: ["Function", "let _ = Self.holdFunction"] });
  const split = swiftRegistrations(module("    Name(Self.moduleName)\n    let _ =\n      Self.holdFunction"), "DemoModule");
  assert.deepEqual(split.generated, []);
  assert.deepEqual(split.handWritten, ["let _ =\n      Self.holdFunction"]);
  for (const lead of ["let held:\n      AnyDefinition =", "_ = [", "print(", "return"]) {
    const found = swiftRegistrations(module(`    Name(Self.moduleName)\n    ${lead}\n      Self.holdFunction${lead.endsWith("[") ? "]" : lead.endsWith("(") ? ")" : ""}`), "DemoModule");
    assert.deepEqual(found.generated, [], lead);
  }
  const chained = swiftRegistrations(module("    Name(Self.moduleName)\n    Self.holdFunction\n      .runOnQueue(.main)\n    Self.peekFunction"), "DemoModule");
  assert.deepEqual(chained.generated, ["peek"]);
  assert.deepEqual(swiftRegistrations(module("    Name (Self.moduleName)\n    Self.holdFunction; Self.eventsDefinition\n    AsyncFunction\n      (\"late\") { () in }"), "DemoModule"), { generated: ["hold"], constants: [], events: true, name: true, handWritten: ["AsyncFunction"] });
  assert.deepEqual(swiftRegistrations(module("    Name(Self.moduleName)\n    Name(Self.moduleName)\n    Self.holdFunction"), "DemoModule").handWritten, ["Name"]);
  const instance = swiftRegistrations(module("    Name(Self.moduleName)\n    claimFunction\n    self.watchFunction\n    Self.apiVersionConstant\n    let _ = claimFunction\n    _ = self.coreConstant"), "DemoModule");
  assert.deepEqual(instance.generated, ["claim", "watch"]);
  assert.deepEqual(instance.constants, ["apiVersion"]);
  assert.deepEqual(instance.handWritten, ["_ = self.coreConstant"]);
});

test("the typing scan reads the TypeScript syntax tree: it refuses a wrapper typed any, a hand-typed literal, and any cast past the generated type however it's wrapped or spread", () => {
  const modules = { ArdiaDemo: { native: "DemoNative" } };
  const problems = (source) => nativeModuleTypingProblems(source, "demo", modules).problems.length;
  const wrapper = (type) => `const nativeModule = <Name extends keyof DemoModules>(name: Name) => requireNativeModule<${type}>(name);\nconst Demo = nativeModule("ArdiaDemo");`;
  assert.deepEqual(nativeModuleTypingProblems(wrapper("DemoModules[Name]"), "demo", modules), { problems: [], typed: 1 });
  assert.equal(problems(wrapper("any")), 1);
  assert.equal(problems("const m = (name: string) => requireNativeModule<DemoModules[Name]>(name);"), 1);
  assert.equal(problems('requireNativeModule<{ run(cb: () => void): Promise<Map<string, number>> }>("ArdiaDemo");'), 1);
  assert.equal(problems('requireNativeModule("ArdiaDemo");'), 1);
  assert.deepEqual(nativeModuleTypingProblems('requireNativeModule<DemoNative>("ArdiaDemo"); requireNativeModule<DemoModules["ArdiaDemo"]>(\'ArdiaDemo\'); requireNativeModule<{}>("ArdiaElse");', "demo", modules), { problems: [], typed: 2 });
  assert.equal(problems("const Demo = requireNativeModule<{ hold(): void }>('ArdiaDemo');"), 1);
  for (const cast of [
    'const Demo = (requireNativeModule<DemoNative>("ArdiaDemo")) as any;',
    'const Demo = ((requireNativeModule<DemoNative>("ArdiaDemo")!)) as unknown as { hold(): void };',
    'const Demo = requireNativeModule<DemoNative>(\n  "ArdiaDemo"\n) as unknown as { hold(): void };',
    'const Demo = <any>requireNativeModule<DemoNative>("ArdiaDemo");',
    'const Demo = requireNativeModule<DemoNative>("ArdiaDemo");\nconst loose = (Demo) as any;',
    `${wrapper("DemoModules[Name]")}\nconst loose = (nativeModule(\n  "ArdiaDemo"\n)) as any;`,
    `${wrapper("DemoModules[Name]")}\nconst loose = Demo as Record<string, unknown>;`,
  ]) assert.equal(problems(cast), 1, cast);
  assert.equal(problems('const Demo = requireNativeModule<DemoNative>("ArdiaDemo") satisfies DemoNative;\nconst label = "as any" + String(Demo as const);'), 0);
  assert.equal(nativeModuleTypingProblems('const Demo = <any>requireNativeModule<DemoNative>("ArdiaDemo");', "demo", modules, "source.tsx").problems.length, 0, "in TSX, <any> opens JSX, not a cast");
  assert.equal(problems(`${wrapper("DemoModules[Name]")}\nconst Loose = (nativeModule("ArdiaDemo"))\n  as any;`), 0, "TypeScript ends the statement before an as on the next line, so nothing is cast");
  assert.equal(problems('const re = /requireNativeModule<any>("ArdiaDemo")/;\nconst text = "requireNativeModule<any>(\\"ArdiaDemo\\")";'), 0);
});

test("the Linux scan judges a branch by its innermost function, and a nested lambda's returns never make the function around it a bool helper", () => {
  const nestedBool = [
    "void Dispatch(std::string_view method, Done done) {",
    "  auto has = [&]() -> bool {",
    '    if (method == "ArdiaDemo.inLambda") { Note(); return true; }',
    "    return false;",
    "  };",
    "  auto plain = [&]() {",
    '    if (method == "ArdiaDemo.inPlain") { Note(); return true; }',
    "    return false;",
    "  };",
    '  if (method == "ArdiaDemo.outer") return Run(std::move(done));',
    "  if (has()) return;",
    "}",
  ].join("\n");
  assert.deepEqual([...linuxModuleDispatch([nestedBool]).methods], ["ArdiaDemo.outer"]);
  const helperInside = [
    "void Dispatch(std::string_view method, Done done) {",
    "  auto known = [](std::string_view name) { return name.size() > 0 ? true : false; };",
    "  auto yes = []() { return true; };",
    '  if (method == "ArdiaDemo.first") { Log(); return First(std::move(done)); }',
    '  if (method == "ArdiaDemo.second") return Second();',
    "}",
  ].join("\n");
  assert.deepEqual([...linuxModuleDispatch([helperInside]).methods].sort(), ["ArdiaDemo.first", "ArdiaDemo.second"]);
  const noOwnReturns = 'void Dispatch(std::string_view method, Done done) {\n  auto yes = []() { return true; };\n  if (method == "ArdiaDemo.quiet") { Quiet(std::move(done)); }\n}';
  assert.deepEqual([...linuxModuleDispatch([noOwnReturns]).methods], ["ArdiaDemo.quiet"], "a void dispatcher with no returns of its own isn't judged by its lambda's");
  const outerBool = cppFunctions(maskCppLiterals("bool Outer() {\n  auto run = []() { Go(); return Done(); };\n  return true;\n}"));
  assert.deepEqual(outerBool.map(({ header, boolean }) => [header.split("(")[0].trim(), boolean]), [["auto run = []", false], ["bool Outer", true]]);
});

test("the typing scan follows a block-bodied wrapper, a function declaration or expression, and a wrapper of a wrapper, to every cast", () => {
  const modules = { ArdiaDemo: { native: "DemoNative" } };
  const problems = (source) => nativeModuleTypingProblems(source, "demo", modules).problems;
  const wrappers = [
    'function nativeModule<N extends keyof DemoModules>(name: N) {\n  return requireNativeModule<DemoModules[N]>(name);\n}',
    'const nativeModule = <N extends keyof DemoModules>(name: N) => {\n  const module = 1;\n  return requireNativeModule<DemoModules[N]>(name);\n};',
    'const nativeModule = function <N extends keyof DemoModules>(name: N) {\n  return (requireNativeModule<DemoModules[N]>(name));\n};',
  ];
  for (const wrapper of wrappers) {
    assert.deepEqual(problems(`${wrapper}\nconst demo = nativeModule("ArdiaDemo");`), [], wrapper);
    for (const cast of ["as any", "as unknown", "as unknown as { hold(): void }"]) {
      assert.equal(problems(`${wrapper}\nconst demo = (nativeModule("ArdiaDemo")) ${cast};`).length, 1, `${wrapper} ${cast}`);
    }
    assert.equal(problems(`${wrapper}\nconst demo = nativeModule("ArdiaDemo");\nexport const loose = demo as any;`).length, 1, wrapper);
  }
  const twice = `${wrappers[0]}\nfunction backdrop() {\n  return nativeModule("ArdiaDemo");\n}\nconst outer = () => backdrop();\nconst a = (backdrop()) as any;\nconst b = outer() as unknown;`;
  assert.equal(problems(twice).length, 2);
});

test("the Mac registration scan takes Self and its generated member split across lines, and still refuses one that is assigned or discarded", () => {
  const module = (definition) => `public class DemoModule: Module, DemoNative {\n  public func definition() -> ModuleDefinition {\n${definition}\n  }\n}\n`;
  assert.deepEqual(swiftRegistrations(module("    Name(\n      Self\n        .moduleName\n    )\n    Self\n      .holdFunction\n    Self\n      .eventsDefinition"), "DemoModule"), { generated: ["hold"], constants: [], events: true, name: true, handWritten: [] });
  const discarded = swiftRegistrations(module("    Name(Self.moduleName)\n    let _ =\n      Self\n      .holdFunction\n    _ = Self\n      .eventsDefinition"), "DemoModule");
  assert.deepEqual(discarded.generated, []);
  assert.equal(discarded.events, false);
  assert.equal(discarded.handWritten.length, 2);
});
