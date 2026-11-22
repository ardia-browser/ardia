import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import inventory from "./boundaries.json" with { type: "json" };
import { evaluateCalls, listenerCalls as parsedListenerCalls, messageCalls } from "../../../scripts/security/boundary-detectors.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const onDisk = new Map();
const readFromDisk = (path) => {
  if (!onDisk.has(path)) onDisk.set(path, readFileSync(join(ROOT, path), "utf8"));
  return onDisk.get(path);
};
const filesIn = (dir, pick) => readdirSync(join(ROOT, dir)).filter(pick).map((name) => `${dir}/${name}`);
const walk = (dir, pick) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "test-native" || entry.name === "fixtures" ? [] : walk(path, pick);
    return pick(entry.name) ? [path] : [];
  });
const matches = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]);
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const unique = (list) => [...new Set(list)].sort();
const notTest = (name) => !/\.test\.|\.d\.ts$/.test(name);

const PAGE_SCRIPT = "packages/ardiacore/ios/page_script.js";
const IOS = "packages/ardiacore/ios";

function bodyOf(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${signature} is where the inventory reads it`);
  const end = text.indexOf("\n  }\n", start);
  return text.slice(start, end < 0 ? undefined : end);
}

const KIND = /^[A-Za-z0-9_.:-]+$/;
const SENT = /\b(?:send|post)\(\s*"([^"\n]*)"|\b(?:send|post)\(\s*'([^'\n]*)'/g;
const RECEIVED_NATIVE = /\[kind isEqualToString:@"([^"\n]*)"\]/g;
const RECEIVED_SWIFT = /case "([^"\n]*)":/g;
const quoted = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1] ?? m[2]);
const NATIVE_ADD_LISTENER = /(?:const|let|var)\s+(\w+)\s*=\s*(?:[\w.]+\s*&&\s*)?(?:window\.)?EventTarget\.prototype\.addEventListener\b|(\w+):\s*(?:window\.)?EventTarget\.prototype\.addEventListener\b/g;

function listenerAliases(text) {
  const aliases = new Set(["listen", "addListener"]);
  for (const m of text.matchAll(NATIVE_ADD_LISTENER)) aliases.add(m[1] ?? m[2]);
  for (const alias of [...aliases]) for (const m of text.matchAll(new RegExp(String.raw`(\w+):\s*${alias}\b`, "g"))) aliases.add(m[1]);
  return [...aliases];
}

function listenerPatterns(text) {
  const aliases = listenerAliases(text);
  const through = String.raw`|\bapply\(\s*(?:${aliases.join("|")})\s*,\s*[^,\[\]]+,\s*\[\s*`;
  return {
    named: new RegExp(String.raw`(?:addEventListener\(\s*${through})["']([^"']+)["']`, "g"),
    calls: new RegExp(String.raw`addEventListener\(|\bapply\(\s*(?:${aliases.join("|")})\s*,`, "g"),
  };
}

const listenedEvents = (text) => matches(text, listenerPatterns(text).named);
const listenerCalls = (text) => count(text, listenerPatterns(text).calls);

function detectedEntries(read = readFromDisk) {
  const entries = [];
  const outside = [];
  entries.outside = outside;
  const add = (surface, key, extra = {}) => entries.push({ id: `${surface}:${key}`, ...extra });
  const addKinds = (surface, kinds, where) => {
    for (const kind of unique(kinds)) {
      if (KIND.test(kind)) add(surface, kind);
      else outside.push(`${where}: ${JSON.stringify(kind)}`);
    }
  };

  const pageScript = read(PAGE_SCRIPT);
  const pageListeners = parsedListenerCalls(PAGE_SCRIPT, pageScript);
  const pageMessages = messageCalls(PAGE_SCRIPT, pageScript);
  const pageMessageFiles = filesIn(IOS, (n) => n.endsWith(".mm")).filter((f) => /didReceivePageMessage:\(NSString \*\)kind|holdPageMessage:\(NSString \*\)kind/.test(read(f)));
  const nativeReceivers = pageMessageFiles.flatMap((f) => quoted(read(f), RECEIVED_NATIVE));
  addKinds("chromium-page-message", [...pageMessages.filter((m) => !m.computed).map((m) => m.name), ...nativeReceivers], "a Chromium page message kind");
  add("page-script-message-count", "page_script.js", { count: pageMessages.length });
  addKinds("page-script-listener", pageListeners.filter((l) => !l.computed).map((l) => l.name), "a page script event name");
  add("page-script-listener-count", "page_script.js", { count: pageListeners.length });

  const webkitScripts = filesIn(IOS, (n) => /^WebKit.*\.swift$/.test(n));
  const webkitPosted = webkitScripts.flatMap((f) => quoted(read(f), SENT)).filter((k) => !["close", "show", "showConsole", "toggleElementSelection"].includes(k));
  const webkitReceived = [
    ...quoted(bodyOf(read(`${IOS}/WebKitTab.swift`), "func pageMessage("), RECEIVED_SWIFT),
    ...quoted(read(`${IOS}/WebKitTab+Site.swift`), RECEIVED_SWIFT),
    ...quoted(read(`${IOS}/WebKitTab+FieldProviders.swift`), RECEIVED_SWIFT),
  ];
  addKinds("webkit-page-message", [...webkitPosted, ...webkitReceived], "a WebKit page message kind");
  for (const f of webkitScripts) {
    const n = listenerCalls(read(f));
    if (n) add("webkit-page-listener-count", f.slice(IOS.length + 1), { count: n });
  }
  for (const f of [...filesIn(IOS, (n) => n.endsWith(".swift")), ...filesIn("packages/shell/ios", (n) => n.endsWith(".swift"))])
    if (/func userContentController\(/.test(read(f))) add("webkit-script-handler", relative("packages", f));

  for (const f of walk("apps/browser/src", (n) => /\.(ts|tsx)$/.test(n) && notTest(n))) {
    const n = evaluateCalls(f, read(f));
    if (n) add("evaluate-result", f.slice("apps/browser/src/".length), { count: n });
  }

  const shellEvents = read("packages/shell/ios/ShellEvents.swift");
  for (const channel of matches(bodyOf(shellEvents, "enum Channel"), /case (\w+) = "/g)) add("native-channel", channel);

  for (const f of walk("apps/browser/src/state/sync", (n) => n.endsWith(".ts") && notTest(n))) {
    const file = f.slice("apps/browser/src/state/sync/".length);
    for (const [, name, many] of read(f).matchAll(/^export function (\w+)\((?:(?!^export )[\s\S])*?\): (?:Adapter|ExtensionsAdapter|\(forced: boolean\) => Adapter)(\[\])? \{$/gm))
      add(many ? "sync-adapter-set" : "sync-adapter", `${file}#${name}`);
    for (const name of matches(read(f), /^export const (\w+): Adapter = /gm)) add("sync-adapter", `${file}#${name}`);
  }

  const channelApi = read("apps/browser/src/state/plugins/channelApi.ts");
  addKinds("plugin-method", quoted(channelApi, RECEIVED_SWIFT), "a plugin method name");

  const catalog = read("apps/browser/src/state/automation/socketCatalog.ts");
  const families = /SOCKET_FAMILIES = \[([^\]]+)\]/.exec(catalog)[1];
  for (const family of matches(families, /"([a-z_]+)"/g)) add("socket-family", family);

  for (const f of walk("apps/browser/src/state", (n) => n.endsWith(".ts") && notTest(n))) {
    const n = count(read(f), /settings: \{ ?\.\.\.(?:s|state|before|now|prev|get\(\))\.settings\b/g);
    if (n) add("raw-settings-write", f.slice("apps/browser/src/".length), { count: n });
  }
  return entries;
}

const rows = inventory.rows;
const rowById = new Map(rows.map((r) => [r.id, r]));

test("every boundary row is unique, says where its input comes from and names the check that guards it", () => {
  assert.equal(rowById.size, rows.length, "no row twice");
  for (const row of rows) {
    assert.match(row.id, /^[a-z-]+:.+$/, row.id);
    assert.ok(inventory.sources[row.source], `${row.id}: source ${row.source} is one of ${Object.keys(inventory.sources).join(", ")}`);
    assert.equal(typeof row.guard, "string", `${row.id}: says what guards it`);
    assert.ok(row.guard.length >= 8, `${row.id}: guard`);
  }
});

test("every check a row names still exists where the row says", () => {
  for (const row of rows) {
    for (const ref of row.checks ?? []) {
      const [path, symbol] = ref.split("#");
      assert.ok(existsSync(join(ROOT, path)), `${row.id}: ${path} exists`);
      if (symbol) assert.ok(readFromDisk(path).includes(symbol), `${row.id}: ${path} still has ${symbol}`);
    }
  }
});

function unlisted(found) {
  const detectedIds = new Set(found.map((e) => e.id));
  return {
    missing: found.filter((e) => !rowById.has(e.id)).map((e) => e.id),
    changed: found.filter((e) => rowById.has(e.id) && e.count !== undefined && rowById.get(e.id).count !== e.count).map((e) => `${e.id}: ${rowById.get(e.id).count} -> ${e.count}`),
    gone: rows.filter((r) => r.detected !== false && !detectedIds.has(r.id)).map((r) => r.id),
    outside: found.outside ?? [],
  };
}

test("every place page, sync, plugin, socket or other-app data enters the browser is in the boundary table", () => {
  const { missing, changed, gone, outside } = unlisted(detectedEntries());
  assert.deepEqual(outside, [], "a kind or event name outside the inventory's grammar (letters, digits, _ . : -): rename it, or the table can't hold its row");
  const advice = "Add or update its row in apps/browser/src/boundaries.json and name the check that guards it (docs/security-testing.md).";
  assert.deepEqual(missing, [], `new entry points with no row. ${advice}`);
  assert.deepEqual(changed, [], `entry points whose call count changed. ${advice}`);
  assert.deepEqual(gone, [], "rows whose entry point is gone: remove them, or mark a hand-kept row detected: false");
});

const withAdded = (additions) => (path) => readFromDisk(path) + (additions[path] ? `\n${/\.(?:m?js|tsx?)$/.test(path) ? ";\n" : ""}${additions[path]}\n` : "");

const NO_ROW_TS = "apps/browser/src/state/site/contentBlocking.ts";
const ROW_TS = "apps/browser/src/state/site/translate.ts";
const NEW_EVALUATE = "evaluate-result:state/site/contentBlocking.ts";

const PROMISED_FORMS = {
  "TypeScript (parsed): evaluate": [
    { form: "a plain call", code: "void web.evaluate(code);" },
    { form: "an optional-chained receiver", code: "void web?.evaluate(code);" },
    { form: "an optional call", code: "void web.evaluate?.(code);" },
    { form: "a function type in the generic", code: "void web.evaluate<() => void>(code);" },
    { form: "a nested generic", code: "void web?.evaluate<Array<Record<string, string>>>(code);" },
    { form: "computed access by name", code: 'void web["evaluate"](code);' },
    { form: "a destructured binding", code: "const { evaluate } = web;\nvoid evaluate(code);" },
    { form: "a renamed destructured binding", code: "const { evaluate: run } = web;\nvoid run(code);" },
    { form: "an alias variable", code: "const ev = web.evaluate;\nvoid ev(code);" },
    { form: "call and apply", code: "void web.evaluate.call(web, code);\nvoid web.evaluate.apply(web, [code]);" },
    { form: "a cast callee", code: "void (web.evaluate as (c: string) => Promise<unknown>)(code);" },
    { form: "an alias passed through an object and destructured", code: "const kit = { look: web.evaluate };\nconst { look } = kit;\nvoid look(code);" },
    { form: "an instantiation expression held in a variable", code: "const runFixture = web.evaluate<unknown>;\nvoid runFixture(code);" },
    { form: "a parenthesized computed key", code: 'void web[("evaluate")](code);' },
  ].map((f) => ({ ...f, file: NO_ROW_TS, missing: NEW_EVALUATE })).concat([{ form: "one more call in a file with a row", file: ROW_TS, code: "void webviews.get(tabId)?.evaluate?.(code);", changed: "evaluate-result:state/site/translate.ts" }]),
  "page_script.js (parsed): listeners": [
    { form: "addEventListener", code: 'window.addEventListener("fixture-a", f);', missing: "page-script-listener:fixture-a" },
    { form: "the event name on the next line", code: 'document.addEventListener(\n  "fixture-b",\n  f,\n);', missing: "page-script-listener:fixture-b" },
    { form: "an optional call", code: 'window.addEventListener?.("fixture-c", f);', missing: "page-script-listener:fixture-c" },
    { form: "apply through a variable alias", code: 'const listenOnFixture = window.EventTarget && EventTarget.prototype.addEventListener;\napply(listenOnFixture, window, ["fixture-d", f]);', missing: "page-script-listener:fixture-d" },
    { form: "apply through a destructured alias", code: 'const { addEventListener: hearFixture } = EventTarget.prototype;\napply(hearFixture, window, ["fixture-e", f]);', missing: "page-script-listener:fixture-e" },
    { form: "an alias's call", code: 'const { addEventListener: hearFixture } = EventTarget.prototype;\nhearFixture.call(window, "fixture-f", f);', missing: "page-script-listener:fixture-f" },
    { form: "Reflect.apply", code: 'Reflect.apply(EventTarget.prototype.addEventListener, window, ["fixture-g", f]);', missing: "page-script-listener:fixture-g" },
    { form: "an alias passed through an object and destructured", code: 'const kitFixture = { onFixture: EventTarget.prototype.addEventListener };\nconst { onFixture } = kitFixture;\napply(onFixture, document, ["fixture-h", f]);', missing: "page-script-listener:fixture-h" },
    { form: "the global addEventListener", code: 'addEventListener("fixture-i", f);', missing: "page-script-listener:fixture-i" },
    { form: "a key of an object passed to a function and destructured there", code: 'kitFixture({ hearKey: EventTarget.prototype.addEventListener });\nfunction kitFixture(env) {\n  const { hearKey } = env;\n  apply(hearKey, document, ["fixture-j", f]);\n}', missing: "page-script-listener:fixture-j" },
    { form: "a computed event name", code: "window.addEventListener(fixtureType, f);", changed: "page-script-listener-count:page_script.js" },
    { form: "a local function that shares an alias's name doesn't count", code: "function shadowFixture() {\n  const listen = () => 1;\n  listen();\n}", unchanged: "page-script-listener-count:page_script.js" },
    { form: "an event name outside the grammar fails", code: 'window.addEventListener("has space", f);', outside: '"has space"' },
  ].map((f) => ({ ...f, file: PAGE_SCRIPT })),
  "page_script.js (parsed): messages": [
    { form: "send", code: 'send("fixtureKind", {});', missing: "chromium-page-message:fixtureKind" },
    { form: "a kind beginning with a digit", code: 'send("2fa", {});', missing: "chromium-page-message:2fa" },
    { form: "single quotes and a hyphen", code: "send('pick-done', {});", missing: "chromium-page-message:pick-done" },
    { form: "a template literal", code: "send(`fixture.dotted`, {});", missing: "chromium-page-message:fixture.dotted" },
    { form: "an alias of send", code: 'const sendFixture = send;\nsendFixture("aliasedKind", {});', missing: "chromium-page-message:aliasedKind" },
    { form: "a computed kind", code: "send(fixtureKind, {});", changed: "page-script-message-count:page_script.js" },
    { form: "a call through a locally assigned object property", code: 'const bridgeFixture = { publish: send };\nbridgeFixture.publish("bridgedKind", {});', missing: "chromium-page-message:bridgedKind" },
    { form: "a kind with a space fails", code: 'send("has space", {});', outside: '"has space"' },
    { form: "an empty kind fails", code: 'send("", {});', outside: '""' },
  ].map((f) => ({ ...f, file: PAGE_SCRIPT })),
  "Objective-C++ receivers (pattern)": [
    { form: "[kind isEqualToString:@\"…\"] with every grammar character", file: "packages/ardiacore/ios/ArdiaWebView+PageMessages.mm", code: '} else if ([kind isEqualToString:@"2fa.pick-done:x_y"]) {', missing: "chromium-page-message:2fa.pick-done:x_y" },
    { form: "a kind with a space fails", file: "packages/ardiacore/ios/ArdiaWebView+PageMessages.mm", code: '} else if ([kind isEqualToString:@"has space"]) {', outside: '"has space"' },
  ],
  "Swift (pattern)": [
    { form: 'a receiver case "…":', file: "packages/ardiacore/ios/WebKitTab+Site.swift", code: 'case "2fa-done": break', missing: "webkit-page-message:2fa-done" },
    { form: "a receiver kind with a space fails", file: "packages/ardiacore/ios/WebKitTab+Site.swift", code: 'case "has space": break', outside: '"has space"' },
    { form: "a WebKit post with a space fails", file: "packages/ardiacore/ios/WebKitPageScript.swift", code: "post('has space', {})", outside: '"has space"' },
    { form: "post or send with a quoted kind in a WebKit script", file: "packages/ardiacore/ios/WebKitPageScript.swift", code: "post('9fixture', {})", missing: "webkit-page-message:9fixture" },
    { form: "an addEventListener call in a WebKit script", file: "packages/ardiacore/ios/WebKitPageScript.swift", code: 'document.addEventListener("fixture", f)', changed: "webkit-page-listener-count:WebKitPageScript.swift" },
    { form: "apply through an alias a WebKit script assigns", file: "packages/ardiacore/ios/WebKitPageScript.swift", code: 'const hearFixture = EventTarget.prototype.addEventListener; apply(hearFixture, document, ["fixture", f])', changed: "webkit-page-listener-count:WebKitPageScript.swift" },
    { form: "apply through a listen alias in a WebKit script", file: "packages/ardiacore/ios/WebKitPageScript.swift", code: 'apply(listen, document, ["fixture", f])', changed: "webkit-page-listener-count:WebKitPageScript.swift" },
  ],
  "Other tables (pattern)": [
    { form: 'a plugin method case "…":', file: "apps/browser/src/state/plugins/channelApi.ts", code: 'switch (method) { case "tabs.read-all": break; }', missing: "plugin-method:tabs.read-all" },
  ],
};

for (const [group, forms] of Object.entries(PROMISED_FORMS))
  test(`${group}: each promised form raises a missing row or a changed count when it appears in new code`, () => {
    for (const { form, file, code, missing, changed, unchanged, outside } of forms) {
      const found = unlisted(detectedEntries(withAdded({ [file]: code })));
      if (unchanged) assert.ok(!found.changed.some((c) => c.startsWith(`${unchanged}:`)) && found.missing.length === 0, `${form}: expected nothing new, got ${JSON.stringify([...found.changed, ...found.missing])}`);
      if (outside) assert.ok(found.outside.some((o) => o.endsWith(`: ${outside}`)), `${form}: expected ${outside} to fail the grammar, got ${JSON.stringify(found.outside)}`);
      if (missing) assert.ok(found.missing.includes(missing), `${form}: expected ${missing} to be reported, got ${JSON.stringify(found.missing)}`);
      if (changed) assert.ok(found.changed.some((c) => c.startsWith(`${changed}:`)), `${form}: expected ${changed} to be reported as changed, got ${JSON.stringify(found.changed)}`);
    }
  });

const customEventsIn = (path, text) => (path.endsWith(".js") ? parsedListenerCalls(path, text).map((l) => l.name).filter(Boolean) : listenedEvents(text)).filter((event) => /[-:]|ardia/i.test(event) && !inventory.customEvents?.[event]);

test("no page script listens for a DOM event a page can name itself", () => {
  const scripts = [PAGE_SCRIPT, ...filesIn(IOS, (n) => /^WebKit.*\.swift$/.test(n))];
  for (const f of scripts) assert.deepEqual(customEventsIn(f, readFromDisk(f)), [], `${f}: a custom DOM event any page can dispatch needs a row in customEvents and a trusted-sender check`);
  assert.deepEqual(customEventsIn("fixture.js", 'const { addEventListener: hear } = EventTarget.prototype; document.addEventListener("ardia-hide-element", f); apply(hear, document, ["ardia-pick", f]);'), ["ardia-hide-element", "ardia-pick"]);
});
