import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MANIFEST, ROOT } from "./generate.mjs";

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
  const opening = /\bkRoutes\[\]\s*=\s*\{/g;
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
  const close = /\s*\}\s*;/y;
  close.lastIndex = at;
  if (!close.test(header)) throw new Error(`kRoutes has a row the scan can't read: ${JSON.stringify(header.slice(at, at + 80))}`);
  return routes;
}

const linuxRoutes = parseRoutes(linuxContract);

const LINUX = "engine/ardiacore-linux/src/ardia/linux/";
const CUSTOM_ONLY_DOMAINS = ["autofill", "contentBlocker", "passwords", "profiles", "webKit", "webView", "windows"];

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
const windows = JSON.parse(read("packages/expo-windows/src/engine/domains/forwarded.json"));
const { topics: macTopics, renamed: macRenamed } = macForwarding(read("packages/ardiacore/ios/ArdiaEngineBridge.mm"));
const generatedEvent = (name) => domains.some(([domain]) => name.startsWith(`${domain}.`));
const eventsOf = (host, binding) => domains.flatMap(([domain, entry]) => Object.entries(entry.events).filter(([, event]) => event[host] === binding).map(([event, row]) => ({ name: `${domain}.${event}`, topic: row.topic })));

test("the scans find the hosts' tables", () => {
  assert.ok(domains.length > 0);
  assert.ok(linuxRoutes.length > 30);
  assert.ok(linuxEvents.size > 3);
  assert.ok(Object.keys(windows.forwarded).length > 5);
  assert.ok(macTopics.length > 3);
  assert.ok(macRenamed.size > 0);
});

test("the kRoutes scan reads rows however they're wrapped and refuses what it can't read or a name routed twice", () => {
  const header = (rows) => `inline constexpr Route kRoutes[] = {\n${rows}\n};\n\ninline const Route* FindRoute(std::string_view name) {}\n`;
  assert.deepEqual(parseRoutes(header('    {\n"history.query",\n "ac_history_query", ""},\n    {"downloads.pause", "ac_downloads_command", "null"}')), [
    { name: "history.query", service: "ac_history_query", field: "" },
    { name: "downloads.pause", service: "ac_downloads_command", field: "null" },
  ]);
  assert.throws(() => parseRoutes(header('    {\n"history.query", "ac_evil", ""},\n    {"history.query", "ac_history_query", ""},')), /twice/);
  assert.throws(() => parseRoutes(header('    {"history.query", "ac_history_query", ""},\n    {kName, "ac_history_add", ""},')), /can't read/);
  assert.throws(() => parseRoutes(header('    {"history.query", "ac_history_query"},')), /can't read/);
  assert.throws(() => parseRoutes("struct Route {};"), /exactly once/);
});

test("the Linux WebUI allowlist routes exactly each generated domain's desktop-routed calls, to the same service", () => {
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
  for (const host of ["mac", "desktop", "windows"]) {
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

test("a domain Windows has no module for is absent there call by call and event by event, and forwarded.json never names it", () => {
  for (const domain of NO_WINDOWS_MODULE) {
    const entry = manifest.domains[domain];
    assert.ok(entry, `${domain} is a generated domain`);
    assert.deepEqual(Object.entries(entry.calls).filter(([, call]) => call.windows !== "absent").map(([verb]) => verb), [], `${domain}'s calls Windows serves`);
    assert.deepEqual(Object.entries(entry.events).filter(([, event]) => event.windows !== "absent").map(([event]) => event), [], `${domain}'s events Windows sends`);
    assert.equal(Object.hasOwn(windows.forwarded, domain), false, `forwarded.json forwards ${domain}`);
    assert.equal(Object.hasOwn(windows.missing, domain), false, `forwarded.json lists ${domain} as missing, which gives it a module`);
  }
});

test("Windows forwards exactly each generated domain's service-backed calls to the same engine call, and its forwarded events from their engine topics", () => {
  for (const [domain, entry] of domains.filter(([domain]) => !NO_WINDOWS_MODULE.includes(domain))) {
    const forwarded = Object.fromEntries(Object.entries(entry.calls).filter(([, call]) => call.windows === "service").map(([verb, call]) => [verb, call.service]));
    assert.deepEqual(windows.forwarded[domain] ?? {}, forwarded, `forwarded.json's ${domain} rows`);
    const absent = Object.entries(entry.calls).filter(([, call]) => call.windows === "absent").map(([verb]) => verb).sort();
    assert.deepEqual([...(windows.missing[domain] ?? [])].sort(), absent, `forwarded.json's missing ${domain} verbs`);
  }
  const forwarded = Object.fromEntries(eventsOf("windows", "forward").map(({ name, topic }) => [topic, name]));
  const generatedTopics = Object.fromEntries(Object.entries(windows.topics).filter(([, name]) => generatedEvent(name)));
  assert.deepEqual(generatedTopics, forwarded, "forwarded.json's topics for generated domains");
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
  assert.deepEqual(mixed.map(([domain]) => domain).sort(), ["autofill", "bookmarks", "contentBlocker", "downloads", "engine", "extensions", "favicons", "passwords", "permissions", "profiles", "search", "sites", "tabs", "webKit", "webView", "windows"]);
  for (const [domain, entry] of mixed) {
    const module = read(entry.swift.replace(/Calls\.swift$/, "Module.swift"));
    assert.match(module, new RegExp(`static let calls = ${domain}CallTable\\(`), `${domain}'s module`);
    assert.doesNotMatch(module, /CallTable\(domain:/, `${domain}'s module lists no rows of its own`);
  }
});
