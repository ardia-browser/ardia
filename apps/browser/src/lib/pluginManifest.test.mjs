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
  assert.deepEqual(contributionsOf(manifest), [...CONTRIBUTIONS]);
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
  const schema = pluginSchema(["tab.opened"], { untabbedEvents: [], approvedSettings: [] });
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.settings.additionalProperties, false);
  assert.equal(schema.properties.settings.properties.rows.items.additionalProperties, false, "rows are checked, not left in an unused $defs");
  assert.deepEqual(schema.properties.hooks.items.enum, ["tab.opened"]);
  assert.equal(schema.properties.process.additionalProperties, false);
  assert.equal(schema.properties.commands.items.additionalProperties, false);
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
  for (const { why, manifest } of cases) {
    const read = readManifest(JSON.stringify(manifest));
    const found = read.manifest ? appProblems(read.manifest, useBrowser.getState().settings, "99.0.0") : read.problems;
    assert.ok(found.length > 0, why);
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
  assert.deepEqual(ok.manifest.programs, [{ name: "ardia", path: "bin/ardia", afterUpdate: [] }]);
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
