import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { readApi, readManifest, typeRows } from "./apiRows.mjs";

const ios = new URL("../../ios/", import.meta.url);
const nativeFiles = readdirSync(ios).filter((f) => /\.(swift|mm)$/.test(f));
const native = (file) => readFileSync(new URL(file, ios), "utf8");
const src = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const api = readApi().replace(/\r\n/g, "\n");
const manifest = readManifest();
const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const sorted = (set) => [...set].sort();

test("api.ts takes each generated domain's calls and events from packages/hostapi and restates none of them", () => {
  const calls = typeRows(api, manifest, "EngineCalls");
  const events = typeRows(api, manifest, "EngineEvents");
  assert.deepEqual(sorted(calls.operands), sorted(Object.keys(manifest.domains).map((domain) => `${capitalized(domain)}Calls`)));
  assert.deepEqual(sorted(events.operands), sorted(Object.keys(manifest.domains).map((domain) => `${capitalized(domain)}Events`)));
  for (const domain of Object.keys(manifest.domains)) {
    const name = capitalized(domain);
    assert.match(api, new RegExp(`^import type \\{ ${name}Calls, ${name}Events \\} from "\\./generated/${domain}";$`, "m"));
    for (const key of [...calls.hand, ...events.hand]) assert.ok(!key.startsWith(`${domain}.`), `${key} comes from the schema, not a hand row`);
  }
});

test("a type composed from anything but generated domains and one row literal is refused, and every member of the literal is read as a row or refused, so no row escapes the parity checks", () => {
  const head = "export type EngineEvents = BookmarksEvents & FaviconsEvents & HistoryEvents & {";
  assert.ok(api.includes(head));
  const extra = `type Extra = {\n  "tabs.windowRequest": { id: string };\n};\n\n`;
  assert.throws(() => typeRows(extra + api.replace(head, "export type EngineEvents = Extra & BookmarksEvents & FaviconsEvents & HistoryEvents & {"), manifest, "EngineEvents"), /Extra, which isn't a generated domain/);
  assert.throws(() => typeRows(api.replace(head, "export type EngineEvents = BookmarksEvents & FaviconsEvents & (HistoryEvents) & {"), manifest, "EngineEvents"), /generated domains and one row literal/);
  const tail = api.indexOf("\n};\n", api.indexOf(head));
  assert.throws(() => typeRows(`${api.slice(0, tail)}\n} & Extra;\n${api.slice(tail + 4)}`, manifest, "EngineEvents"), /ends its type/);
  assert.throws(() => typeRows(api.replace(head, `${head}\n  ...Extra,`), manifest, "EngineEvents"), /only rows/);
  assert.throws(() => typeRows(`${api}\nexport type EngineEvents = {};\n`, manifest, "EngineEvents"), /2 times/);
  const row = api.slice(api.indexOf("\n", api.indexOf(head)) + 1).split("\n")[0];
  for (const extra of ['"history.undeclared": unknown;', "'history.undeclared': unknown;"]) {
    assert.ok(typeRows(api.replace(row, `${row} ${extra}`), manifest, "EngineEvents").rows.has("history.undeclared"), extra);
  }
  for (const extra of ["historyUndeclared: unknown;", '"history.undeclared2": unknown;', '"history_undeclared": unknown;', "[`history.undeclared`]: unknown;", '"history.undeclared"?: unknown;', "[key: string]: unknown;"]) {
    assert.throws(() => typeRows(api.replace(row, `${row} ${extra}`), manifest, "EngineEvents"), /only rows/, extra);
  }
  assert.throws(() => typeRows(api.replace(row, `${row}\n${row}`), manifest, "EngineEvents"), /twice/);
  assert.throws(() => typeRows(api.replace(head, 'export type EngineEvents<HistoryEvents = { "history.undeclared": unknown }> = BookmarksEvents & FaviconsEvents & HistoryEvents & {'), manifest, "EngineEvents"), /non-generic/);
  assert.throws(() => typeRows(api.replace(head, head.replace("export ", "")) + "\nexport type { EngineEvents };\n", manifest, "EngineEvents"), /2 times|exported/);
  assert.throws(() => typeRows(api.replace(head, head.replace("export ", "")), manifest, "EngineEvents"), /exported/);
  const historyImport = 'import type { HistoryCalls, HistoryEvents } from "./generated/history";';
  assert.ok(api.includes(historyImport));
  assert.throws(() => typeRows(api.replace(historyImport, `${"/"}* ${historyImport} *${"/"}\nimport type { HistoryCalls } from "./generated/history";\ntype HistoryEvents = { "history.undeclared": unknown };`), manifest, "EngineEvents"), /imported as is/);
  assert.throws(() => typeRows(api.replace(historyImport, 'import type { HistoryCalls, HistoryCalls as HistoryEvents } from "./generated/history";'), manifest, "EngineEvents"), /imported as is/);
});

test("a payload whose own keys look like rows doesn't count as a row", () => {
  const head = "export type EngineEvents = BookmarksEvents & FaviconsEvents & HistoryEvents & {";
  const nested = api.replace(head, `${head}\n  "bookmarks.nested": { "ui.label": string; 'x.y': number };`);
  const { hand } = typeRows(nested, manifest, "EngineEvents");
  assert.ok(hand.includes("bookmarks.nested"));
  assert.ok(!hand.includes("ui.label") && !hand.includes("x.y"));
});

test("a checkout with CRLF line endings reads the same rows as LF", () => {
  for (const name of ["EngineCalls", "EngineEvents"]) {
    assert.deepEqual([...typeRows(api.replace(/\n/g, "\r\n"), manifest, name).rows], [...typeRows(api, manifest, name).rows]);
  }
});

const PLAIN_PLATFORM_CALLS = new Set(["autofill.cardNumber"]);

test("the Mac never answers a call that hands a card number to JS; only Linux and Windows, which have no secure entries, keep it", () => {
  const autofill = native("AutofillModule.swift");
  assert.doesNotMatch(autofill, /^ {4}"cardNumber": /m);
  assert.match(autofill, /^ {4}"revealCard": /m);
});

test("every call in api.ts has a handler in its domain's Swift call table, and nothing else does", () => {
  const swift = new Set();
  for (const file of nativeFiles.filter((f) => /(Module|Calls)\.swift$/.test(f))) {
    const text = native(file);
    const domain = text.match(/CallTable\(domain: "([a-zA-Z]+)"/)?.[1];
    if (!domain) continue;
    for (const [, verb] of text.matchAll(/^ {4}"([a-zA-Z]+)": /gm)) swift.add(`${domain}.${verb}`);
  }
  assert.deepEqual(sorted(swift), sorted([...typeRows(api, manifest, "EngineCalls").rows].filter((call) => !PLAIN_PLATFORM_CALLS.has(call))));
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
  assert.match(sites, /"preloadPages": \{ args, reply in\s*ArdiaServices\.preloadPages\(profile: args\.profile\) \{ reply\.service\(\$0, \$1\) \}/);
  assert.match(sites, /"setPreloadPages": \{ args, reply in\s*ArdiaServices\.setPreloadPages\(try args\.bool\("on"\), profile: args\.profile\) \{ reply\.service\(\$0, \$1\) \}/);
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

test("no call handler reads the profile from its JSON arguments, since call() sends it on its own", () => {
  assert.match(src("./call.ts"), /const \{ profile = "", \.\.\.rest \}/, "call() moves profile out of the arguments");
  const readers = nativeFiles.filter((f) => /args\.(text|optionalText|bool|optionalBool)\("profile"\)/.test(native(f)));
  assert.deepEqual(readers, [], "these read a profile that never arrives; use args.profile");
});
