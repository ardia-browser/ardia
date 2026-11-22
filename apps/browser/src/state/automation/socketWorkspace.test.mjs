import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { schemaProblem } = await import("./socketSchema.ts");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-workspace-test");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function controlOn() {
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
}

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 9, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 9); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 9);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

async function setup() {
  S().hydrate({});
  await controlOn();
  const windowId = S().createWindow({ url: "https://a.example/" });
  const a = S().windows[windowId].activeTabIds[S().windows[windowId].profileId];
  const b = S().newTab(windowId, { url: "https://b.example/", background: true });
  const c = S().newTab(windowId, { url: "https://c.example/", background: true });
  return { windowId, a, b, c };
}

test("methods lists every method once with a schema, and the core ones are in it", async () => {
  await setup();
  const list = await ok("methods");
  const names = list.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ["hello", "apply", "run", "windows", "methods", "tabs.list", "windows.create", "profiles.list", "splits.create", "peek.open"]) assert.ok(names.includes(name), name);
  for (const m of list) {
    assert.equal(typeof m.description, "string");
    assert.equal(typeof m.mutates, "boolean");
    assert.equal(m.params.type, "object", m.name);
    assert.equal(m.area, m.name.split(".")[0]);
  }
  assert.equal(list.find((m) => m.name === "tabs.list").mutates, false);
  assert.equal(list.find((m) => m.name === "tabs.navigate").mutates, true);
  assert.equal((await call("methods", { x: 1 })).error.code, "bad_request");
});

test("params are checked against the schema before anything runs", async () => {
  const { a } = await setup();
  assert.match((await call("tabs.get", {})).error.message, /tab is required/i);
  assert.match((await call("tabs.get", { tab: 3 })).error.message, /tab must be a string/);
  assert.match((await call("tabs.get", { tab: a, extra: true })).error.message, /takes no extra/);
  assert.equal((await call("splits.create", { tabs: [a], orientation: "diagonal" })).error.code, "bad_request");
  assert.equal((await call("tabs.get", { tab: "nope" })).error.code, "no_window");
  assert.equal((await call("nope.nothing")).error.code, "unknown_method");
  assert.equal(schemaProblem({ type: "integer", minimum: 1 }, 0, "n"), "n must be at least 1.");
  assert.equal(schemaProblem({ type: ["string", "null"] }, null, "n"), null);
});

test("tabs: list, get, navigate refuses script URLs, duplicate, pinned home", async () => {
  const { windowId, a, b } = await setup();
  const list = await ok("tabs.list", { window: windowId });
  assert.deepEqual(list.map((t) => t.id), S().windows[windowId].tabIds);
  const row = await ok("tabs.get", { tab: b });
  assert.equal(row.url, "https://b.example/");
  assert.equal(row.window, windowId);
  assert.equal(row.pinned, null);
  assert.equal((await call("tabs.navigate", { tab: b, url: "javascript:alert(1)" })).error.code, "refused");
  await ok("tabs.navigate", { tab: b, url: "https://d.example/x" });
  assert.equal(S().tabs[b].page.nav?.url, "https://d.example/x");
  const copy = await ok("tabs.duplicate", { tab: a });
  assert.notEqual(copy.id, a);
  assert.equal(S().tabs[copy.id].windowId, windowId);
  assert.equal((await call("tabs.setPinnedUrl", { tab: a })).error.code, "bad_request");
  S().pinTabs([a], true, true);
  await ok("tabs.setPinnedUrl", { tab: a, url: "https://home.example/" });
  assert.equal(S().tabs[a].pinnedUrl, "https://home.example/");
});

test("closed: a closed tab is listed and comes back", async () => {
  const { c } = await setup();
  S().closeTabs([c]);
  const closed = await ok("closed.list");
  const entry = closed.find((e) => e.kind === "tab" && e.url === "https://c.example/");
  assert.ok(entry);
  const back = await ok("closed.restore", { id: entry.id });
  assert.equal(back.tabs.length, 1);
  assert.equal(S().tabs[back.tabs[0]].url, "https://c.example/");
  await ok("closed.clear");
  assert.equal((await ok("closed.list")).length, 0);
});

test("windows: create, get, layout, switch profile, close", async () => {
  await setup();
  const made = await ok("windows.create", { url: "https://w.example/", layout: "top" });
  assert.equal(made.layout, "top");
  assert.equal(S().tabs[made.activeTab].url, "https://w.example/");
  const shown = await ok("windows.setLayout", { window: made.id, layout: "sidebar", tabsShown: false });
  assert.deepEqual([shown.layout, shown.tabsShown], ["sidebar", false]);
  const work = await ok("profiles.create", { name: "Work", color: "blue" });
  const switched = await ok("windows.switchProfile", { window: made.id, profile: work.id });
  assert.equal(switched.profile, work.id);
  assert.equal((await call("windows.create", { url: "chrome://flags" })).error.code, "refused");
  S().updateSettings({ warnBeforeClosingWindow: false });
  await ok("windows.close", { window: made.id });
  for (let i = 0; i < 50 && S().windows[made.id]; i++) await tick();
  assert.equal(S().windows[made.id], undefined);
  assert.equal((await call("windows.get", { window: made.id })).error.code, "no_window");
});

test("profiles: create, update, look, reorder, default", async () => {
  await setup();
  const work = await ok("profiles.create", { name: "Work", icon: "💼" });
  const home = await ok("profiles.create", { name: "Home" });
  assert.equal((await ok("profiles.update", { profile: work.id, name: "Job", syncTabs: true })).name, "Job");
  assert.equal(S().profiles[work.id].syncTabs, true);
  const look = await ok("profiles.setLook", { profile: home.id, color: "green", theme: "#3366cc" });
  assert.equal(look.color, "green");
  assert.ok(S().profiles[home.id].theme);
  const greenEdit = S().profiles[home.id].theme;
  await ok("profiles.setLook", { profile: home.id, color: "blue" });
  assert.equal(S().profiles[home.id].theme, null, "another colour shows plain until it's edited");
  await ok("profiles.setLook", { profile: home.id, color: "green" });
  assert.deepEqual(S().profiles[home.id].theme, greenEdit, "switching back brings green's edit back");
  assert.deepEqual(S().profiles[home.id].presetThemes, { green: greenEdit }, "the command line's edit is this Mac's own look of green, as the picker's would be");
  await ok("profiles.setLook", { profile: home.id, theme: null });
  assert.equal(S().profiles[home.id].theme ?? null, null);
  const order = S().profileOrder.slice().reverse();
  await ok("profiles.reorder", { profiles: order });
  assert.deepEqual(S().profileOrder, order);
  assert.equal((await call("profiles.reorder", { profiles: [work.id] })).error.code, "bad_request");
  assert.equal((await ok("profiles.setDefault", { profile: work.id })).default, true);
  assert.equal(S().settings.defaultProfileId, work.id);
  assert.equal((await call("profiles.update", { profile: "nope", name: "x" })).error.code, "no_window");
});

test("splits and peek", async () => {
  const { windowId, a, b, c } = await setup();
  const split = await ok("splits.create", { tabs: [a, b] });
  assert.deepEqual(split.tabs, [a, b]);
  assert.equal((await ok("splits.list", { window: windowId })).length, 1);
  const vertical = await ok("splits.setOrientation", { split: split.id, orientation: "vertical" });
  assert.equal(vertical.orientation, "vertical");
  const sized = await ok("splits.resize", { split: split.id, sizes: [3, 1] });
  assert.deepEqual(sized.panes.map((p) => p.size), [0.75, 0.25]);
  assert.equal((await call("splits.create", { tabs: [a, c] })).error.code, "bad_request");
  await ok("splits.separate", { split: split.id });
  assert.equal(S().splits[split.id], undefined);
  const peek = await ok("peek.open", { tab: c, url: "https://peek.example/" });
  assert.equal((await ok("peek.list"))[0].tab, peek.tab);
  assert.equal((await call("tabs.get", { tab: peek.tab })).error.code, "no_window");
  await ok("peek.close", { tab: c });
  assert.equal(S().peeks[c], undefined);
});

test("each call counts in its method family, errors once more", async () => {
  const { a } = await setup();
  takeCliCounts();
  await ok("tabs.get", { tab: a });
  await call("tabs.get", { tab: "nope" });
  await ok("profiles.list");
  await ok("methods");
  const counts = takeCliCounts();
  assert.equal(counts.cli_socket_calls_tabs, 2);
  assert.equal(counts.cli_socket_calls_profiles, 1);
  assert.equal(counts.cli_socket_calls_core, 1);
  assert.equal(counts.cli_socket_call_failures, 1);
});
