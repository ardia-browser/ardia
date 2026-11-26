import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { v3, v3Text } from "../state/plugins/fixtures/manifests.mjs";
import { EXAMPLE } from "../state/plugins/fixtures/example.mjs";
const { readManifest, contributionsOf, compareVersions, isPluginPath, CONTRIBUTIONS, MANIFEST_VERSION, OLDER_MANIFEST } = await import("./pluginManifest.ts");
const { keyOfId, idOfKey, folderMatchesId, isOfficialId } = await import("./pluginIds.ts");

const FIXTURE = readFileSync(new URL("../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8");
const base = () => JSON.parse(FIXTURE);
const problems = (doc) => readManifest(JSON.stringify(doc)).problems;

test("the example plugin, manifest 3, reads with every contribution and a scoped key", () => {
  const { manifest, problems: found } = readManifest(FIXTURE);
  assert.deepEqual(found, []);
  assert.equal(manifest.manifest, MANIFEST_VERSION);
  assert.equal(manifest.id, "@test/example");
  assert.equal(manifest.name, "test__example");
  assert.equal(manifest.scope, "global", "programs force global scope");
  assert.deepEqual(contributionsOf(manifest), ["settings", "commands", "page", "process", "programs", "hooks", "tools"]);
  assert.ok(CONTRIBUTIONS.includes("main") && CONTRIBUTIONS.includes("omnibox"));
  assert.deepEqual(manifest.page.source, { file: "page/index.html" });
  assert.deepEqual(manifest.commands.find((c) => c.name === "beside").action, { open: "split", context: true, side: "right", sideSetting: "side", path: "" });
  assert.deepEqual(manifest.process, { run: ["helper.py"], memoryMB: 256 });
  assert.equal(manifest.tools.find((t) => t.name === "hello").timeout, 5);
  assert.equal(readManifest(FIXTURE, "example").manifest.name, "example", "a local folder keeps its own key");
});

test("manifests before 3 are refused with a way forward, and a newer one needs a newer Ardia", () => {
  for (const old of [{ name: "x" }, { manifest: 1, name: "x" }, { manifest: 2, name: "x", title: "X" }]) {
    const read = readManifest(JSON.stringify(old));
    assert.equal(read.manifest, null);
    assert.deepEqual(read.problems, [OLDER_MANIFEST]);
    assert.equal(read.newer, false);
  }
  const newer = readManifest(JSON.stringify({ ...base(), manifest: MANIFEST_VERSION + 1 }));
  assert.equal(newer.newer, true);
  assert.match(newer.problems[0], /needs a newer Ardia/);
  assert.match(readManifest("{").problems[0], /isn't valid JSON/);
  assert.match(readManifest("[]").problems[0], /must be an object/);
});

test("the SDK's manifest 3 checks are the app's, every problem prefixed with plugin.json", () => {
  const found = problems({ ...base(), extra: 1, id: "not-scoped", permissions: { fullUrls: true } });
  assert.ok(found.every((p) => p.startsWith("plugin.json: ")), found.join("\n"));
  assert.ok(found.some((p) => p.includes("extra")), found.join("\n"));
  assert.ok(found.some((p) => p.includes("id")), found.join("\n"));
  assert.ok(problems({ ...base(), scope: "profile" }).some((p) => p.includes('scope must be "global"')));
  assert.ok(problems({ ...base(), engines: { ardia: "not a range" } }).some((p) => p.includes("engines.ardia")));
});

test("ids map to keys and back, and a local folder may use either the key or the bare name", () => {
  assert.equal(keyOfId("@alice/pr-reviewer"), "alice__pr-reviewer");
  assert.equal(idOfKey("alice__pr-reviewer"), "@alice/pr-reviewer");
  assert.equal(idOfKey("plain"), null);
  assert.equal(keyOfId("alice/x"), null);
  assert.ok(folderMatchesId("pr-reviewer", "@alice/pr-reviewer") && folderMatchesId("alice__pr-reviewer", "@alice/pr-reviewer"));
  assert.equal(folderMatchesId("other", "@alice/pr-reviewer"), false);
  assert.ok(isOfficialId("@ardia/cli") && !isOfficialId("@ardiax/cli") && !isOfficialId("ardia/cli"));
  assert.equal(readManifest(v3Text({ name: "cli", title: "CLI" }, "ardia")).manifest.official, true);
  assert.equal(readManifest(v3Text({ name: "cli", title: "CLI" }, "alice")).manifest.official, false);
});

test("the runtime reads what this Ardia runs and keeps the whole v3 manifest for consent and updates", () => {
  const doc = v3({ name: "reader", title: "Reader", main: "index.js", sidecar: undefined, permissions: { tabs: "read", activePage: { read: true, screenshot: true }, network: ["api.example.com", "localhost:11434"], bookmarks: "read", pages: ["https://github.com/*"] }, contributes: { commands: [{ name: "pr", title: "PRs", inputMode: "pr" }], inputModes: [{ id: "pr", title: "PRs" }], pageStyles: [{ id: "s", matches: ["https://github.com/*"], css: "s.css" }] } });
  const { manifest, problems: found } = readManifest(JSON.stringify(doc));
  assert.deepEqual(found, []);
  assert.equal(manifest.permissions.activePage, true);
  assert.deepEqual(manifest.permissions.network, ["api.example.com", "localhost:11434"], "an explicit local port is kept for the host to hold the plugin to");
  assert.deepEqual([manifest.permissions.screenshot, manifest.permissions.multiTab, manifest.permissions.bookmarks, manifest.permissions.pages], [true, false, "read", ["https://github.com/*"]]);
  assert.equal(manifest.v3.permissions.bookmarks, "read");
  assert.deepEqual(manifest.v3.contributes.pageStyles.map((s) => s.id), ["s"]);
  assert.deepEqual(manifest.commands[0].action, { handler: true }, "an input-mode command runs its handler until input modes land");
  const hybrid = readManifest(JSON.stringify(v3({ name: "both", title: "Both", main: "index.js", sidecar: { run: ["bin/helper"] } }))).manifest;
  assert.deepEqual([hybrid.main?.entry, hybrid.sidecar?.run], ["index.js", ["bin/helper"]], "main and a sidecar run side by side");
  assert.deepEqual(hybrid.v3.sidecar, { run: ["bin/helper"] });
  const deps = readManifest(JSON.stringify(v3({ name: "d", title: "D", main: "index.js", dependencies: { "@acme/lib": "^1.0.0" }, optionalDependencies: { "@ardia/cli": ">=0.8.0" } }))).manifest;
  assert.deepEqual([deps.dependencies, deps.optionalDependencies, deps.engines], [{ "@acme/lib": "^1.0.0" }, { "@ardia/cli": ">=0.8.0" }, { ardia: ">=0.0.0" }]);
});

test("a plugin with a page can't take one of Ardia's own page names", () => {
  assert.ok(readManifest(v3Text({ ...EXAMPLE, name: "history" }), "history").problems.some((p) => p.includes("ardia://history")));
});

test("a page command checks its context, side and the row that picks the side", () => {
  const doc = structuredClone(EXAMPLE);
  doc.permissions = ["commands"];
  doc.hooks = [];
  doc.commands.find((c) => c.name === "beside").sideSetting = "mood";
  const found = readManifest(v3Text(doc)).problems;
  assert.ok(found.some((p) => p.includes("context needs")), found.join("\n"));
  const sides = structuredClone(EXAMPLE);
  sides.commands.find((c) => c.name === "beside").sideSetting = "mood";
  assert.ok(readManifest(v3Text(sides)).problems.some((p) => p.includes("sideSetting must name a choice row")));
  const noPage = structuredClone(EXAMPLE);
  delete noPage.page;
  assert.ok(readManifest(v3Text(noPage)).problems.some((p) => p.includes("open needs a page")));
});

test("versions compare by number, a prerelease before its release", () => {
  assert.ok(compareVersions("0.2.50-nightly.10", "0.2.50-nightly.9") > 0, "nightly.10 comes after nightly.9");
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0, "fewer identifiers come first");
  assert.ok(compareVersions("0.2.50", "0.2.46-nightly.4") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(isPluginPath("panel/index.html"));
  for (const bad of ["", "/abs", "a/../b", "./a", "a//b", "a\\b"]) assert.equal(isPluginPath(bad), false, bad);
});

test("every manifest in the shared rejected list is refused", async () => {
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
  for (const patch of [{ page: { title: "P", file: "page/a\ud800.html" } }, { process: { run: ["bin/\udc00helper"] } }]) {
    let found;
    assert.doesNotThrow(() => (found = readManifest(v3Text({ ...EXAMPLE, ...patch })).problems), JSON.stringify(patch));
    assert.ok(found.length > 0, JSON.stringify(patch));
  }
});

test("programs: names, files in the plugin's folder, and after-update steps", () => {
  const ok = readManifest(v3Text({ ...EXAMPLE, programs: [{ name: "ardia", path: "bin/ardia" }] }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.manifest.programs, [{ name: "ardia", path: "bin/ardia", afterUpdate: [], example: null, claim: false }]);
  assert.deepEqual(readManifest(v3Text({ ...EXAMPLE, programs: [{ name: "a", path: "a", afterUpdate: [["skills", "refresh"], ["x"]] }] })).manifest.programs[0].afterUpdate, [["skills", "refresh"], ["x"]]);
  assert.ok(readManifest(v3Text({ ...EXAMPLE, programs: [{ name: "Ardia", path: "bin/ardia" }] })).problems.some((p) => p.includes("programs[0].name")));
  for (const path of ["/usr/bin/true", "../escape", ""]) assert.ok(readManifest(v3Text({ ...EXAMPLE, programs: [{ name: "a", path }] })).problems.some((p) => p.includes("programs[0].path")), path);
  assert.ok(readManifest(v3Text({ ...EXAMPLE, programs: [{ name: "a", path: "a" }, { name: "a", path: "b" }] })).problems.some((p) => p.includes("two programs named a")));
});

const PASSWORD_FIXTURE = readFileSync(new URL("../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");

test("a password manager declares how it fills, which fields get the key, and what else it offers", () => {
  const { manifest, problems: found } = readManifest(PASSWORD_FIXTURE);
  assert.deepEqual(found, []);
  assert.deepEqual(manifest.passwordManager, { fill: "system", fields: ["login", "oneTimeCode"], verificationCodeSetup: "system", passkeys: "system" });
  const doc = JSON.parse(PASSWORD_FIXTURE);
  doc.contributes.passwordManager = { fill: "system", fields: ["oneTimeCode"] };
  assert.deepEqual(readManifest(JSON.stringify(doc)).manifest.passwordManager, { fill: "system", fields: ["oneTimeCode"], verificationCodeSetup: null, passkeys: null });
  assert.equal(readManifest(FIXTURE).manifest.passwordManager, null);
  doc.contributes.passwordManager = { fill: "tool", fields: ["login"] };
  assert.ok(readManifest(JSON.stringify(doc)).problems.length > 0);
});

const { parseWhen, evaluateWhen, whenHolds, globMatches } = await import("./pluginWhen.ts");
const { matchesAllowedHost, hostPatternProblem, hostPatternCovers } = await import("./pluginNetwork.ts");
const { missingPermissions, NO_PERMISSIONS } = await import("./pluginPermissions.ts");
const { buildPluginThemeCss, cssRoleValue } = await import("./pluginThemeCss.ts");
const { checkPluginNode, toolbarUpdateOf, quickPickItemsOf, NODE_LIMITS } = await import("./pluginNodes.ts");

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
