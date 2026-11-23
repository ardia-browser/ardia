import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { readApi, readManifest, typeRows } from "./apiRows.mjs";

const ios = new URL("../../ios/", import.meta.url);
const nativeFiles = readdirSync(ios).filter((f) => /\.(swift|mm)$/.test(f));
const native = (file) => readFileSync(new URL(file, ios), "utf8");

const api = readApi().replace(/\r\n/g, "\n");
const manifest = readManifest();
const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const sorted = (set) => [...set].sort();
const GENERATED_EVENTS = "AutofillEvents & BookmarksEvents & ContentBlockerEvents & DownloadsEvents & EngineDomainEvents & ExtensionsEvents & FaviconsEvents & HistoryEvents & PasswordsEvents & PermissionsEvents & ProfilesEvents & SearchEvents & SitesEvents & TabsEvents & WebKitEvents & WebViewEvents & WindowsEvents";
const EVENTS_TYPE = `export type EngineEvents = ${GENERATED_EVENTS}`;
const HAND_WIRED = ["media"];
const withoutRows = (source, type) => source.replace(new RegExp(`(export type ${type} = [^{;]*?) & \\{\\n[\\s\\S]*?\\n\\};`), "$1;");
const withRows = api;

test("api.ts takes each generated domain's calls and events from packages/hostapi and restates none of them", () => {
  const calls = typeRows(api, manifest, "EngineCalls");
  const events = typeRows(api, manifest, "EngineEvents");
  assert.deepEqual(sorted(calls.operands), sorted(Object.keys(manifest.domains).map((domain) => `${capitalized(domain)}Calls`)));
  assert.deepEqual(sorted(events.operands), sorted(Object.keys(manifest.domains).map((domain) => `${capitalized(domain)}Events`)));
  for (const domain of Object.keys(manifest.domains)) {
    const name = capitalized(domain);
    const as = (kind) => (`${name}${kind}` === `Engine${kind}` ? `${name}${kind} as ${name}Domain${kind}` : `${name}${kind}`);
    assert.match(api, new RegExp(`^import type \\{ ${as("Calls")}, ${as("Events")} \\} from "\\./generated/${domain}";$`, "m"));
    for (const key of [...calls.hand, ...events.hand]) assert.ok(!key.startsWith(`${domain}.`), `${key} comes from the schema, not a hand row`);
  }
});

test("every engine call and event but the hand-wired media domain's comes from the schema", () => {
  for (const type of ["EngineCalls", "EngineEvents"]) {
    const { hand } = typeRows(api, manifest, type);
    assert.ok(hand.length > 0, `${type} still lists media's rows`);
    assert.deepEqual([...new Set(hand.map((key) => key.split(".")[0]))], HAND_WIRED, `${type}'s hand-written rows`);
    const generatedOnly = withoutRows(api, type);
    assert.notEqual(generatedOnly, api);
    assert.deepEqual(typeRows(generatedOnly, manifest, type).hand, [], `${type} composed from generated domains alone`);
  }
  for (const domain of HAND_WIRED) assert.equal(manifest.domains[domain], undefined, `${domain} is hand-wired, not in the schema`);
  const extra = api.replace(`${EVENTS_TYPE} & {`, `${EVENTS_TYPE} & {\n  "sites.handWritten": unknown;`);
  assert.notEqual(extra, api);
  assert.notDeepEqual([...new Set(typeRows(extra, manifest, "EngineEvents").hand.map((key) => key.split(".")[0]))], HAND_WIRED);
});

test("a type composed from anything but generated domains and one row literal is refused, and every member of the literal is read as a row or refused, so no row escapes the parity checks", () => {
  const head = `${EVENTS_TYPE} & {`;
  assert.ok(withRows.includes(head));
  const extra = `type Extra = {\n  "tabs.windowRequest": { id: string };\n};\n\n`;
  assert.throws(() => typeRows(extra + withRows.replace(head, `export type EngineEvents = Extra & ${GENERATED_EVENTS} & {`), manifest, "EngineEvents"), /Extra, which isn't a generated domain/);
  assert.throws(() => typeRows(withRows.replace(head, `export type EngineEvents = ${GENERATED_EVENTS.replace("HistoryEvents", "(HistoryEvents)")} & {`), manifest, "EngineEvents"), /generated domains and at most one row literal/);
  const tail = withRows.indexOf("\n};\n", withRows.indexOf(head));
  assert.throws(() => typeRows(`${withRows.slice(0, tail)}\n} & Extra;\n${withRows.slice(tail + 4)}`, manifest, "EngineEvents"), /at most one row literal, last/);
  assert.throws(() => typeRows(withRows.replace(head, `${head}\n  ...Extra,`), manifest, "EngineEvents"), /only rows/);
  assert.throws(() => typeRows(`${api}\nexport type EngineEvents = {};\n`, manifest, "EngineEvents"), /2 times/);
  const row = withRows.slice(withRows.indexOf("\n", withRows.indexOf(head)) + 1).split("\n")[0];
  for (const extra of ['"history.undeclared": unknown;', "'history.undeclared': unknown;"]) {
    assert.ok(typeRows(withRows.replace(row, `${row} ${extra}`), manifest, "EngineEvents").rows.has("history.undeclared"), extra);
  }
  for (const extra of ["historyUndeclared: unknown;", '"history.undeclared2": unknown;', '"history_undeclared": unknown;', "[`history.undeclared`]: unknown;", '"history.undeclared"?: unknown;', "[key: string]: unknown;"]) {
    assert.throws(() => typeRows(withRows.replace(row, `${row} ${extra}`), manifest, "EngineEvents"), /only rows/, extra);
  }
  assert.throws(() => typeRows(withRows.replace(row, `${row}\n${row}`), manifest, "EngineEvents"), /twice/);
  assert.throws(() => typeRows(withRows.replace(head, `export type EngineEvents<HistoryEvents = { "history.undeclared": unknown }> = ${GENERATED_EVENTS} & {`), manifest, "EngineEvents"), /non-generic/);
  assert.throws(() => typeRows(withRows.replace(head, head.replace("export ", "")) + "\nexport type { EngineEvents };\n", manifest, "EngineEvents"), /2 times|exported/);
  assert.throws(() => typeRows(withRows.replace(head, head.replace("export ", "")), manifest, "EngineEvents"), /exported/);
  const historyImport = 'import type { HistoryCalls, HistoryEvents } from "./generated/history";';
  assert.ok(api.includes(historyImport));
  assert.throws(() => typeRows(api.replace(historyImport, `${"/"}* ${historyImport} *${"/"}\nimport type { HistoryCalls } from "./generated/history";\ntype HistoryEvents = { "history.undeclared": unknown };`), manifest, "EngineEvents"), /must be imported from \.\/generated\/history as its HistoryEvents/);
  assert.throws(() => typeRows(api.replace(historyImport, 'import type { HistoryCalls, HistoryCalls as HistoryEvents } from "./generated/history";'), manifest, "EngineEvents"), /must be imported from \.\/generated\/history as its HistoryEvents/);
  const engineImport = 'import type { EngineCalls as EngineDomainCalls, EngineEvents as EngineDomainEvents } from "./generated/engine";';
  assert.ok(api.includes(engineImport));
  assert.deepEqual(sorted(typeRows(api, manifest, "EngineEvents").operands).filter((operand) => operand.startsWith("Engine")), ["EngineEvents"]);
  assert.throws(() => typeRows(api.replace(engineImport, 'import type { EngineCalls as EngineDomainCalls, EngineCalls as EngineDomainEvents } from "./generated/engine";'), manifest, "EngineEvents"), /isn't a generated domain's events/);
  assert.throws(() => typeRows(api.replace(engineImport, 'import type { EngineCalls as EngineDomainCalls, EngineEvents as EngineDomainEvents } from "./generated/tabs";'), manifest, "EngineEvents"), /must be imported from \.\/generated\/engine/);
  assert.throws(() => typeRows(`${api}\nimport type { HistoryEvents as EngineDomainEvents } from "./generated/history";\n`, manifest, "EngineEvents"), /once/);
});

test("a payload whose own keys look like rows doesn't count as a row", () => {
  const head = `${EVENTS_TYPE} & {`;
  const nested = withRows.replace(head, `${head}\n  "bookmarks.nested": { "ui.label": string; 'x.y': number };`);
  const { hand } = typeRows(nested, manifest, "EngineEvents");
  assert.ok(hand.includes("bookmarks.nested"));
  assert.ok(!hand.includes("ui.label") && !hand.includes("x.y"));
});

test("a checkout with CRLF line endings reads the same rows as LF", () => {
  for (const name of ["EngineCalls", "EngineEvents"]) {
    assert.deepEqual([...typeRows(api.replace(/\n/g, "\r\n"), manifest, name).rows], [...typeRows(api, manifest, name).rows]);
  }
});

test("every call in api.ts has a handler in its domain's Swift call table, and nothing else does", () => {
  const swift = new Set();
  for (const file of nativeFiles.filter((f) => /(Module|Calls)\.swift$/.test(f))) {
    const text = native(file);
    const domain = text.match(/CallTable\(domain: "([a-zA-Z]+)"/)?.[1];
    if (!domain) continue;
    for (const [, verb] of text.matchAll(/^ {4}"([a-zA-Z]+)": /gm)) swift.add(`${domain}.${verb}`);
  }
  assert.deepEqual(sorted(swift), sorted(typeRows(api, manifest, "EngineCalls").rows));
});

test("Preload pages loads its profile first, so a profile that isn't open yet is read and written, not skipped", () => {
  const services = native("ArdiaServices.mm");
  const sites = native("SitesModule.swift");
  const methodBody = (signature) => {
    const start = services.indexOf(signature);
    assert.ok(start >= 0, `ArdiaServices.mm defines ${signature}`);
    return services.slice(start, services.indexOf("\n}\n", start));
  };
  assert.doesNotMatch(native("ArdiaServices.h"), /ArdiaProfileTogglePreloadPages/, "the toggles read LoadedProfile, which is nil for a profile that isn't open");
  for (const signature of ["+ (void)preloadPages:", "+ (void)setPreloadPages:"]) {
    const body = methodBody(signature);
    assert.match(body, /ardia_host::WithProfile\(/, `${signature} loads the profile before using it`);
    assert.match(body, /reply\(nil, @"/, `${signature} answers an error when the profile can't be loaded`);
  }
  assert.match(sites, /\bpreloadPages: \{ args, reply in\s*ArdiaServices\.preloadPages\(profile: args\.profile\) \{ reply\.service\(\$0, \$1\) \}/);
  assert.match(sites, /\bsetPreloadPages: \{ args, reply in\s*ArdiaServices\.setPreloadPages\(try args\.bool\("on"\), profile: args\.profile\) \{ reply\.service\(\$0, \$1\) \}/);
});

test("every event in api.ts is emitted natively under that name, and nothing else is", () => {
  const emitted = new Set();
  for (const file of nativeFiles) {
    for (const [, swift, objc] of native(file).matchAll(/ArdiaEvents\.emit\("([^"]+)"|ArdiaEvents emit:@"([^"]+)"/g)) emitted.add(swift ?? objc);
  }
  const bridge = native("ArdiaEngineBridge.mm");
  const between = (from, to) => bridge.slice(bridge.indexOf(from), bridge.indexOf(to, bridge.indexOf(from)));
  const renamed = new Map([...between("NSString *AppEventOfTopic(", "\n}").matchAll(/isEqualToString:@"([^"]+)"\] \? @"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  for (const [, topic] of between("ForwardedTopics()", "];").matchAll(/@"([^"]+)"/g)) emitted.add(renamed.get(topic) ?? topic);
  assert.deepEqual(sorted(emitted), sorted(typeRows(api, manifest, "EngineEvents").rows));
});
