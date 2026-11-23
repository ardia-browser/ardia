import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDomains, MANIFEST, outputs, ROOT, validate, validateTopics } from "./generate.mjs";

const GENERATOR = fileURLToPath(new URL("./generate.mjs", import.meta.url));
const runAt = (generator, ...args) => spawnSync(process.execPath, [generator, ...args], { encoding: "utf8" });
const run = (...args) => runAt(GENERATOR, ...args);
const call = (overrides = {}) => ({ args: "Profile", result: "Done", service: "ac_demo_watch", desktop: "route", ...overrides });
const domain = (calls) => ({ kind: "engine", imports: {}, calls, events: {} });

test("every generated file matches the schema byte for byte", async () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `up to date: ${outputs(await loadDomains()).size} files\n`);
});

test("the generator takes exactly one mode", () => {
  assert.equal(run().status, 2);
  assert.equal(run("--check", "--write").status, 2);
  assert.equal(run("--force").status, 2);
});

test("run through a symlinked path, the generator still runs, so a check can't pass by doing nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hostapi-link-"));
  try {
    const link = join(dir, "hostapi");
    symlinkSync(fileURLToPath(new URL(".", import.meta.url)), link, process.platform === "win32" ? "junction" : "dir");
    const linked = join(link, "generate.mjs");
    assert.equal(runAt(linked, "--force").status, 2);
    const result = runAt(linked, "--check");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^up to date: \d+ files\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git checks every generated file out with LF endings, so a CRLF checkout still matches byte for byte", async () => {
  const paths = [...outputs(await loadDomains()).keys()];
  const result = spawnSync("git", ["check-attr", "eol", "--", ...paths], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), paths.map((path) => `${path}: eol: lf`));
});

test("only engine domains are generated until positional module domains get their own call shape", () => {
  assert.doesNotThrow(() => validate("demo", domain({ watch: call() })));
  assert.throws(() => validate("demo", { ...domain({ watch: call() }), kind: "module" }), /kind is engine/);
  const { kind, ...unkinded } = domain({ watch: call() });
  assert.equal(kind, "engine");
  assert.throws(() => validate("demo", unkinded), /kind is engine/);
});

test("two runs give the same bytes, so the check never flaps", async () => {
  const once = outputs(await loadDomains());
  const twice = outputs(await loadDomains());
  assert.deepEqual([...once], [...twice]);
});

test("the manifest lists every schema call with its service and each host's binding", async () => {
  const domains = await loadDomains();
  const manifest = JSON.parse(readFileSync(ROOT + MANIFEST, "utf8"));
  assert.deepEqual(Object.keys(manifest.domains), Object.keys(domains));
  for (const [name, schema] of Object.entries(domains)) {
    const listed = manifest.domains[name];
    assert.deepEqual(Object.keys(listed.calls), Object.keys(schema.calls));
    assert.deepEqual(Object.keys(listed.events), Object.keys(schema.events));
    for (const [verb, row] of Object.entries(schema.calls)) {
      assert.equal(listed.calls[verb].service, row.service);
      assert.equal(listed.calls[verb].desktop, row.desktop);
      assert.equal(listed.calls[verb].mac, row.mac ?? "service");
      assert.equal(listed.calls[verb].windows, row.windows ?? "service");
      assert.equal(listed.calls[verb].routeField, row.routeField);
    }
    for (const [event, row] of Object.entries(schema.events)) {
      assert.deepEqual(listed.events[event], { topic: row.topic ?? `${name}.${event}`, mac: row.mac ?? "forward", desktop: row.desktop, windows: row.windows ?? "forward" });
    }
  }
});

test("a call that doesn't say whether the desktop host routes it is refused, never routed by default", () => {
  const { desktop, ...unsaid } = call();
  assert.equal(desktop, "route");
  assert.throws(() => validate("demo", domain({ watch: unsaid })), /never implied/);
  for (const binding of ["route", "custom", "absent"]) assert.doesNotThrow(() => validate("demo", domain({ watch: call({ desktop: binding }) })));
  assert.throws(() => validate("demo", domain({ watch: call({ desktop: "service" }) })), /desktop is one of/);
});

test("names, services and bindings outside the schema's forms are refused", () => {
  assert.throws(() => validate("Demo", domain({})), /lowerCamelCase/);
  assert.throws(() => validate("demo", domain({ "watch-all": call() })), /lowerCamelCase/);
  assert.throws(() => validate("demo", domain({ watch: call({ service: "demo_watch" }) })), /ac_\* call/);
  assert.throws(() => validate("demo", domain({ watch: call({ mac: "route" }) })), /mac is one of/);
  assert.throws(() => validate("demo", domain({ watch: call({ args: "" }) })), /args type/);
  assert.throws(() => validate("demo", { kind: "engine", imports: { "@ardia/core": ["Thing"] }, calls: {}, events: {} }), /relative/);
});

test("a domain the Mac serves straight from the engine gets its whole Swift module, and a mixed one a call table its module fills with its own handlers", () => {
  const files = outputs({
    demo: domain({ watch: call() }),
    mixed: domain({ watch: call({ service: "ac_mixed_watch" }), open: call({ mac: "custom", service: "ac_mixed_open" }), import: call({ mac: "custom", service: undefined, desktop: "custom", windows: "custom" }), probe: call({ mac: "absent", service: "ac_mixed_probe" }) }),
  });
  assert.equal(files.get("packages/ardiacore/ios/DemoModule.swift").includes('"watch": EngineCall.passing("ac_demo_watch"),'), true);
  assert.equal(files.get("packages/ardiacore/ios/DemoModule.swift").includes("Events("), false);
  assert.equal(files.has("packages/ardiacore/ios/MixedModule.swift"), false);
  assert.equal(
    files.get("packages/ardiacore/ios/MixedCalls.swift"),
    [
      "import ExpoModulesCore",
      "",
      "func mixedCallTable(open openHandler: @escaping CallHandler, import importHandler: @escaping CallHandler) -> CallTable {",
      '  CallTable(domain: "mixed", handlers: [',
      '    "watch": EngineCall.passing("ac_mixed_watch"),',
      '    "open": openHandler,',
      '    "import": importHandler,',
      "  ])",
      "}",
      "",
    ].join("\n"),
  );
  const manifest = JSON.parse(files.get(MANIFEST)).domains;
  assert.equal(manifest.demo.swift, "packages/ardiacore/ios/DemoModule.swift");
  assert.equal(manifest.mixed.swift, "packages/ardiacore/ios/MixedCalls.swift");
  assert.equal("service" in manifest.mixed.calls.import, false);
});

test("the generated Swift parses, with an empty table written as [:] and verbs Swift won't take as a bare label escaped", () => {
  const files = outputs({
    quiet: domain({ probe: call({ mac: "absent", service: "ac_quiet_probe" }), keep: call({ mac: "custom", service: "ac_quiet_keep" }) }),
    hollow: domain({ probe: call({ mac: "absent", service: "ac_hollow_probe" }) }),
    empty: domain({}),
    words: domain({ inout: call({ mac: "custom", service: "ac_words_inout" }), var: call({ mac: "custom", service: "ac_words_var" }), let: call({ mac: "custom", service: "ac_words_let" }), import: call({ mac: "custom", service: "ac_words_import" }) }),
  });
  assert.match(files.get("packages/ardiacore/ios/HollowCalls.swift"), /func hollowCallTable\(\) -> CallTable \{\n {2}CallTable\(domain: "hollow", handlers: \[:\]\)\n\}/);
  assert.match(files.get("packages/ardiacore/ios/EmptyModule.swift"), /static let calls = CallTable\(domain: "empty", handlers: \[:\]\)/);
  assert.match(files.get("packages/ardiacore/ios/WordsCalls.swift"), /\(`inout` inoutHandler: @escaping CallHandler, `var` varHandler: @escaping CallHandler, `let` letHandler: @escaping CallHandler, import importHandler: @escaping CallHandler\)/);
  const swiftc = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (swiftc.status !== 0) return;
  const dir = mkdtempSync(join(tmpdir(), "hostapi-swift-"));
  try {
    const stubs = join(dir, "Stubs.swift");
    writeFileSync(stubs, [
      "typealias CallHandler = (String, String) -> Void",
      "enum EngineCall { static func passing(_ name: String) -> CallHandler { { _, _ in } } }",
      "struct CallTable { let domain: String; let handlers: [String: CallHandler]; var function: Int { 0 } }",
      "struct Module {}",
      "",
    ].join("\n"));
    const sources = [...files].filter(([path]) => path.endsWith(".swift")).map(([path, text]) => {
      const at = join(dir, path.split("/").at(-1));
      writeFileSync(at, text.replace("import ExpoModulesCore\n", ""));
      return at;
    });
    const parsed = spawnSync("swiftc", ["-parse", stubs, ...sources], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call may leave out its service only when every host serves it with its own code", () => {
  const custom = { mac: "custom", desktop: "custom", windows: "custom", service: undefined };
  assert.doesNotThrow(() => validate("demo", domain({ fetch: call(custom) })));
  for (const passing of [{ mac: "service" }, { desktop: "route" }, { windows: "service" }]) {
    assert.throws(() => validate("demo", domain({ fetch: call({ ...custom, ...passing }) })), /passes it straight/, JSON.stringify(passing));
  }
  const { mac, ...macDefault } = custom;
  assert.equal(mac, "custom");
  assert.throws(() => validate("demo", domain({ fetch: call(macDefault) })), /passes it straight/);
  assert.doesNotThrow(() => validate("demo", domain({ fetch: call({ ...custom, mac: "absent" }) })));
});

const event = (overrides = {}) => ({ payload: "{ profile: string }", desktop: "forward", ...overrides });
const withEvents = (events) => ({ kind: "engine", imports: {}, calls: {}, events });

test("a desktop route may answer with one field of the engine's reply, or null, and only a route may say so", () => {
  for (const routeField of ["null", "components"]) assert.doesNotThrow(() => validate("demo", domain({ watch: call({ routeField }) })));
  assert.throws(() => validate("demo", domain({ watch: call({ routeField: "components", desktop: "custom" }) })), /goes only with desktop: route/);
  assert.throws(() => validate("demo", domain({ watch: call({ routeField: "Components" }) })), /lowerCamelCase field/);
  assert.throws(() => validate("demo", domain({ watch: call({ routeField: "" }) })), /lowerCamelCase field/);
  for (const routeField of [null, ["components"], 0, true]) {
    assert.throws(() => validate("demo", domain({ watch: call({ routeField }) })), /routeField is a string: .* or "null" to answer null/, JSON.stringify(routeField));
  }
  const manifest = JSON.parse(outputs({ demo: domain({ watch: call(), tasks: call({ service: "ac_tasks_list", routeField: "tasks" }) }) }).get(MANIFEST)).domains.demo;
  assert.equal("routeField" in manifest.calls.watch, false);
  assert.equal(manifest.calls.tasks.routeField, "tasks");
});

test("an event says whether the desktop host forwards it, never by default, and the Mac and Windows forward it unless they say otherwise", () => {
  assert.doesNotThrow(() => validate("demo", withEvents({ changed: event() })));
  for (const desktop of ["forward", "custom", "absent"]) assert.doesNotThrow(() => validate("demo", withEvents({ changed: event({ desktop }) })));
  const { desktop, ...unsaid } = event();
  assert.equal(desktop, "forward");
  assert.throws(() => validate("demo", withEvents({ changed: unsaid })), /never implied/);
  assert.throws(() => validate("demo", withEvents({ changed: "{ profile: string }" })), /is \{ payload, desktop \}/);
  assert.throws(() => validate("demo", withEvents({ changed: event({ payload: " " }) })), /payload type/);
  assert.throws(() => validate("demo", withEvents({ changed: event({ mac: "service" }) })), /mac is one of forward, custom, absent/);
  assert.throws(() => validate("demo", withEvents({ changed: event({ windows: "route" }) })), /windows is one of/);
  const manifest = JSON.parse(outputs({ demo: withEvents({ changed: event({ mac: "custom" }) }) }).get(MANIFEST)).domains.demo;
  assert.deepEqual(manifest.events, { changed: { topic: "demo.changed", mac: "custom", desktop: "forward", windows: "forward" } });
  assert.equal(outputs({ demo: withEvents({ changed: event() }) }).get("packages/ardiacore/src/engine/generated/demo.ts").includes('"demo.changed": { profile: string };'), true);
});

test("an event renamed from its engine topic names the topic only when it differs, and only for hosts that forward it, never the desktop host", () => {
  assert.doesNotThrow(() => validate("demo", withEvents({ changed: event({ topic: "demoChanged", desktop: "custom" }) })));
  assert.throws(() => validate("demo", withEvents({ changed: event({ topic: "demo.changed", desktop: "custom" }) })), /leaves out topic/);
  assert.throws(() => validate("demo", withEvents({ changed: event({ topic: "demoChanged" }) })), /only under its own name/);
  assert.throws(() => validate("demo", withEvents({ changed: event({ topic: "demoChanged", desktop: "custom", mac: "custom", windows: "absent" }) })), /only for a host that forwards it/);
  assert.throws(() => validate("demo", withEvents({ changed: event({ topic: "demo changed", desktop: "custom" }) })), /engine topic/);
  const manifest = JSON.parse(outputs({ demo: withEvents({ changed: event({ topic: "demoChanged", desktop: "custom" }) }) }).get(MANIFEST)).domains.demo;
  assert.equal(manifest.events.changed.topic, "demoChanged");
});

test("a host forwards each engine topic as one event, so two events never claim the same topic", () => {
  const renamed = event({ topic: "cliControl", desktop: "custom" });
  assert.doesNotThrow(() => validateTopics({ engine: withEvents({ cliControl: renamed, systemState: event({ desktop: "custom", windows: "custom" }) }) }));
  assert.throws(() => validateTopics({ engine: withEvents({ cliControl: renamed, systemState: event({ topic: "cliControl", desktop: "custom", mac: "custom" }) }) }), /both take engine topic cliControl on windows/);
  assert.doesNotThrow(() => validateTopics({ engine: withEvents({ cliControl: renamed, systemState: event({ topic: "cliControl", desktop: "custom", mac: "custom", windows: "custom" }) }) }));
  assert.throws(() => validateTopics({ demo: withEvents({ changed: event() }), other: withEvents({ changed: event({ topic: "demo.changed", desktop: "custom" }) }) }), /both take engine topic demo\.changed on mac/);
});
