import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { clientPackages, loadDomains, loadModuleDomains, MANIFEST, outputs, ROOT, validate, validateModuleDomain, validateModuleNames, validateTopics } from "./generate.mjs";

const GENERATOR = fileURLToPath(new URL("./generate.mjs", import.meta.url));
const runAt = (generator, ...args) => spawnSync(process.execPath, [generator, ...args], { encoding: "utf8" });
const run = (...args) => runAt(GENERATOR, ...args);
const fn = (overrides = {}) => ({ args: [["on", "boolean"]], result: "void", async: true, mac: "custom", desktop: "absent", windows: "absent", ...overrides });
const moduleDomain = (modules = { ArdiaDemo: { functions: { hold: fn() }, events: {} } }, overrides = {}) => ({ kind: "module", package: "packages/shaders", imports: {}, types: {}, modules, ...overrides });
const call = (overrides = {}) => ({ args: "Profile", result: "Done", service: "ac_demo_watch", desktop: "route", ...overrides });
const domain = (calls) => ({ kind: "engine", imports: {}, calls, events: {} });

test("every generated file matches the schema byte for byte", async () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `up to date: ${outputs(await loadDomains(), await loadModuleDomains()).size} files\n`);
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
  const paths = [...outputs(await loadDomains(), await loadModuleDomains()).keys()];
  const result = spawnSync("git", ["check-attr", "eol", "--", ...paths], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), paths.map((path) => `${path}: eol: lf`));
});

test("engine domains and module domains each keep to their own list and kind", () => {
  assert.doesNotThrow(() => validate("demo", domain({ watch: call() })));
  assert.throws(() => validate("demo", { ...domain({ watch: call() }), kind: "module" }), /kind is engine: .* listed in moduleDomains/);
  const { kind, ...unkinded } = domain({ watch: call() });
  assert.equal(kind, "engine");
  assert.throws(() => validate("demo", unkinded), /kind is engine/);
  assert.doesNotThrow(() => validateModuleDomain("demo", moduleDomain()));
  assert.throws(() => validateModuleDomain("demo", { ...moduleDomain(), kind: "engine" }), /kind is module/);
});

test("two runs give the same bytes, so the check never flaps", async () => {
  const once = outputs(await loadDomains(), await loadModuleDomains());
  const twice = outputs(await loadDomains(), await loadModuleDomains());
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
  assert.throws(() => validate("demo", { kind: "engine", imports: { "@ardia/elsewhere": ["Thing"] }, calls: {}, events: {} }), /relative to the generated folder, or a package packages\/ardiacore\/package\.json depends on/);
  assert.throws(() => validate("demo", { kind: "engine", imports: { "generated": ["Thing"] }, calls: {}, events: {} }), /or a package/);
  assert.throws(() => validate("demo", { kind: "engine", imports: { ".hidden": ["Thing"] }, calls: {}, events: {} }), /or a package/);
});

test("a type may come from a package the generated client's package depends on, imported ahead of the relative paths", () => {
  assert.ok(clientPackages.has("@ardia/core"));
  const imports = { "../wire": ["Profile"], "@ardia/core": ["CleanedUrl"], "../../webkit": ["PageCookie"] };
  assert.doesNotThrow(() => validate("demo", { kind: "engine", imports, calls: {}, events: {} }));
  const types = outputs({ demo: { kind: "engine", imports, calls: { copy: call({ args: "Profile & { url: CleanedUrl; cookies: PageCookie[] }" }) }, events: {} } }).get("packages/ardiacore/src/engine/generated/demo.ts");
  assert.equal(types.split("\n").slice(0, 4).join("\n"), [
    'import type { CleanedUrl } from "@ardia/core";',
    'import type { PageCookie } from "../../webkit";',
    'import type { Profile } from "../wire";',
    "",
  ].join("\n"));
});

test("a domain no host passes any call of straight to the engine gets a call table of handlers only", () => {
  const custom = { mac: "custom", desktop: "absent", windows: "absent", service: undefined };
  const files = outputs({ quiet: domain({ list: call(custom), dev: call({ ...custom, desktop: "custom" }) }) });
  assert.equal(files.has("packages/ardiacore/ios/QuietModule.swift"), false);
  assert.equal(files.get("packages/ardiacore/ios/QuietCalls.swift"), [
    "import ExpoModulesCore",
    "",
    "func quietCallTable(list listHandler: @escaping CallHandler, dev devHandler: @escaping CallHandler) -> CallTable {",
    '  CallTable(domain: "quiet", handlers: [',
    '    "list": listHandler,',
    '    "dev": devHandler,',
    "  ])",
    "}",
    "",
  ].join("\n"));
  const manifest = JSON.parse(files.get(MANIFEST)).domains.quiet;
  assert.deepEqual(manifest.calls.list, { mac: "custom", desktop: "absent", windows: "absent" });
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

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const richModules = () =>
  moduleDomain(
    {
      ArdiaDemo: {
        functions: {
          hold: fn({ queue: "main" }),
          snapshot: fn({ args: [["dir", "string"], ["scale", "number"]], result: "Snapshot[]", swiftResult: "[[String: Any]]", queue: "main" }),
          size: fn({ args: [], result: "number", async: false }),
          evaluate: fn({ args: [["script", "string"], ["tones", "string[]", "[String]"]], result: "unknown", promise: true }),
          webOnly: fn({ mac: "absent", desktop: "custom" }),
        },
        events: { tone: { payload: "Tone", mac: "custom", desktop: "absent", windows: "absent" } },
      },
      ArdiaQuiet: { functions: { probe: fn({ mac: "absent" }) }, events: {} },
    },
    { imports: { "@ardia/core": ["ThemeTexture"], "../meadowPage/config": ["Tone"] }, types: { Snapshot: "{ file: string; texture: ThemeTexture }" } },
  );

test("a module domain's TypeScript gives each Expo module a *Native type with its functions' positional args and results, and the domain a map of them", () => {
  const files = outputs({}, { demo: richModules() });
  assert.equal(files.get("packages/shaders/src/generated/native.ts"), [
    'import type { ThemeTexture } from "@ardia/core";',
    'import type { Tone } from "../meadowPage/config";',
    "",
    "export type Snapshot = { file: string; texture: ThemeTexture };",
    "",
    "export type DemoNative = {",
    "  hold(on: boolean): Promise<void>;",
    "  snapshot(dir: string, scale: number): Promise<Snapshot[]>;",
    "  size(): number;",
    "  evaluate(script: string, tones: string[]): Promise<unknown>;",
    "  webOnly(on: boolean): Promise<void>;",
    "};",
    "",
    "export type DemoNativeEvents = {",
    "  tone: Tone;",
    "};",
    "",
    "export type QuietNative = {",
    "  probe(on: boolean): Promise<void>;",
    "};",
    "",
    "export type DemoModules = {",
    "  ArdiaDemo: DemoNative;",
    "  ArdiaQuiet: QuietNative;",
    "};",
    "",
  ].join("\n"));
});

test("a module domain's Swift gives each Mac module a protocol of its custom functions and the Expo definitions that call them, and leaves out what the Mac doesn't serve", () => {
  const files = outputs({}, { demo: richModules() });
  assert.equal(files.get("packages/shaders/ios/DemoNative.swift"), [
    "import ExpoModulesCore",
    "",
    "protocol DemoNative {",
    "  static func hold(_ on: Bool)",
    "  static func snapshot(_ dir: String, _ scale: Double) -> [[String: Any]]",
    "  static func size() -> Double",
    "  static func evaluate(_ script: String, _ tones: [String], _ promise: Promise)",
    "}",
    "",
    "extension DemoNative {",
    '  static var moduleName: String { "ArdiaDemo" }',
    "",
    "  static var eventsDefinition: AnyDefinition {",
    '    Events("tone")',
    "  }",
    "",
    "  static var holdFunction: AnyDefinition {",
    '    AsyncFunction("hold") { (on: Bool) in Self.hold(on) }.runOnQueue(.main)',
    "  }",
    "",
    "  static var snapshotFunction: AnyDefinition {",
    '    AsyncFunction("snapshot") { (dir: String, scale: Double) -> [[String: Any]] in Self.snapshot(dir, scale) }.runOnQueue(.main)',
    "  }",
    "",
    "  static var sizeFunction: AnyDefinition {",
    '    Function("size") { () -> Double in Self.size() }',
    "  }",
    "",
    "  static var evaluateFunction: AnyDefinition {",
    '    AsyncFunction("evaluate") { (script: String, tones: [String], promise: Promise) in Self.evaluate(script, tones, promise) }',
    "  }",
    "}",
    "",
    "extension DemoNative where Self: Module {",
    '  func sendTone(_ payload: [String: Any?]) { sendEvent("tone", payload) }',
    "}",
    "",
  ].join("\n"));
  const nothingOnMac = outputs({}, { demo: moduleDomain({ ArdiaQuiet: { functions: { probe: fn({ mac: "absent" }) }, events: {} } }) });
  assert.equal([...nothingOnMac.keys()].some((path) => path.endsWith(".swift")), false);
  assert.equal(JSON.parse(nothingOnMac.get(MANIFEST)).modules.demo.swift, null);
  assert.deepEqual(Object.keys(JSON.parse(nothingOnMac.get(MANIFEST)).modules.demo.sha256), ["types"]);
});

test("the manifest lists each module domain's functions and events with every host's binding, after the engine domains, which it leaves as they were", () => {
  const engine = { demo: domain({ watch: call() }) };
  const alone = JSON.parse(outputs(engine).get(MANIFEST));
  const files = outputs(engine, { shaded: richModules() });
  const manifest = JSON.parse(files.get(MANIFEST));
  assert.deepEqual(manifest.domains, alone.domains);
  assert.ok(files.get(MANIFEST).startsWith(outputs(engine).get(MANIFEST).replace(/\n {2}"modules": \{\}\n\}\n$/, "")));
  assert.deepEqual(manifest.modules.shaded, {
    kind: "module",
    package: "packages/shaders",
    types: "packages/shaders/src/generated/native.ts",
    swift: "packages/shaders/ios/ShadedNative.swift",
    sha256: { types: sha256(files.get("packages/shaders/src/generated/native.ts")), swift: sha256(files.get("packages/shaders/ios/ShadedNative.swift")) },
    modules: {
      ArdiaDemo: {
        native: "DemoNative",
        functions: {
          hold: { args: ["on"], async: true, mac: "custom", desktop: "absent", windows: "absent" },
          snapshot: { args: ["dir", "scale"], async: true, mac: "custom", desktop: "absent", windows: "absent" },
          size: { args: [], async: false, mac: "custom", desktop: "absent", windows: "absent" },
          evaluate: { args: ["script", "tones"], async: true, mac: "custom", desktop: "absent", windows: "absent" },
          webOnly: { args: ["on"], async: true, mac: "absent", desktop: "custom", windows: "absent" },
        },
        events: { tone: { mac: "custom", desktop: "absent", windows: "absent" } },
      },
      ArdiaQuiet: { native: "QuietNative", functions: { probe: { args: ["on"], async: true, mac: "absent", desktop: "absent", windows: "absent" } }, events: {} },
    },
  });
});

test("the real manifest lists every module domain function and event of the schema with each host's binding", async () => {
  const schema = await loadModuleDomains();
  const manifest = JSON.parse(readFileSync(ROOT + MANIFEST, "utf8"));
  assert.deepEqual(Object.keys(manifest.modules), Object.keys(schema));
  for (const [name, entry] of Object.entries(schema)) {
    for (const [module, row] of Object.entries(entry.modules)) {
      const listed = manifest.modules[name].modules[module];
      assert.deepEqual(Object.keys(listed.functions), Object.keys(row.functions));
      for (const [fn, binding] of Object.entries(row.functions)) {
        assert.deepEqual(listed.functions[fn], { args: binding.args.map(([param]) => param), async: binding.async, mac: binding.mac, desktop: binding.desktop, windows: binding.windows });
      }
      assert.deepEqual(Object.keys(listed.events), Object.keys(row.events));
    }
  }
});

test("a module function's or event's bindings are never implied, and args, results, queues and promises keep to forms both languages take", () => {
  const refused = (overrides, pattern) => assert.throws(() => validateModuleDomain("demo", moduleDomain({ ArdiaDemo: { functions: { hold: fn(overrides) }, events: {} } })), pattern, JSON.stringify(overrides));
  for (const host of ["mac", "desktop", "windows"]) refused({ [host]: undefined }, /never implied/);
  refused({ mac: "service" }, /mac is one of custom, absent/);
  refused({ windows: "host" }, /windows is one of custom, absent/);
  assert.doesNotThrow(() => validateModuleDomain("demo", moduleDomain({ ArdiaDemo: { functions: { hold: fn({ desktop: "host" }) }, events: {} } })));
  refused({ args: "on: boolean" }, /positional args/);
  refused({ args: [["on"]] }, /\[name, type\]/);
  refused({ args: [["On", "boolean"]] }, /lowerCamelCase name/);
  refused({ args: [["in", "boolean"]] }, /neither TypeScript nor Swift reserves/);
  refused({ args: [["promise", "boolean"]] }, /neither TypeScript nor Swift reserves/);
  refused({ args: [["on", "boolean"], ["on", "string"]] }, /twice/);
  refused({ args: [["on", "void"]] }, /has a type/);
  refused({ args: [["tone", "Tone"]] }, /says its Swift type/);
  refused({ result: "Snapshot" }, /says its swiftResult/);
  refused({ result: "" }, /names its result type/);
  refused({ async: undefined }, /whether it's async/);
  refused({ async: false, promise: true }, /resolves a Promise itself, so it's async/);
  refused({ promise: true, result: "unknown", swiftResult: "Any" }, /has no swiftResult/);
  refused({ async: false, queue: "main" }, /only when it's async/);
  refused({ queue: "background" }, /queue is main/);
  assert.doesNotThrow(() => validateModuleDomain("demo", moduleDomain({ ArdiaDemo: { functions: { hold: fn({ args: [["tone", "Tone", "[String: Any]"]], result: "unknown", promise: true }) }, events: {} } })));
  const event = (overrides) => moduleDomain({ ArdiaDemo: { functions: {}, events: { tone: { payload: "Tone", mac: "custom", desktop: "absent", windows: "absent", ...overrides } } } });
  assert.doesNotThrow(() => validateModuleDomain("demo", event({})));
  assert.throws(() => validateModuleDomain("demo", event({ desktop: undefined })), /never implied/);
  assert.throws(() => validateModuleDomain("demo", event({ payload: " " })), /payload type/);
});

test("a module domain names a real package, Expo modules by their Ardia names, types it may import, and no name twice", () => {
  assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { package: "apps/browser" })), /packages\/<name>/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { package: "packages/nowhere" })), /no package\.json/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain({})), /at least one Expo module/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain({ Demo: { functions: {}, events: {} } })), /Ardia followed by UpperCamelCase/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain({ ArdiaDemo: { functions: {} } })), /\{ functions, events \}/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { imports: { "@ardia/shell": ["Thing"] } })), /packages\/shaders\/package\.json depends on/);
  assert.doesNotThrow(() => validateModuleDomain("demo", moduleDomain(undefined, { imports: { "@ardia/core": ["ThemeTexture"], "../meadowPage/config": ["Tone"] } })));
  assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { types: { DemoNative: "{}" } })), /declared twice/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { types: { DemoModules: "{}" } })), /declared twice/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { imports: { "@ardia/core": ["Thing"] }, types: { Thing: "{}" } })), /declared twice/);
  assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { types: { thing: "{}" } })), /is a type name/);
  assert.throws(() => validateModuleNames({ history: domain({}) }, { demo: moduleDomain({ ArdiaHistory: { functions: {}, events: {} } }) }), /engine domain history's module/);
  assert.throws(() => validateModuleNames({ demo: domain({}) }, { demo: moduleDomain() }), /an engine domain already has the name/);
  assert.throws(() => validateModuleNames({}, { one: moduleDomain(), two: moduleDomain(undefined, { package: "packages/shell" }) }), /already in module domain one/);
  assert.throws(() => validateModuleNames({}, { one: moduleDomain(), two: moduleDomain({ ArdiaOther: { functions: {}, events: {} } }) }), /already holds module domain one/);
});

const SWIFT_EXPO_STUBS = [
  "protocol AnyDefinition {}",
  "enum Queue { case main }",
  "struct Definition: AnyDefinition { func runOnQueue(_ queue: Queue) -> Definition { self } }",
  "final class Promise { func resolve(_ value: Any?) {} }",
  "class Module { func sendEvent(_ name: String, _ body: [String: Any?] = [:]) {} }",
  "func Events(_ names: String...) -> Definition { Definition() }",
  "func AsyncFunction<R>(_ name: String, _ body: @escaping () throws -> R) -> Definition { Definition() }",
  "func AsyncFunction<R, A0, each A>(_ name: String, _ body: @escaping (A0, repeat each A) throws -> R) -> Definition { Definition() }",
  "func Function<R>(_ name: String, _ body: @escaping () throws -> R) -> Definition { Definition() }",
  "func Function<R, A0, each A>(_ name: String, _ body: @escaping (A0, repeat each A) throws -> R) -> Definition { Definition() }",
  "",
].join("\n");

const conformers = (swift) =>
  [...swift.matchAll(/^protocol (\w+) \{\n((?: {2}static func .*\n)*)\}$/gm)]
    .map(([, protocol, requirements]) => [
      `final class ${protocol}Conformer: Module, ${protocol} {`,
      ...requirements.trimEnd().split("\n").filter(Boolean).map((line) => `${line} { fatalError() }`),
      "  func definitions() -> [AnyDefinition] { [Self.eventsDefinitionIfAny] }",
      "}",
    ].join("\n"))
    .join("\n");

test("the generated module Swift typechecks against Expo's shapes, and a module with the schema's signatures conforms to it", async () => {
  const swiftc = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (swiftc.status !== 0) return;
  const real = outputs(await loadDomains(), await loadModuleDomains());
  const sources = [
    ...[...real].filter(([path]) => path.endsWith("Native.swift")),
    ["packages/shaders/ios/DemoNative.swift", outputs({}, { demo: richModules() }).get("packages/shaders/ios/DemoNative.swift")],
  ];
  assert.ok(sources.length >= 2, "the real schema has a module domain with Swift");
  const dir = mkdtempSync(join(tmpdir(), "hostapi-module-swift-"));
  try {
    const files = sources.map(([path, text], index) => {
      const at = join(dir, `${index}-${path.split("/").at(-1)}`);
      const body = text.replace("import ExpoModulesCore\n", "");
      const hasEvents = (protocol) => body.includes(`extension ${protocol} where Self: Module`);
      const shims = [...body.matchAll(/^protocol (\w+)/gm)].map(([, protocol]) => `extension ${protocol} { static var eventsDefinitionIfAny: AnyDefinition { ${hasEvents(protocol) ? "eventsDefinition" : "Definition()"} } }`).join("\n");
      writeFileSync(at, `${body}\n${shims}\n${conformers(body)}\n`);
      return at;
    });
    const stubs = join(dir, "Expo.swift");
    writeFileSync(stubs, SWIFT_EXPO_STUBS);
    const checked = spawnSync("swiftc", ["-typecheck", stubs, ...files], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    const drifted = join(dir, "Drifted.swift");
    writeFileSync(drifted, `${readFileSync(files.at(-1), "utf8").replace("static func hold(_ on: Bool) { fatalError() }", "static func hold(_ on: String) { fatalError() }")}`);
    const refused = spawnSync("swiftc", ["-typecheck", stubs, drifted], { encoding: "utf8" });
    assert.notEqual(refused.status, 0, "a module whose signature drifts from the schema doesn't compile");
    assert.match(refused.stderr, /does not conform to protocol 'DemoNative'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a module function named after a Swift keyword is declared and called with backticks, and still typechecks", () => {
  const keywords = ["import", "default", "self", "init", "delete", "in"];
  const files = outputs({}, { demo: moduleDomain({ ArdiaDemo: { functions: Object.fromEntries(keywords.map((name) => [name, fn({ args: [], result: "number", async: name !== "delete" })])), events: {} } }) });
  const swift = files.get("packages/shaders/ios/DemoNative.swift");
  assert.ok(swift.includes("  static func `import`() -> Double"));
  assert.ok(swift.includes('    AsyncFunction("import") { () -> Double in Self.`import`() }'));
  assert.ok(swift.includes("  static func delete() -> Double"));
  assert.ok(swift.includes('    Function("delete") { () -> Double in Self.delete() }'));
  assert.ok(swift.includes("  static var importFunction: AnyDefinition {"));
  assert.ok(files.get("packages/shaders/src/generated/native.ts").includes("  import(): Promise<number>;"));
  const swiftc = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (swiftc.status !== 0) return;
  const dir = mkdtempSync(join(tmpdir(), "hostapi-keyword-swift-"));
  try {
    const stubs = join(dir, "Expo.swift");
    writeFileSync(stubs, SWIFT_EXPO_STUBS);
    const body = swift.replace("import ExpoModulesCore\n", "");
    const at = join(dir, "DemoNative.swift");
    writeFileSync(at, `${body}\nextension DemoNative { static var eventsDefinitionIfAny: AnyDefinition { Definition() } }\n${conformers(body)}\n`);
    const checked = spawnSync("swiftc", ["-typecheck", stubs, at], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--write deletes or overwrites a module domain's file only when it still holds what the generator wrote, so a hand-written replacement is never lost", () => {
  const dir = mkdtempSync(join(tmpdir(), "hostapi-ownership-"));
  try {
    const copy = (path) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      cpSync(ROOT + path, join(dir, path), { recursive: true });
    };
    for (const path of ["packages/hostapi/generate.mjs", "packages/hostapi/define.ts", "packages/hostapi/schema", "packages/ardiacore/package.json", "packages/shaders/package.json"]) copy(path);
    const generator = join(dir, "packages/hostapi/generate.mjs");
    const at = (path) => join(dir, path);
    const write = () => runAt(generator, "--write");
    const swift = "packages/shaders/ios/ShadersNative.swift";
    const types = "packages/shaders/src/generated/native.ts";
    assert.equal(write().status, 0);
    assert.equal(runAt(generator, "--check").status, 0);
    const index = at("packages/hostapi/schema/index.ts");
    const withShaders = readFileSync(index, "utf8");
    const withoutShaders = withShaders.replace("export const moduleDomains = { shaders };", "export const moduleDomains = {};");
    assert.notEqual(withoutShaders, withShaders);

    writeFileSync(at(swift), "import ExpoModulesCore\n\nprotocol AreaLightNative {}\n");
    const refused = write();
    assert.equal(refused.status, 1, "a hand-edited generated file isn't overwritten");
    assert.match(refused.stderr, /would overwrite a file the generator didn't write: packages\/shaders\/ios\/ShadersNative\.swift/);
    assert.equal(readFileSync(at(swift), "utf8"), "import ExpoModulesCore\n\nprotocol AreaLightNative {}\n");

    rmSync(at(swift));
    assert.equal(write().status, 0);
    writeFileSync(index, withoutShaders);
    writeFileSync(at(swift), "import ExpoModulesCore\n\nprotocol HandWritten {}\n");
    const retiring = write();
    assert.equal(retiring.status, 0, retiring.stderr);
    assert.equal(readFileSync(at(swift), "utf8"), "import ExpoModulesCore\n\nprotocol HandWritten {}\n", "the hand-written replacement survives the domain's removal");
    assert.equal(existsSync(at(types)), false, "the untouched generated TypeScript is retired");
    assert.deepEqual(JSON.parse(readFileSync(at(MANIFEST), "utf8")).modules, {});

    rmSync(at(swift));
    writeFileSync(index, withShaders);
    assert.equal(write().status, 0);
    writeFileSync(index, withoutShaders);
    assert.equal(write().status, 0);
    assert.equal(existsSync(at(swift)), false, "an untouched generated Swift file is retired with its domain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a module whose functions or events would generate the same Swift member twice, or Expo's own, is refused", () => {
  const refused = (functions, events, pattern) => assert.throws(() => validateModuleDomain("demo", moduleDomain({ ArdiaDemo: { functions, events } })), pattern);
  refused({ hold: fn(), holdFunction: fn() }, {}, /function ArdiaDemo\.holdFunction generates the Swift member holdFunction, which function ArdiaDemo\.hold already generates/);
  refused({ holdFunction: fn(), hold: fn() }, {}, /function ArdiaDemo\.hold generates the Swift member holdFunction, which function ArdiaDemo\.holdFunction already generates/);
  refused({ moduleName: fn() }, {}, /Swift member moduleName, which the module's name already generates/);
  refused({ eventsDefinition: fn() }, {}, /Swift member eventsDefinition, which the module's events already generates/);
  refused({}, { event: { payload: "Tone", mac: "custom", desktop: "absent", windows: "absent" } }, /Expo's own Module\.sendEvent/);
  assert.doesNotThrow(() => validateModuleDomain("demo", moduleDomain({ ArdiaDemo: { functions: { hold: fn(), holdKey: fn(), moduleNames: fn() }, events: { tone: { payload: "Tone", mac: "custom", desktop: "absent", windows: "absent" } } } })));
});

test("a module domain's type or import may not shadow a TypeScript global the generated types use, such as an async function's Promise", () => {
  for (const name of ["Promise", "Record", "Array"]) {
    assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { types: { [name]: "{ then(): void }" } })), new RegExp(`type ${name} would shadow TypeScript's own ${name}`));
    assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { imports: { "@ardia/core": [name] } })), new RegExp(`import ${name} would shadow`));
  }
  assert.doesNotThrow(() => validateModuleDomain("demo", moduleDomain(undefined, { types: { PromiseResult: "{ ok: boolean }" } })));
});

test("a relative import is a plain path, so the generated import line is always valid TypeScript", () => {
  for (const path of ['../foo"bar', "../foo\\bar", "../foo bar", "../foo\nbar", "./", "../", ".//foo", "../foo/", "./foo//bar", "../foo\u0000"]) {
    assert.throws(() => validateModuleDomain("demo", moduleDomain(undefined, { imports: { [path]: ["Thing"] } })), /is a relative path of letters, digits, dots, dashes, underscores and slashes/, JSON.stringify(path));
    assert.throws(() => validate("demo", { kind: "engine", imports: { [path]: ["Thing"] }, calls: {}, events: {} }), /is a relative path of letters/, JSON.stringify(path));
  }
  for (const path of ["../meadowPage/config", "./types", "../../webkit", "../wire", "../../@scope/thing.d"]) {
    assert.doesNotThrow(() => validateModuleDomain("demo", moduleDomain(undefined, { imports: { [path]: ["Thing"] } })), path);
  }
});
