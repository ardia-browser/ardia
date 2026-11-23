import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { readManifest, contributionsOf, compareVersions, isPluginPath, CONTRIBUTIONS, MANIFEST_VERSION } = await import("./pluginManifest.ts");
const { pluginSchema } = await import("./pluginSchema.ts");

const FIXTURE = readFileSync(new URL("../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8");
const base = () => JSON.parse(FIXTURE);
const problems = (doc) => readManifest(JSON.stringify(doc)).problems;

test("the example plugin reads with every contribution", () => {
  const { manifest, problems: found } = readManifest(FIXTURE);
  assert.deepEqual(found, []);
  assert.equal(manifest.name, "example");
  assert.deepEqual(contributionsOf(manifest), ["settings", "commands", "page", "process", "programs", "hooks", "tools"]);
  assert.ok(CONTRIBUTIONS.includes("main") && CONTRIBUTIONS.includes("omnibox"));
  assert.deepEqual(manifest.page.source, { file: "page/index.html" });
  assert.deepEqual(manifest.commands.find((c) => c.name === "beside").action, { open: "split", context: true, side: "right", sideSetting: "side", path: "" });
  assert.ok(problems({ ...base(), commands: [{ name: "h", title: "History", open: "tab", path: "/../up" }] }).some((p) => p.includes("path must be")));
  assert.deepEqual(manifest.process, { run: ["/usr/bin/python3", "helper.py"], memoryMB: 256 });
  assert.equal(manifest.tools.find((t) => t.name === "hello").timeout, 5);
});

test("a settings-only plugin from before manifests reads as version 1, its settings as defaults", () => {
  const legacy = {
    name: "compact-command-bar",
    title: "Compact command bar",
    description: "⌘T stops listing your pinned tabs.",
    requires: "0.2.46-nightly.4",
    settings: { commandBarStart: { openTabs: { hidePinned: true, limit: 5 } } },
    reset: { commandBarStart: {} },
  };
  const { manifest, problems: found } = readManifest(JSON.stringify(legacy));
  assert.deepEqual(found, []);
  assert.equal(manifest.manifest, MANIFEST_VERSION);
  assert.deepEqual(manifest.settings.defaults, legacy.settings);
  assert.deepEqual(manifest.settings.rows, []);
  assert.deepEqual(contributionsOf(manifest), ["settings"]);
});

test("a newer manifest needs a newer Ardia and never loads", () => {
  const read = readManifest(JSON.stringify({ ...base(), manifest: MANIFEST_VERSION + 1 }));
  assert.equal(read.manifest, null);
  assert.equal(read.newer, true);
  assert.match(read.problems[0], /needs a newer Ardia/);
});

test("every problem is reported at once, with its path", () => {
  const doc = base();
  doc.extra = 1;
  doc.commands[0].tool = "missing";
  doc.permissions = ["fullUrls", "camera"];
  doc.settings.rows[2].default = "angry";
  const found = problems(doc);
  assert.ok(found.includes("plugin.json: extra isn't a key of a plugin"), found.join("\n"));
  assert.ok(found.includes("plugin.json: commands[0].tool: missing isn't one of this plugin's tools"));
  assert.ok(found.some((p) => p.includes("camera")));
  assert.ok(found.includes("plugin.json: permissions: fullUrls needs tabs"));
  assert.ok(found.includes("plugin.json: settings.rows[2].default must be one of its choices' values"));
});

test("tool commands, tools and hooks need a process; page commands don't", () => {
  const doc = base();
  delete doc.process;
  const found = problems(doc);
  for (const what of ["tool commands", "tools", "hooks"]) assert.ok(found.includes(`plugin.json: ${what} needs a process`), what);
  const pageOnly = { name: "reader", page: { title: "Reader", file: "index.html" }, commands: [{ name: "open", title: "Open Reader", open: "tab" }] };
  assert.deepEqual(problems(pageOnly), []);
});

test("a page is static files: a served page is refused, with or without network", () => {
  const doc = base();
  doc.page = { title: "Served", served: true };
  assert.ok(problems(doc).some((p) => p.startsWith("plugin.json: page.served is gone")));
  doc.permissions.push("network");
  assert.ok(problems(doc).some((p) => p.startsWith("plugin.json: page.served is gone")));
});

test("a page command checks its context, side and the row that picks the side", () => {
  const doc = base();
  doc.permissions = ["commands"];
  doc.hooks = [];
  doc.commands.find((c) => c.name === "beside").sideSetting = "mood";
  const found = problems(doc);
  assert.ok(found.some((p) => p.includes("context needs the tabs permission")), found.join("\n"));
  assert.ok(found.some((p) => p.includes("sideSetting must name a choice row")));
  assert.ok(problems({ ...base(), commands: [{ name: "x", title: "X", open: "tab", tool: "hello" }] }).some((p) => p.includes("either tool")));
  assert.ok(problems({ ...base(), commands: [{ name: "x", title: "X", open: "tab", side: "left" }] }).some((p) => p.includes("only go with open: split")));
  const noPage = base();
  delete noPage.page;
  assert.ok(problems(noPage).some((p) => p.includes("open needs a page")));
});

test("a plugin with a page can't take one of Ardia's own page names", () => {
  assert.ok(problems({ ...base(), name: "history" }).some((p) => p.includes("ardia://history")));
  assert.ok(problems({ ...base(), name: "flags" }).some((p) => p.includes("ardia://flags")));
});

test("a page names exactly one source, inside the plugin's folder", () => {
  for (const page of [{ title: "P" }, { title: "P", file: "a.html", served: true }, { title: "P", file: "../x.html" }, { title: "P", file: "/etc/passwd" }]) {
    assert.ok(problems({ ...base(), page }).some((p) => p.includes("page")), JSON.stringify(page));
  }
  assert.ok(isPluginPath("panel/index.html"));
  for (const bad of ["", "/abs", "a/../b", "./a", "a//b", "a\\b"]) assert.equal(isPluginPath(bad), false, bad);
});

test("names, titles and the program are checked", () => {
  assert.ok(problems({ ...base(), name: "Bad Name" }).some((p) => p.startsWith("plugin.json: name must be")));
  assert.ok(problems({ ...base(), title: "evil‮txt" }).some((p) => p.includes("direction")));
  assert.ok(problems({ ...base(), process: { run: ["../escape"] } }).some((p) => p.includes("process.run[0]")));
  assert.ok(problems({ ...base(), process: { run: [] } }).some((p) => p.includes("process.run")));
  assert.ok(problems({ ...base(), process: { run: ["x"], memoryMB: 9 } }).some((p) => p.includes("memoryMB")));
});

test("versions compare by number, a prerelease before its release", () => {
  assert.ok(compareVersions("0.2.50-nightly.10", "0.2.50-nightly.9") > 0, "nightly.10 comes after nightly.9");
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0, "fewer identifiers come first");
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0, "numbers before words");
  assert.ok(compareVersions("0.2.50", "0.2.46-nightly.4") > 0);
  assert.ok(compareVersions("0.2.46-nightly.4", "0.2.46") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
});

test("the schema closes every block it describes", () => {
  const schema = pluginSchema(["tab.opened"], { untabbedEvents: [], approvedSettings: [], decideEvents: ["tab.opening"] });
  for (const body of [schema.then, schema.then.properties.contributes]) assert.equal(body.additionalProperties, false);
  const v2 = schema.then.properties.contributes.properties;
  assert.equal(v2.settings.additionalProperties, false);
  assert.equal(v2.settings.properties.rows.items.additionalProperties, false, "rows are checked, not left in an unused $defs");
  assert.deepEqual(v2.hooks.items.enum, ["tab.opened", "tab.opening"]);
  assert.equal(schema.then.properties.sidecar.additionalProperties, false);
  assert.equal(v2.commands.items.additionalProperties, false);
  for (const block of ["menus", "permissions"]) assert.equal((v2[block] ?? schema.then.properties[block]).additionalProperties, false, block);
  for (const block of ["toolbar", "sidebarViews", "panels", "omnibox", "themes"]) assert.equal(v2[block].items.additionalProperties, false, block);
  const v1 = schema.else;
  assert.equal(v1.additionalProperties, false);
  assert.equal(v1.properties.process.additionalProperties, false);
  assert.deepEqual(v1.properties.hooks.items.enum, ["tab.opened"]);
});

test("docs/plugin.schema.json, which plugins check against, is what the app writes", async () => {
  const { PLUGIN_EVENTS } = await import("../state/automation/eventNames.ts");
  const { pluginSchemaJson } = await import("./pluginSchema.ts");
  const { PLUGIN_RULES } = await import("../state/plugins/appChecks.ts");
  const published = readFileSync(new URL("../../../../docs/plugin.schema.json", import.meta.url), "utf8");
  assert.equal(pluginSchemaJson(PLUGIN_EVENTS, PLUGIN_RULES), published, "regenerate docs/plugin.schema.json: node --import ./src/test-loader.mjs scripts/write-plugin-schema.mjs");
});

test("every manifest in the shared rejected list is refused, the same list ardia plugins check refuses", async () => {
  const { appProblems } = await import("../state/plugins/appChecks.ts");
  const { useBrowser } = await import("../state/browser/store.ts");
  const cases = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/plugins/rejected-manifests.json", import.meta.url), "utf8"));
  for (const { why, manifest, problems: expected } of cases) {
    const read = readManifest(JSON.stringify(manifest));
    const found = read.manifest ? appProblems(read.manifest, useBrowser.getState().settings, "99.0.0") : read.problems;
    assert.ok(found.length > 0, why);
    if (expected) assert.deepEqual(found, expected, why);
  }
});

test("the manifest example in docs/plugins.md reads without problems", () => {
  const doc = readFileSync(new URL("../../../../docs/plugins.md", import.meta.url), "utf8");
  const start = doc.indexOf("```json") + "```json".length;
  assert.deepEqual(readManifest(doc.slice(start, doc.indexOf("```", start))).problems, []);
});

test("a path with a lone surrogate is a manifest problem, not a crash", () => {
  for (const patch of [{ page: { title: "P", file: "page/a\ud800.html" } }, { process: { run: ["bin/\udc00helper"] } }, { commands: [{ name: "h", title: "H", open: "tab", path: "/x\ud800" }] }]) {
    let found;
    assert.doesNotThrow(() => (found = problems({ ...base(), ...patch })), JSON.stringify(patch));
    assert.ok(found.length > 0, JSON.stringify(patch));
  }
});

test("programs: a name like a plugin's and a file in the plugin's folder", () => {
  const ok = readManifest(JSON.stringify({ ...base(), programs: [{ name: "ardia", path: "bin/ardia" }] }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.manifest.programs, [{ name: "ardia", path: "bin/ardia", afterUpdate: [], example: null, claim: false }]);
  assert.deepEqual(readManifest(JSON.stringify({ ...base(), programs: [{ name: "a", path: "a", afterUpdate: [["skills", "refresh"], ["x"]] }] })).manifest.programs[0].afterUpdate, [["skills", "refresh"], ["x"]]);
  for (const afterUpdate of [["x"], [[]], [Array(9).fill("x")], Array(5).fill(["x"]), [[""]]]) assert.ok(problems({ ...base(), programs: [{ name: "a", path: "a", afterUpdate }] }).some((p) => p.includes("programs[0].afterUpdate")), JSON.stringify(afterUpdate));
  assert.equal(readManifest(JSON.stringify({ ...base(), alwaysOn: true })).manifest.alwaysOn, true);
  assert.equal(readManifest(FIXTURE).manifest.alwaysOn, false);
  assert.ok(problems({ ...base(), alwaysOn: false }).includes("plugin.json: alwaysOn must be true"));
  assert.ok(problems({ ...base(), programs: [{ name: "Ardia", path: "bin/ardia" }] }).some((p) => p.includes("programs[0].name")));
  for (const path of ["/usr/bin/true", "../escape", "bin/../../x", "", "a\\b"]) assert.ok(problems({ ...base(), programs: [{ name: "a", path }] }).some((p) => p.includes("programs[0].path")), path);
  assert.ok(problems({ ...base(), programs: [{ name: "a", path: "a" }, { name: "a", path: "b" }] }).some((p) => p.includes("two programs named a")));
  assert.ok(problems({ ...base(), programs: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, path: "a" })) }).some((p) => p.includes("programs must be a list of at most 4")));
  assert.ok(problems({ ...base(), programs: [{ name: "a", path: "a", run: ["x"] }] }).some((p) => p.includes("programs[0].run isn't a key")));
});

test("control is a permission of its own and needs nothing else", () => {
  assert.deepEqual(readManifest(JSON.stringify({ ...base(), permissions: [...base().permissions, "control"] })).problems, []);
});

const PASSWORD_FIXTURE = readFileSync(new URL("../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");

test("a password manager declares how it fills, which fields get the key, and what else it offers", () => {
  const { manifest, problems: found } = readManifest(PASSWORD_FIXTURE);
  assert.deepEqual(found, []);
  assert.deepEqual(manifest.passwordManager, { fill: "system", fields: ["login", "oneTimeCode"], verificationCodeSetup: "system", passkeys: "system" });
  assert.deepEqual(contributionsOf(manifest), ["passwordManager"]);
  const minimal = readManifest(JSON.stringify({ ...JSON.parse(PASSWORD_FIXTURE), passwordManager: { fill: "system", fields: ["oneTimeCode"] } }));
  assert.deepEqual(minimal.manifest.passwordManager, { fill: "system", fields: ["oneTimeCode"], verificationCodeSetup: null, passkeys: null });
  assert.equal(readManifest(FIXTURE).manifest.passwordManager, null);
});

test("fill: tool is retired like any other fill, and every other shape is reported with its path", () => {
  const doc = (passwordManager) => ({ ...JSON.parse(PASSWORD_FIXTURE), passwordManager });
  assert.deepEqual(problems(doc({ fill: "tool", fields: ["login"] })), ["plugin.json: passwordManager.fill must be system"]);
  assert.deepEqual(problems(doc({ fill: "system", fields: ["login", "login"] })), ["plugin.json: passwordManager.fields has login twice"]);
  assert.ok(problems(doc({ fill: "system", fields: [] }))[0].includes("passwordManager.fields must be a list of 1 to 2"));
  assert.ok(problems(doc({ fill: "system", fields: ["login"], extra: 1 }))[0].includes("passwordManager.extra isn't a key"));
  assert.ok(problems(doc([{ fill: "system", fields: ["login"] }]))[0].includes("passwordManager must be an object"));
  assert.ok(problems(doc({ fill: "system", fields: ["login"], passkeys: "own" })).includes("plugin.json: passwordManager.passkeys must be system"));
});

test("the schema holds passwordManager to the same shape the app reads", () => {
  const schema = pluginSchema([], { untabbedEvents: [], approvedSettings: [] }).then.properties.contributes.properties.passwordManager;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["fill", "fields"]);
  assert.deepEqual(schema.properties.fill.enum, ["system"]);
  assert.deepEqual(schema.properties.fields.items.enum, ["login", "oneTimeCode"]);
});

const { parseWhen, evaluateWhen, whenHolds, globMatches } = await import("./pluginWhen.ts");
const { matchesAllowedHost, hostPatternProblem, hostPatternCovers } = await import("./pluginNetwork.ts");
const { missingPermissions, NO_PERMISSIONS } = await import("./pluginPermissions.ts");
const { buildPluginThemeCss, cssRoleValue } = await import("./pluginThemeCss.ts");
const { checkPluginNode, toolbarUpdateOf, quickPickItemsOf, NODE_LIMITS } = await import("./pluginNodes.ts");
const { MANIFEST_MIGRATIONS } = await import("./pluginManifest.ts");

const V2 = () => ({
  manifest: 2,
  name: "reader",
  title: "Reader",
  icon: "book",
  main: "dist/index.js",
  permissions: { tabs: "read", activePage: true, storage: true, secrets: true, network: ["api.example.com", "*.cdn.example.com"] },
  contributes: {
    commands: [
      { name: "summarize", title: "Summarize Page", when: "urlScheme == 'https' && !isPinned" },
      { name: "browse", title: "Browse Notes", view: "notes" },
      { name: "panel", title: "Open Reader Panel", panel: "side" },
    ],
    menus: { tab: [{ command: "summarize" }], group: [{ command: "summarize", title: "Summarize Group", when: "urlHost ~= '*.example.com'" }] },
    toolbar: [{ id: "go", title: "Reader", icon: "book", view: "quick" }],
    sidebarViews: [{ id: "notes", title: "Notes", icon: "note.text" }],
    panels: [
      { id: "default", title: "Reader", mode: "tab", file: "page/index.html" },
      { id: "side", title: "Reader Side", mode: "sidecar", view: "side" },
    ],
    omnibox: [{ id: "notes", title: "Notes", keyword: "n" }],
    themes: [{ id: "dusk", title: "Dusk", file: "themes/dusk.json" }],
    settings: { rows: [{ key: "limit", title: "Limit", type: "number", default: 5, min: 1, max: 10 }, { key: "token", title: "API token", type: "secret" }] },
    hooks: ["tab.opening"],
  },
});
const v2problems = (patch) => readManifest(JSON.stringify(patch(V2()) ?? V2())).problems;

test("a v1 manifest migrates into v2's shape: process is the sidecar, page the default panel, permissions an object", () => {
  const raw = MANIFEST_MIGRATIONS[1](JSON.parse(FIXTURE));
  assert.deepEqual(raw.sidecar, { run: ["/usr/bin/python3", "helper.py"], memoryMB: 256 });
  assert.deepEqual(raw.contributes.panels, [{ id: "default", mode: "tab", title: "Example", icon: "sparkles", file: "page/index.html" }]);
  assert.deepEqual(raw.permissions, { tabs: "read", commands: true });
  for (const gone of ["process", "page", "commands", "tools", "hooks", "settings", "programs"]) assert.equal(raw[gone], undefined, gone);
  const { manifest } = readManifest(FIXTURE);
  assert.equal(manifest.manifest, 2);
  assert.equal(manifest.declaredManifest, 1);
  assert.deepEqual(manifest.permissions, { tabs: "read", fullUrls: false, activePage: false, workspace: false, commands: true, storage: false, secrets: false, network: false, control: false });
  assert.equal(manifest.sidecar, manifest.process);
  assert.equal(manifest.commands, manifest.contributes.commands);
  assert.equal(manifest.main, null);
  assert.deepEqual(manifest.activationEvents.slice(0, 1), ["onStartupFinished"]);
});

test("the built-in plugins' v1 manifests still read: cli's control and programs, a password manager's passwordManager", () => {
  const cli = readManifest(JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, icon: "terminal.fill", permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: [["skills", "refresh"]] }] }));
  assert.deepEqual(cli.problems, []);
  assert.equal(cli.manifest.permissions.control, true);
  assert.deepEqual(cli.manifest.programs, [{ name: "ardia", path: "bin/ardia", afterUpdate: [["skills", "refresh"]], example: null, claim: false }]);
  assert.equal(cli.manifest.icon, "terminal.fill");
  const pm = readManifest(PASSWORD_FIXTURE).manifest;
  assert.equal(pm.contributes.passwordManager, pm.passwordManager);
  const network = readManifest(JSON.stringify({ ...base(), permissions: ["tabs", "network"] })).manifest;
  assert.equal(network.permissions.network, "*");
});

test("a v2 manifest reads every contribution, and leaves activation to what it contributes", () => {
  const { manifest, problems: found } = readManifest(JSON.stringify(V2()));
  assert.deepEqual(found, []);
  assert.deepEqual(manifest.main, { entry: "dist/index.js", memoryMB: 256 });
  assert.deepEqual(manifest.permissions.network, ["api.example.com", "*.cdn.example.com"]);
  assert.deepEqual(manifest.commands[0].action, { handler: true });
  assert.deepEqual(manifest.commands[1].action, { view: "notes" });
  assert.equal(Object.hasOwn(manifest.commands[0], "shortcut"), false);
  assert.deepEqual(manifest.page, { title: "Reader", icon: "puzzlepiece", source: { file: "page/index.html" } });
  assert.deepEqual(manifest.settings.rows[1], { key: "token", title: "API token", type: "secret", default: "" });
  assert.deepEqual(manifest.activationEvents.sort(), ["onCommand:browse", "onCommand:panel", "onCommand:summarize", "onMenu:group", "onMenu:tab", "onOmnibox:notes", "onPanel:side", "onStartupFinished", "onToolbar:go", "onView:notes"].sort());
  assert.deepEqual(contributionsOf(manifest), ["settings", "commands", "page", "hooks", "main", "menus", "toolbar", "sidebarViews", "panels", "omnibox", "themes"]);
  const lazy = readManifest(JSON.stringify({ ...V2(), contributes: { commands: [{ name: "x", title: "X" }] } })).manifest;
  assert.deepEqual(lazy.activationEvents, ["onCommand:x"]);
  const given = readManifest(JSON.stringify({ ...V2(), activationEvents: ["onUrl:*.github.com", "onEvent:tab.opened"] })).manifest;
  assert.deepEqual(given.activationEvents, ["onUrl:*.github.com", "onEvent:tab.opened"]);
});

test("v2 refuses what main, a sidecar or a permission would have to back", () => {
  const cases = [
    [(d) => void delete d.main, ".view needs a main"],
    [(d) => void delete d.main, "contributes.sidebarViews needs a main"],
    [(d) => void delete d.main, "contributes.omnibox needs a main"],
    [(d) => void delete d.main, "contributes.toolbar[0].view needs a main"],
    [(d) => void delete d.main, "hooks needs a main or a sidecar"],
    [(d) => void (d.contributes.menus.tab = [{ command: "nope" }]), "contributes.menus.tab[0].command: nope isn't one of this plugin's commands"],
    [(d) => void (d.contributes.toolbar = [{ id: "a", title: "A", icon: "a", command: "nope" }]), "contributes.toolbar[0].command: nope isn't one of this plugin's commands"],
    [(d) => void (d.contributes.toolbar = [{ id: "a", title: "A", icon: "a" }]), "contributes.toolbar[0] needs either command or view"],
    [(d) => void (d.contributes.commands[0].when = "urlHost = 'x'"), "contributes.commands[0].when"],
    [(d) => void (d.contributes.commands[0].when = "secretKey == 1"), "isn't one of urlHost"],
    [(d) => void (d.contributes.commands[0].when = "hasSelection"), "names hasSelection, which isn't one of"],
    [(d) => void (d.permissions.network = ["http://evil.com"]), "permissions.network[0] must be a bare host"],
    [(d) => void (d.permissions.network = ["*.com"]), "permissions.network[0] must put * in front of a domain with at least two parts"],
    [(d) => void (d.sidecar = { run: ["bin/x"] }), "a sidecar can only have \"*\" or false"],
    [(d) => void (d.permissions.workspace = true), "workspace needs tabs: write and fullUrls"],
    [(d) => void (d.permissions.secrets = false), "a secret row needs the secrets permission"],
    [(d) => void (d.contributes.settings.rows[1].default = "x"), "can't go with a secret"],
    [(d) => void (d.contributes.settings.rows[0].default = 50), "default must be a number between its min and max"],
    [(d) => void (d.activationEvents = ["onSomething:x"]), "activationEvents[0] must be *"],
    [(d) => void (d.activationEvents = ["onUrl:*"]), "activationEvents[0] has a bad onUrl argument"],
    [(d) => void (d.contributes.panels[1].file = "a.html"), "takes a file or a view, not both"],
    [(d) => void (d.contributes.omnibox = [{ id: "x", title: "X" }]), "needs a keyword or global: true"],
    [(d) => void (d.contributes.themes[0].file = "themes/dusk.css"), "contributes.themes[0].file must be a .json file"],
    [(d) => void (d.contributes.commands[2].panel = "nope"), "contributes.commands[2].panel: nope isn't one of this plugin's panels"],
    [(d) => void (d.main = "../escape.js"), "main must be a JavaScript file inside the plugin's folder"],
    [(d) => void (d.sidecar = { run: ["/usr/bin/python3"] }), "a plugin can declare main or sidecar, not both"],
    [(d) => void (d.contributes.menus.page = [{ command: "summarize" }]), "contributes.menus.page isn't a key of contributes.menus"],
    [(d) => void (d.contributes.menus.link = [{ command: "summarize" }]), "contributes.menus.link isn't a key"],
    [(d) => void (d.contributes.menus.selection = [{ command: "summarize" }]), "contributes.menus.selection isn't a key"],
    [(d) => void (d.contributes.panels[1].mode = "popover"), "contributes.panels[1].mode must be sidecar, tab, split"],
    [(d) => void (d.contributes.commands[0].shortcut = "cmd+shift+s"), "contributes.commands[0].shortcut isn't a key"],
    [(d) => void (d.contributes.omnibox = [{ id: "x", title: "X", keyword: "x", global: true }]), "contributes.omnibox[0] takes a keyword or global: true, not both"],
    [(d) => void (d.main = "index.py"), "main must be a .js"],
    [(d) => void (d.memoryMB = 9), "memoryMB must be a whole number from 64 to 4096"],
    [(d) => void (d.permissions = ["tabs"]), "permissions must be an object"],
    [(d) => void (d.commands = []), "commands isn't a key of a plugin"],
  ];
  for (const [patch, words] of cases) {
    const found = v2problems((d) => (patch(d), d));
    assert.ok(found.some((p) => p.includes(words)), `${words}\n${found.join("\n")}`);
  }
  const noMain = V2();
  delete noMain.main;
  noMain.activationEvents = ["*"];
  assert.ok(readManifest(JSON.stringify(noMain)).problems.includes("plugin.json: activationEvents only go with a main"));
});

test("a v2 command with nothing to do needs a main, which handles it by default", () => {
  const doc = { manifest: 2, name: "bare", contributes: { commands: [{ name: "x", title: "X" }] } };
  assert.ok(readManifest(JSON.stringify(doc)).problems.some((p) => p.includes("needs either tool")));
  assert.ok(readManifest(JSON.stringify({ ...doc, contributes: { commands: [{ name: "x", title: "X", handler: true }] } })).problems.some((p) => p.includes("handler needs a main")));
  assert.deepEqual(readManifest(JSON.stringify({ ...doc, main: "index.js" })).problems, []);
});

test("any plugin may have an icon now, not only built-in ones", async () => {
  const { appProblems } = await import("../state/plugins/appChecks.ts");
  const { useBrowser } = await import("../state/browser/store.ts");
  const m = readManifest(JSON.stringify({ ...V2(), contributes: {} })).manifest;
  assert.deepEqual(appProblems(m, useBrowser.getState().settings, "99.0.0", "user"), []);
  const decide = readManifest(JSON.stringify({ ...V2(), permissions: { secrets: true } })).manifest;
  assert.ok(appProblems(decide, useBrowser.getState().settings, "99.0.0").some((p) => p.includes("contributes.hooks[0]: tab.opening needs the tabs permission")));
});

test("when clauses: keys, literals, &&, ||, !, ==, != and ~=, with no eval and no unknown keys", () => {
  const ctx = { urlHost: "docs.github.com", urlScheme: "https", isPinned: false, tabCount: 3, isActive: true };
  const holds = (text) => whenHolds(text, ctx);
  assert.equal(holds("urlScheme == 'https' && !isPinned"), true);
  assert.equal(holds("isPinned || isActive"), true);
  assert.equal(holds("!(isActive && tabCount == 3)"), false);
  assert.equal(holds("tabCount != 2"), true);
  assert.equal(holds('urlHost ~= "*.github.com"'), true);
  assert.equal(holds('urlHost ~= "github.com"'), false);
  assert.equal(holds("isSplit"), false);
  assert.equal(holds(""), true);
  assert.equal(whenHolds("constructor", ctx), false);
  for (const bad of ["urlHost =", "process.exit()", "a == 1", "(isPinned", "'unterminated", "isPinned &&", "x".repeat(201), "isPinned)"]) assert.equal(parseWhen(bad).ok, false, bad);
  const deep = `${"!(".repeat(20)}isPinned${")".repeat(20)}`;
  assert.equal(parseWhen(deep).ok, false, "nesting has a limit");
  assert.equal(evaluateWhen(parseWhen("tabCount == '3'").expr, ctx), true);
  assert.equal(globMatches("a*b*c", "aXXbYYc"), true);
  assert.equal(globMatches("a*b", "a".repeat(100) + "c"), false);
});

test("network allowlists: exact hosts, *.domain (its subdomains, never the bare domain, as native fetch enforces) and *, nothing malformed", () => {
  assert.equal(matchesAllowedHost("api.example.com", ["api.example.com"]), true);
  assert.equal(matchesAllowedHost("API.Example.com.", ["api.example.com"]), true);
  assert.equal(matchesAllowedHost("evil-api.example.com", ["api.example.com"]), false);
  assert.equal(matchesAllowedHost("a.b.example.com", ["*.example.com"]), true);
  assert.equal(matchesAllowedHost("example.com", ["*.example.com"]), false);
  assert.equal(matchesAllowedHost("notexample.com", ["*.example.com"]), false);
  assert.equal(matchesAllowedHost("example.com.evil.io", ["*.example.com"]), false);
  assert.equal(matchesAllowedHost("anything.io", ["*"]), true);
  assert.equal(matchesAllowedHost("x.io", ["http://x.io", "x.io:443", "*x.io"]), false);
  assert.equal(matchesAllowedHost("", ["*"]), false);
  for (const bad of ["http://a.com", "a.com/path", "a.com:80", "*.com", "a.*.com", "A.com", "-a.com", "1.2.3", "*.1.2.3.4", "user@a.com", 5]) assert.ok(hostPatternProblem(bad), String(bad));
  for (const good of ["*", "a.com", "*.a.co.uk", "127.0.0.1", "xn--bcher-kva.example"]) assert.equal(hostPatternProblem(good), null, good);
});

test("a host pattern covers another only when it allows every host the other allows", () => {
  const covered = [["api.example.com", "api.example.com"], ["*.example.com", "*.example.com"], ["*.example.com", "api.example.com"], ["*.example.com", "a.b.example.com"], ["*.example.com", "*.api.example.com"], ["*", "*.example.com"], ["*", "api.example.com"]];
  const notCovered = [["api.example.com", "*.example.com"], ["api.example.com", "example.com"], ["example.com", "api.example.com"], ["*.example.com", "evil-example.com"], ["*.example.com", "*.notexample.com"], ["*.example.com", "example.com.evil.io"], ["*.api.example.com", "*.example.com"], ["*.api.example.com", "example.com"], ["*.example.com", "*"], ["*.example.com", "http://api.example.com"], ["*.example.com", "example.com"]];
  for (const [broader, narrower] of covered) {
    assert.equal(hostPatternCovers(broader, narrower), true, `${broader} covers ${narrower}`);
    const reached = narrower === "*" ? [] : narrower.startsWith("*.") ? [`a.${narrower.slice(2)}`, `x.y.${narrower.slice(2)}`] : [narrower];
    for (const h of reached) assert.equal(matchesAllowedHost(h, [narrower]) && matchesAllowedHost(h, [broader]), true, `${broader} reaches ${h}`);
  }
  for (const [broader, narrower] of notCovered) assert.equal(hostPatternCovers(broader, narrower), false, `${broader} doesn't cover ${narrower}`);
  const net = (network) => ({ ...NO_PERMISSIONS, network });
  assert.deepEqual(missingPermissions(net(["*.example.com"]), net(["api.example.com"])), []);
  assert.deepEqual(missingPermissions(net(["*.example.com", "x.io"]), net(["*.api.example.com", "x.io"])), []);
  assert.deepEqual(missingPermissions(net(["api.example.com"]), net(["*.example.com"])), ["network"]);
  assert.deepEqual(missingPermissions(net(["*.example.com"]), net(["api.example.com", "evil-example.com"])), ["network"]);
  assert.deepEqual(missingPermissions(net(["*.example.com"]), net("*")), ["network"]);
  assert.deepEqual(missingPermissions(net(false), net(["api.example.com"])), ["network"]);
});

test("a plugin page's theme CSS comes only from the roles given, with nothing that can load or escape", () => {
  const css = buildPluginThemeCss({ scheme: "dark", roles: { background: "rgb(20, 20, 20)", text: "rgba(255,255,255,0.9)", accentStrong: "hsl(210 80% 50%)", radius: 6, evil: "red; } body { background: url(https://x)", sneaky: "url(x)", "bad-name": "red" } });
  assert.match(css, /color-scheme: dark;/);
  assert.match(css, /--ardia-background: rgb\(20, 20, 20\);/);
  assert.match(css, /--ardia-accent-strong: hsl\(210 80% 50%\);/);
  assert.match(css, /--ardia-radius: 6;/);
  assert.doesNotMatch(css, /evil|sneaky|bad-name|url\(/);
  assert.match(css, /background: var\(--ardia-background, Canvas\)/);
  assert.equal(cssRoleValue("var(--x)"), null);
  assert.equal(buildPluginThemeCss({ scheme: "nope", roles: {} }).includes("color-scheme: light;"), true);
});

test("a rendered tree is held to its limits, and its text cleaned", () => {
  const ok = checkPluginNode({ type: "List", props: { title: "Notes‮", onSelect: "h1", items: [1, "a", { b: true }] }, children: ["hi", 3, null, false, { type: "Text", key: 7, props: {}, children: [] }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.tree.props.title, "Notes");
  assert.deepEqual(ok.tree.children, ["hi", "3", { type: "Text", key: 7, props: {}, children: [] }]);
  let deep = { type: "Box", props: {}, children: [] };
  for (let i = 0; i < NODE_LIMITS.depth + 2; i++) deep = { type: "Box", props: {}, children: [deep] };
  assert.match(checkPluginNode(deep).problem, /nests deeper/);
  assert.match(checkPluginNode({ type: "Box", children: Array.from({ length: NODE_LIMITS.nodes + 1 }, () => ({ type: "Text" })) }).problem, /more than/);
  assert.match(checkPluginNode({ type: "script" }).problem, /component name/);
  assert.match(checkPluginNode({ type: "Box", props: { "on-click": 1 } }).problem, /prop named/);
  assert.match(checkPluginNode({ type: "Text", children: ["x".repeat(NODE_LIMITS.textBytes + 1)] }).problem, /KB of text/);
  assert.equal(checkPluginNode("text").ok, false);
  assert.deepEqual(toolbarUpdateOf({ badge: 123456, label: "Hi", tone: "accent" }), { badge: 9999, label: "Hi", tone: "accent" });
  assert.equal(toolbarUpdateOf({ icon: "../x" }), null);
  assert.equal(toolbarUpdateOf({ tone: "loud" }), null);
  assert.equal(quickPickItemsOf([{ id: "a", title: "A" }, { id: "a", title: "B" }]), null, "ids are unique");
  assert.deepEqual(quickPickItemsOf([{ id: "a", title: "A", icon: "star", keywords: ["x"], picked: true, extra: 1 }]), [{ id: "a", title: "A", icon: "star", keywords: ["x"], picked: true }]);
});

test("when clauses refuse hasSelection, which Ardia never fills, rather than taking an always-false key", () => {
  const read = parseWhen("hasSelection");
  assert.equal(read.ok, false);
  assert.match(read.problem, /names hasSelection, which isn't one of/);
  assert.equal(whenHolds("!hasSelection", { isActive: true }), false, "not even negated: the clause doesn't parse");
});

test("manifest 2 adds keywords, a telemetry disclosure, and a program's example and claim; manifest 1 can't use them", () => {
  const v2 = {
    manifest: 2,
    name: "cli",
    title: "Command Line",
    keywords: ["terminal", "cli", "terminal"],
    telemetry: { title: "The ardia command", items: ["Each command's name"] },
    contributes: { programs: [{ name: "ardia", path: "bin/ardia", example: "ardia tabs", claim: true }] },
  };
  const read = readManifest(JSON.stringify(v2));
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.manifest.keywords, ["terminal", "cli"]);
  assert.deepEqual(read.manifest.telemetry, { title: "The ardia command", items: ["Each command's name"] });
  assert.deepEqual(read.manifest.programs[0], { name: "ardia", path: "bin/ardia", afterUpdate: [], example: "ardia tabs", claim: true });
  assert.deepEqual(readManifest(JSON.stringify({ manifest: 2, name: "x" })).manifest.keywords, []);
  assert.equal(readManifest(JSON.stringify({ manifest: 2, name: "x" })).manifest.telemetry, null);
  const bad = (doc) => readManifest(JSON.stringify({ manifest: 2, name: "x", ...doc })).problems;
  assert.ok(bad({ keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) }).some((p) => p.includes("keywords must be a list of at most 12")));
  assert.ok(bad({ keywords: ["x".repeat(41)] }).some((p) => p.includes("keywords[0]")));
  assert.ok(bad({ telemetry: { title: "T", items: [] } }).some((p) => p.includes("telemetry.items")));
  assert.ok(bad({ telemetry: { title: "T", items: ["a"], extra: 1 } }).some((p) => p.includes("telemetry.extra")));
  assert.ok(bad({ contributes: { programs: [{ name: "a", path: "a", claim: "yes" }] } }).some((p) => p.includes("claim must be true or false")));
  const v1 = (doc) => readManifest(JSON.stringify({ manifest: 1, name: "x", title: "X", ...doc })).problems;
  assert.ok(v1({ keywords: ["a"] }).some((p) => p.includes("keywords needs manifest 2")));
  assert.ok(v1({ telemetry: { title: "T", items: ["a"] } }).some((p) => p.includes("telemetry needs manifest 2")));
  assert.ok(v1({ programs: [{ name: "a", path: "a", example: "a" }] }).some((p) => p.includes("programs[0].example needs manifest 2")));
  assert.ok(v1({ programs: [{ name: "a", path: "a", claim: true }] }).some((p) => p.includes("programs[0].claim needs manifest 2")));
  const schema = pluginSchema([], { untabbedEvents: [], approvedSettings: [] });
  assert.ok(schema.then.properties.keywords && schema.then.properties.telemetry);
  assert.ok(schema.then.properties.contributes.properties.programs.items.properties.claim);
  assert.equal(schema.else.properties.programs.items.properties.claim, undefined, "manifest 1's schema keeps its old programs");
});
