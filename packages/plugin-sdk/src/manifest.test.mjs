import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareVersions, formatSemver, isRange, maxSatisfying, parseRange, parseSemver, satisfies, sortVersions } from "./semver.ts";
import { generateManifestV3JsonSchema, manifestV3SchemaJson, normalizeShortcut, parseManifestV3Json, permissionGrants, validateManifestV3 } from "./manifest.ts";
import { patternCovers, urlMatches } from "./matchPatterns.ts";

describe("semver", () => {
  test("parses strict versions and refuses loose ones", () => {
    assert.deepEqual(parseSemver("1.2.3-beta.4"), { major: 1, minor: 2, patch: 3, prerelease: ["beta", 4] });
    for (const bad of ["1.2", "01.2.3", "1.2.3-", "v1.2.3", "1.2.3-01", " 1.2.3", "1.2.3.4", "", null, 3, "1.2.3+build.5", "1.0.0-rc.1+x", "1000000000.0.0", "1.2.3-1000000000"]) assert.equal(parseSemver(bad), null, String(bad));
    assert.equal(formatSemver(parseSemver("1.0.0-rc.1")), "1.0.0-rc.1");
    assert.deepEqual(parseSemver("999999999.999999999.999999999"), { major: 999999999, minor: 999999999, patch: 999999999, prerelease: [] });
  });

  test("orders versions the way semver 2.0.0 does", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
    for (let i = 1; i < order.length; i++) assert.equal(compareVersions(order[i - 1], order[i]), -1, `${order[i - 1]} < ${order[i]}`);
    assert.deepEqual(sortVersions(["2.0.0", "bad", "1.0.0", "1.0.0-rc.1"], "desc"), ["2.0.0", "1.0.0", "1.0.0-rc.1"]);
    assert.throws(() => compareVersions("1", "2"));
  });

  const cases = [
    ["^1.2.3", ["1.2.3", "1.9.9"], ["2.0.0", "1.2.2", "2.0.0-0"]],
    ["^0.2.3", ["0.2.3", "0.2.9"], ["0.3.0", "0.2.2"]],
    ["^0.0.3", ["0.0.3"], ["0.0.4", "0.0.2"]],
    ["^1.x", ["1.0.0", "1.5.0"], ["2.0.0"]],
    ["~1.2.3", ["1.2.3", "1.2.9"], ["1.3.0"]],
    ["~1", ["1.0.0", "1.9.0"], ["2.0.0"]],
    [">=1.2.0 <2.0.0", ["1.2.0", "1.99.0"], ["2.0.0", "1.1.9"]],
    [">1.2", ["1.3.0"], ["1.2.9", "1.2.0"]],
    ["<=1.2", ["1.2.9", "1.0.0"], ["1.3.0"]],
    ["<1.2", ["1.1.9"], ["1.2.0"]],
    ["1.2.x || >=3.0.0", ["1.2.5", "3.1.0"], ["2.0.0", "1.3.0"]],
    ["*", ["0.0.1", "99.0.0"], ["1.0.0-beta"]],
    ["", ["1.0.0"], []],
    ["=1.2.3", ["1.2.3"], ["1.2.4"]],
    ["0.3.0", ["0.3.0", "0.4.0", "1.0.0"], ["0.2.9"]],
    ["1.2", ["1.2.0", "2.0.0"], ["1.1.0"]],
    ["1.x", ["1.0.0", "1.9.0"], ["2.0.0"]],
    ["1.2.3 - 2.3.4", ["1.2.3", "2.3.4"], ["2.3.5"]],
    [">=1.0.0-beta.2 <1.0.0", ["1.0.0-beta.3", "1.0.0-rc.1"], ["1.0.0-beta.1", "1.0.1-beta.1"]],
  ];
  for (const [range, yes, no] of cases) {
    test(`range ${JSON.stringify(range)}`, () => {
      assert.ok(isRange(range));
      for (const v of yes) assert.equal(satisfies(v, range), true, `${v} in ${range}`);
      for (const v of no) assert.equal(satisfies(v, range), false, `${v} not in ${range}`);
    });
  }

  test("prereleases match only a comparator on the same tuple, unless asked", () => {
    assert.equal(satisfies("1.2.4-beta", ">=1.2.3"), false);
    assert.equal(satisfies("1.2.4-beta", ">=1.2.3", { includePrerelease: true }), true);
    assert.equal(satisfies("1.2.3-beta.5", "^1.2.3-beta.2"), true);
    assert.equal(maxSatisfying(["1.0.0", "1.5.0", "2.0.0", "1.6.0-beta"], "^1.0.0"), "1.5.0");
  });

  test("ranges at the top of the number cap stay bounded instead of matching everything", () => {
    assert.equal(satisfies("999999999.5.0", "^999999999.0.0"), true);
    assert.equal(satisfies("0.0.1", "^999999999.0.0"), false);
    assert.equal(satisfies("999999999.999999999.0", "~999999999.999999999.0"), true);
    assert.equal(satisfies("1.0.0", "~999999999.999999999.0"), false);
    assert.equal(parseRange("^9999999999.0.0"), null);
    assert.equal(parseRange(">=1.0.0+build"), null);
  });

  test("refuses ranges that aren't ranges", () => {
    for (const bad of ["^", ">=a", "1.2.3.4", "~>", "x.1", "1.2.3-beta - ", "\n1.0.0"]) assert.equal(parseRange(bad), null, bad);
  });
});

const base = { manifest: 3, id: "@acme/hello", name: "Hello", description: "Says hi", version: "1.0.0", engines: { ardia: ">=0.3.0" } };
const ok = (extra) => {
  const result = validateManifestV3({ ...base, ...extra });
  assert.deepEqual(result.ok ? [] : result.problems, []);
  return result.manifest;
};
const problems = (extra) => {
  const result = validateManifestV3({ ...base, ...extra });
  assert.equal(result.ok, false, "it should fail");
  return result.problems;
};

describe("manifest v3", () => {
  test("a minimal manifest passes and fills in its defaults", () => {
    const manifest = ok({});
    assert.equal(manifest.scope, "profile");
    assert.equal(manifest.idleTimeoutSec, 300);
  });

  test("refuses unknown keys, with the path", () => {
    assert.deepEqual(problems({ bogus: 1 }), ["bogus isn't a key of a plugin manifest"]);
    assert.deepEqual(problems({ permissions: { tabz: true } }), ["permissions.tabz isn't a key of permissions"]);
    assert.deepEqual(problems({ contributes: { commands: [{ name: "a", title: "A", extra: 1 }] } }), ["contributes.commands[0].extra isn't a key of contributes.commands[0]"]);
  });

  test("checks identity fields", () => {
    assert.deepEqual(problems({ id: "hello" }), ["id must be a scoped plugin id like @scope/name: lowercase letters, digits and dashes"]);
    assert.deepEqual(problems({ id: "@Acme/hello" }).length, 1);
    assert.deepEqual(problems({ version: "1.0" }), ["version must be a semver version like 1.2.3"]);
    assert.deepEqual(problems({ name: "bad‮name" }), ["name has control or direction characters"]);
    assert.deepEqual(problems({ name: "x".repeat(61) }), ["name must be text of 1 to 60 characters"]);
    assert.deepEqual(problems({ engines: { ardia: "nope" } }), ["engines.ardia must be a semver range like ^1.2.0 or >=0.3.0 <1.0.0"]);
    assert.deepEqual(problems({ engines: {} }), ["engines.ardia is required"]);
    assert.deepEqual(problems({ repository: "http://github.com/a/b" }), ["repository must be an https:// URL"]);
    assert.deepEqual(problems({ categories: ["a", "b", "c", "d", "e", "f", "g"] }), ["categories must be a list of at most 6"]);
    assert.deepEqual(validateManifestV3({ ...base, manifest: 2 }).problems, ["manifest must be 3"]);
    assert.deepEqual(validateManifestV3([]).problems, ["The manifest must be a JSON object"]);
    assert.match(parseManifestV3Json("{").problems[0], /^plugin\.json isn't JSON/);
  });

  test("dependencies are scoped ids with ranges, never the plugin itself", () => {
    ok({ dependencies: { "@acme/ai": "^1.0.0" }, optionalDependencies: { "@acme/extra": "0.3.0" } });
    assert.deepEqual(problems({ dependencies: { "@acme/hello": "^1.0.0" } }), ["dependencies.@acme/hello: a plugin can't depend on itself"]);
    assert.deepEqual(problems({ dependencies: { ai: "^1.0.0" } }), ["dependencies.ai: ai must be a scoped plugin id like @scope/name"]);
    assert.deepEqual(problems({ dependencies: { "@a/b": "^1" }, optionalDependencies: { "@a/b": "^1" } }), ["optionalDependencies.@a/b is already in dependencies"]);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`@a/p${i}`, "*"]));
    assert.deepEqual(problems({ dependencies: many }), ["dependencies must have at most 16 entries"]);
  });

  test("provides and consumes interface names", () => {
    ok({ provides: ["ai.provider"], consumes: ["credentials.provider", "search.provider"] });
    assert.equal(problems({ provides: ["ai"] }).length, 1);
    assert.equal(problems({ provides: ["ai.provider", "ai.provider"] })[0], 'provides lists "ai.provider" twice');
  });

  test("main, sidecar and programs may all be declared together, and programs force global scope", () => {
    const manifest = ok({ main: "dist/index.js", sidecar: { run: ["bin/server"], memoryMB: 512 }, contributes: { programs: [{ name: "hello", path: "bin/hello" }] } });
    assert.equal(manifest.scope, "global");
    assert.deepEqual(problems({ scope: "profile", permissions: { control: true } }), ['scope must be "global" when the plugin declares contributes.programs or permissions.control']);
    assert.equal(ok({ permissions: { control: true } }).scope, "global");
  });

  test("relative paths never take a drive letter, a backslash or a way out", () => {
    for (const bad of ["C:/x.js", "c:x.js", "C:\\x.js", "a/../b.js", "./a.js", "a//b.js", "/abs.js"]) assert.equal(problems({ main: bad }).length, 1, bad);
    assert.equal(problems({ contributes: { netRules: "D:/rules.json" } }).length, 1);
    const schema = generateManifestV3JsonSchema();
    const main = new RegExp(schema.properties.main.pattern, "u");
    assert.equal(main.test("C:/x.js"), false);
    assert.equal(main.test("dist/index.js"), true);
  });

  test("paths with line breaks or control characters are refused by the validator and the schema alike", () => {
    for (const bad of ["dist/a\n.js", "dist/\r.js", "bin/\u0007x", "bin/x\u007f"]) {
      assert.equal(problems({ main: bad.endsWith(".js") ? bad : `${bad}.js` }).length, 1, JSON.stringify(bad));
      assert.equal(problems({ sidecar: { run: [bad] } }).length, 1, JSON.stringify(bad));
    }
    const schema = generateManifestV3JsonSchema();
    const program = new RegExp(schema.properties.sidecar.properties.run.prefixItems[0].pattern, "u");
    const main = new RegExp(schema.properties.main.pattern, "u");
    for (const bad of ["bin/x\n", "bin\n/x", "\nbin", "a\r", "a\u0001"]) assert.equal(program.test(bad), false, JSON.stringify(bad));
    assert.equal(main.test("dist/a\n/../x.js"), false);
    assert.equal(main.test("dist/index.js"), true);
  });

  test("sidecar.run[0] is a program inside the plugin's folder", () => {
    ok({ sidecar: { run: ["bin/server", "--port", "0"] } });
    ok({ sidecar: { run: ["server"] } });
    for (const bad of ["/usr/bin/env", "../bin/x", "C:\\tools\\x.exe", "D:/x", "bin/../../x", "bin/"]) assert.equal(problems({ sidecar: { run: [bad] } })[0], "sidecar.run[0] must be a program inside the plugin's folder, as a relative path like bin/server", bad);
    assert.equal(problems({ sidecar: { run: ["bin/s", "a\u0000b"] } })[0], "sidecar.run[1] must be an argument of 1 to 1024 characters with no NUL");
    assert.deepEqual(problems({ sidecar: { run: [] } }), ["sidecar.run must be a list of 1 to 32"]);
    const run = generateManifestV3JsonSchema().properties.sidecar.properties.run;
    assert.equal(new RegExp(run.prefixItems[0].pattern, "u").test("/usr/bin/env"), false);
    assert.equal(new RegExp(run.prefixItems[0].pattern, "u").test("bin/"), false);
    assert.equal(new RegExp(run.prefixItems[0].pattern, "u").test("bin/server"), true);
  });

  test("icon is an SF Symbol; iconUrl is an https image", () => {
    ok({ icon: "sparkles", iconUrl: "https://example.com/icon.png" });
    assert.equal(problems({ icon: "https://example.com/i.png" })[0], "icon must be an SF Symbol name");
    assert.equal(problems({ iconUrl: "http://example.com/i.png" })[0], "iconUrl must be an https:// URL");
  });

  test("runtime bounds and paths", () => {
    assert.deepEqual(problems({ main: "../index.js" }), ["main must be a relative .js, .mjs or .cjs file inside the plugin's folder"]);
    assert.deepEqual(problems({ main: "dist/index.ts" }), ["main must be a relative .js, .mjs or .cjs file inside the plugin's folder"]);
    assert.deepEqual(problems({ main: "/abs.js" }).length, 1);
    assert.deepEqual(problems({ main: "a.js", idleTimeoutSec: 10 }), ["idleTimeoutSec must be a whole number from 30 to 1800"]);
    assert.deepEqual(problems({ sidecar: { run: ["x"], memoryMB: 9000 } }), ["sidecar.memoryMB must be a whole number from 64 to 4096"]);
    assert.deepEqual(problems({ memoryMB: 256 }), ["memoryMB is main's memory limit; set sidecar.memoryMB for a sidecar"]);
    assert.deepEqual(problems({ activationEvents: ["onCommand:go"] }), ["activationEvents need main or sidecar"]);
    assert.equal(problems({ main: "a.js", activationEvents: ["onWhatever:x"] }).length, 1);
    ok({ main: "a.mjs", activationEvents: ["onService:ai.provider", "onInputMode:ask", "onStartupFinished"] });
  });

  test("permissions and their prerequisites", () => {
    ok({ permissions: { tabs: "write", fullUrls: true, workspace: true, bookmarks: "write", history: "read", downloads: "read", media: "control", profiles: "read", clipboard: "read", notifications: true, files: "picker", commands: true, storage: true, secrets: true } });
    assert.deepEqual(problems({ permissions: { fullUrls: true } }), ["permissions.fullUrls needs permissions.tabs"]);
    assert.deepEqual(problems({ permissions: { tabs: "read", fullUrls: true, workspace: true } }), ['permissions.workspace needs permissions.tabs: "write" and permissions.fullUrls']);
    ok({ permissions: { activePage: { read: true, screenshot: true } } });
    assert.deepEqual(problems({ permissions: { activePage: { multiTab: true } } }), ["permissions.activePage.multiTab needs permissions.tabs"]);
    assert.deepEqual(problems({ permissions: { activePage: "yes" } }), ["permissions.activePage must be true, false or an object with read, screenshot and multiTab"]);
    assert.deepEqual(problems({ permissions: { activePage: { read: true, other: 1 } } }), ["permissions.activePage.other isn't a key of permissions.activePage"]);
    assert.deepEqual(problems({ permissions: { history: "write" } }), ['permissions.history must be one of false, "read"']);
  });

  test("network takes hosts, wildcards and explicit loopback ports", () => {
    ok({ permissions: { network: ["api.example.com", "*.example.org", "localhost:8080", "127.0.0.1:11434"] } });
    ok({ permissions: { network: "*" } });
    for (const bad of ["localhost", "http://x.com", "*.com", "localhost:0", "localhost:65536", "localhost:70000", "x.com:443", "2130706433", "0x7f000001", "127.0.0.2", "10.0.0.1", "127.0.0.1", "0x7f.0x0.0x0.0x1", "017700000001", "192.168.1.1:80"]) assert.equal(problems({ permissions: { network: [bad] } }).length, 1, bad);
    ok({ permissions: { network: ["localhost:1", "127.0.0.1:65535"] } });
    for (const bad of ["https://127.0.0.2/*", "https://10.0.0.1/*", "https://2130706433/*", "http://localhost:0/*", "http://localhost:65536/*", "http://127.0.0.2:80/*", "https://0x7f.0x1/*"]) assert.equal(problems({ permissions: { pages: [bad] } }).length, 1, bad);
    const schema = generateManifestV3JsonSchema();
    const hosts = new RegExp(schema.properties.permissions.properties.network.anyOf[1].items.pattern, "u");
    assert.equal(hosts.test("localhost:65535"), true);
    assert.equal(hosts.test("localhost:65536"), false);
    assert.equal(hosts.test("127.0.0.2"), false);
    assert.equal(problems({ permissions: { network: [] } })[0], "permissions.network must be a list of 1 to 32");
    assert.equal(problems({ permissions: { network: true } })[0], 'permissions.network must be false, "*" or a list of 1 to 32 hosts');
  });

  test("state events and intents need the permissions behind them", () => {
    ok({ permissions: { tabs: "write", media: "read", profiles: "read", state: { events: ["tabs", "navigation", "media", "profiles"], intents: ["tabs.group", "splits.open", "peek.open"] } } });
    assert.deepEqual(problems({ permissions: { state: { events: ["tabs"] } } }), ["permissions.state.events[0]: tabs events need permissions.tabs"]);
    assert.deepEqual(problems({ permissions: { tabs: "read", state: { intents: ["tabs.pin"] } } }), ['permissions.state.intents need permissions.tabs: "write"']);
    assert.deepEqual(problems({ permissions: { state: { events: ["media"] } } }), ["permissions.state.events[0]: media events need permissions.media"]);
    assert.equal(problems({ permissions: { tabs: "write", state: { intents: ["tabs.explode"] } } }).length, 1);
  });

  test("page styles and content scripts must be covered by permissions.pages", () => {
    const pages = ["https://*.github.com/*", "http://localhost:*/*"];
    ok({
      permissions: { pages },
      contributes: {
        pageStyles: [{ id: "dark", matches: ["https://gist.github.com/*"], css: "styles/dark.css" }],
        contentScripts: [{ id: "c", matches: ["https://github.com/*/pulls", "http://localhost:*/*"], js: ["dist/content.js"], runAt: "document_start" }],
      },
    });
    assert.deepEqual(problems({ contributes: { pageStyles: [{ id: "x", matches: ["https://a.com/*"], css: "a.css" }] } }), ["contributes.pageStyles[0].matches[0]: https://a.com/* isn't covered by permissions.pages"]);
    assert.deepEqual(problems({ permissions: { pages }, contributes: { contentScripts: [{ id: "c", matches: ["https://gitlab.com/*"], js: ["c.js"] }] } }), [
      "contributes.contentScripts[0].matches[0]: https://gitlab.com/* isn't covered by permissions.pages",
    ]);
    assert.equal(problems({ permissions: { pages: ["file:///*"] } }).length, 1);
    assert.equal(problems({ permissions: { pages: ["https://*/*"] }, contributes: { contentScripts: [{ id: "c", matches: ["https://a.com/*"], js: ["c.ts"] }] } }).length, 1);
    const defaults = ok({ permissions: { pages: ["https://*/*"] }, contributes: { contentScripts: [{ id: "c", matches: ["https://a.com/*"], js: ["c.js"] }] } });
    assert.equal(defaults.contributes.contentScripts[0].runAt, "document_idle");
  });

  test("commands, shortcuts, input modes and menus", () => {
    ok({
      main: "dist/index.js",
      contributes: {
        commands: [
          { name: "ask", title: "Ask", shortcut: "cmd+shift+k", inputMode: "ask" },
          { name: "go", title: "Go", handler: true, shortcut: "Ctrl+Opt+G" },
        ],
        inputModes: [{ id: "ask", title: "Ask AI", placeholder: "Ask anything", icon: "sparkles" }],
        menus: { selection: [{ command: "ask" }], link: [{ command: "go" }], image: [{ command: "go" }], page: [{ command: "ask" }] },
      },
    });
    assert.equal(normalizeShortcut("Shift+Cmd+K"), "cmd+shift+k");
    for (const bad of ["k", "shift+k", "cmd+q", "cmd+c", "cmd+cmd+k", "cmd+", "hyper+k"]) assert.equal(normalizeShortcut(bad), null, bad);
    assert.equal(normalizeShortcut("f5"), "f5");
    assert.deepEqual(problems({ main: "a.js", contributes: { commands: [{ name: "a", title: "A", inputMode: "nope" }] } }), ["contributes.commands[0].inputMode: there's no input mode named nope"]);
    assert.deepEqual(problems({ main: "a.js", contributes: { menus: { tab: [{ command: "missing" }] } } }), ["contributes.menus.tab[0].command: there's no command named missing"]);
    assert.deepEqual(problems({ main: "a.js", contributes: { menus: { sidebar: [] } } }), ["contributes.menus.sidebar isn't a key of contributes.menus"]);
    assert.deepEqual(problems({ main: "a.js", contributes: { commands: [{ name: "a", title: "A" }, { name: "a", title: "B" }] } }), ["contributes.commands has two commands named a"]);
    assert.deepEqual(problems({ contributes: { inputModes: [{ id: "a", title: "A" }] } }), ["contributes: inputModes need main, which renders them"]);
    assert.equal(problems({ main: "a.js", contributes: { inputModes: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, title: "M" })) } })[0], "contributes.inputModes must be a list of at most 4");
    assert.deepEqual(problems({ main: "a.js", contributes: { commands: [{ name: "a", title: "A", view: "v", handler: true }] } }), ["contributes.commands[0] must do one thing: it has view and handler"]);
  });

  test("panels, themes, net rules, page bar and settings rows", () => {
    ok({
      main: "dist/index.js",
      contributes: {
        panels: [
          { id: "side", title: "Side", mode: "sidecar", view: "side" },
          { id: "split", title: "Split", mode: "split", file: "ui/index.html", side: "left" },
        ],
        netRules: "rules/block.json",
        themes: [{ id: "t", title: "Theme", file: "themes/t.json" }],
        siteSwitches: [{ key: "dev", title: "Dev bar" }],
        pageBar: { look: "stripes", when: { siteSwitch: "dev", localAddresses: "local" }, buttons: ["console", "|", "network"] },
        settings: { rows: [{ key: "local", title: "Local", type: "toggle", default: true }, { key: "side", title: "Side", type: "choice", default: "left", choices: [{ value: "left", title: "Left" }, { value: "right", title: "Right" }] }] },
        tools: [{ name: "search", title: "Search", timeout: 60 }],
      },
      telemetry: { title: "Counts", items: ["How often search runs"] },
    });
    assert.deepEqual(problems({ main: "a.js", contributes: { panels: [{ id: "p", title: "P", mode: "tab" }] } }), ["contributes.panels[0] needs exactly one of file and view"]);
    assert.deepEqual(problems({ contributes: { netRules: "rules.txt" } }), ["contributes.netRules must be a relative .json file inside the plugin's folder"]);
    assert.deepEqual(problems({ contributes: { pageBar: { look: "stripes", when: { siteSwitch: "x" }, buttons: ["console"] } } }), ["contributes.pageBar.when.siteSwitch: there's no site switch named x"]);
    assert.deepEqual(problems({ contributes: { settings: { rows: [{ key: "c", title: "C", type: "choice", default: "z", choices: [{ value: "a", title: "A" }, { value: "b", title: "B" }] }] } } }), ["contributes.settings.rows[0].default must be one of its choices"]);
    assert.deepEqual(problems({ contributes: { tools: [{ name: "t", title: "T" }] } }), ["contributes: tools need main or sidecar"]);
    assert.equal(ok({ sidecar: { run: ["bin/s"] }, contributes: { tools: [{ name: "t", title: "T" }] } }).contributes.tools[0].timeout, 30);
  });

  test("release names a GitHub repository and per-platform assets", () => {
    ok({ release: { github: "acme/hello", tagPrefix: "v", asset: "hello-{version}.tar.gz", assets: { "macos-arm64": "hello-mac.tar.gz", universal: "hello.tar.gz" } } });
    assert.deepEqual(problems({ release: { github: "not a repo" } }), ["release.github must be a GitHub repository like owner/repo"]);
    assert.deepEqual(problems({ release: { github: "a/b", assets: { "beos-x86": "x" } } }), ["release.assets.beos-x86 isn't a key of release.assets"]);
  });

  test("permissionGrants lists what a manifest asks for, flattened", () => {
    assert.deepEqual(permissionGrants({ tabs: "write", network: ["a.com"], activePage: true, state: { events: ["tabs"] } }), ["activePage:read", "network:a.com", "state.events:tabs", "tabs:read", "tabs:write"]);
  });
});

describe("match patterns", () => {
  test("cover and match", () => {
    assert.equal(patternCovers("https://*.github.com/*", "https://github.com/a/*"), true);
    assert.equal(patternCovers("https://*.github.com/*", "https://api.github.com/x"), true);
    assert.equal(patternCovers("https://github.com/a/*", "https://github.com/*"), false);
    assert.equal(patternCovers("http://localhost:*/*", "http://localhost:3000/app"), true);
    assert.equal(patternCovers("http://localhost:3000/*", "http://localhost:4000/*"), false);
    assert.equal(urlMatches("https://*.example.com/docs*", "https://www.example.com/docs/intro?x=1"), true);
    assert.equal(urlMatches("https://example.com/*", "http://example.com/"), false);
  });
});

describe("JSON schema", () => {
  const committed = fileURLToPath(new URL("../../../docs/plugin.v3.schema.json", import.meta.url));

  test("docs/plugin.v3.schema.json is what write-schema.mjs makes today", () => {
    assert.equal(readFileSync(committed, "utf8"), manifestV3SchemaJson(), "run node packages/plugin-sdk/scripts/write-schema.mjs and commit docs/plugin.v3.schema.json");
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/write-schema.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  });

  test("every pattern compiles as a unicode regular expression and is closed", () => {
    const schema = generateManifestV3JsonSchema();
    const seen = [];
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (typeof node.pattern === "string") seen.push(node.pattern);
      if (node.type === "object" && node.properties) assert.equal(node.additionalProperties, false);
      Object.values(node).forEach(visit);
    };
    visit(schema);
    assert.ok(seen.length > 20);
    for (const pattern of seen) new RegExp(pattern, "u");
    const main = new RegExp(schema.properties.main.pattern, "u");
    assert.equal(main.test("dist/index.js"), true);
    assert.equal(main.test("../index.js"), false);
    assert.equal(main.test("dist/index.ts"), false);
  });
});
