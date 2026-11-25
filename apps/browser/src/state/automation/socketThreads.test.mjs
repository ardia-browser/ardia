import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { methodsCatalog } = await import("./socketCatalog.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const { withLivePage } = await import("../tabs/livePage.ts");
const { isAbsoluteFolder } = await import("../../lib/absoluteFolder.ts");
const windowsFolders = await import("../../lib/absoluteFolder.windows.ts");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-threads-test");

after(() => {
  delete globalThis.acTestUserScripts;
  S().updateSettings({ cliControl: false });
});

const { call, ok } = socketClient(291);

test("settings.schema advertises the shortcut format settings.set takes, and that format sets", async () => {
  await freshWindow();
  const shortcuts = (await ok("settings.schema", {})).find((s) => s.key === "shortcuts");
  assert.deepEqual(shortcuts.schema.additionalProperties, { type: "string" });
  await ok("settings.set", { values: { shortcuts: { newTab: "cmd+shift+y" } } });
  assert.ok(S().settings.shortcuts.newTab, "the advertised shape was accepted");
});

test("settings.set takes the switchProfile:<id> and newLittleArdia:<id> shortcuts settings lists, and refuses a profile that doesn't exist", async () => {
  await freshWindow();
  const profile = S().profileOrder[0];
  await ok("settings.set", { values: { shortcuts: { [`switchProfile:${profile}`]: "alt+1", [`newLittleArdia:${profile}`]: "cmd+alt+shift+l" } } });
  assert.deepEqual(S().settings.shortcuts[`switchProfile:${profile}`], ["1", "option"]);
  assert.deepEqual(S().settings.shortcuts[`newLittleArdia:${profile}`], ["l", "option", "shift", "command"]);
  assert.ok(Object.hasOwn((await ok("settings.get", { keys: ["shortcuts"] })).shortcuts, `switchProfile:${profile}`), "settings.get lists what settings.set took");
  await ok("settings.set", { values: { shortcuts: { [`switchProfile:${profile}`]: "ctrl+1" } } });
  assert.equal(S().settings.shortcuts[`switchProfile:${profile}`], undefined, "its default ⌃1 clears the override");
  const missing = await call("settings.set", { values: { shortcuts: { "switchProfile:p-gone": "alt+2" } } });
  assert.equal(missing.error?.code, "bad_request");
  assert.match(missing.error.message, /switchProfile:p-gone names a profile that doesn't exist/);
  S().updateSettings({ shortcuts: {} });
});

test("the legacy Custom engine from customSearchUrl is refused by search.update and search.remove, and nothing changes", async () => {
  await freshWindow();
  S().updateSettings({ customSearchUrl: "https://legacy.example/?q=%s", searchEngine: "custom" });
  for (const [method, params] of [["search.update", { id: "custom", name: "Renamed" }], ["search.remove", { id: "custom" }]]) {
    const reply = await call(method, params);
    assert.equal(reply.error?.code, "refused", method);
  }
  assert.equal(S().settings.customSearchUrl, "https://legacy.example/?q=%s");
  assert.equal(S().settings.searchEngine, "custom", "the default wasn't reset");
  S().updateSettings({ customSearchUrl: "", searchEngine: "google" });
});

test("extensions.reload and extensions.setPinned report a native failure instead of ok", async () => {
  await freshWindow();
  const ext = { id: "abcdefghijklmnopabcdefghijklmnop", name: "Ext", version: "1", enabled: true, state: "ENABLED", mayModify: true, fromWebStore: true, pinned: false, icon: null, description: "" };
  globalThis.acTestUserScripts = { engine: { list: async () => [ext], install: async () => "x", reload: async () => Promise.reject(new Error("reload failed")), uninstall: async () => {} } };
  const change = stub.extensionAnswers.change;
  stub.extensionAnswers.change = async (verb) => {
    if (verb === "configure") throw new Error("configure failed");
  };
  try {
    assert.equal((await call("extensions.reload", { id: ext.id })).error?.code, "failed");
    assert.equal((await call("extensions.setPinned", { id: ext.id, pinned: true })).error?.code, "failed");
  } finally {
    stub.extensionAnswers.change = change;
    delete globalThis.acTestUserScripts;
  }
});

test("download folders: absolute on each platform, relative refused everywhere", () => {
  assert.ok(isAbsoluteFolder("/Users/a/Downloads"));
  assert.ok(!isAbsoluteFolder("Downloads") && !isAbsoluteFolder("C:\\Users\\a\\Downloads"));
  assert.ok(windowsFolders.isAbsoluteFolder("C:\\Users\\Alice\\Downloads"));
  assert.ok(windowsFolders.isAbsoluteFolder("\\\\server\\share\\Downloads"));
  assert.ok(windowsFolders.isAbsoluteFolder("D:/Downloads"));
  assert.ok(!windowsFolders.isAbsoluteFolder("Downloads") && !windowsFolders.isAbsoluteFolder("C:Downloads") && !windowsFolders.isAbsoluteFolder("\\Downloads"));
});

test("splits.create takes two to the most panes a split holds, refused before the handler otherwise", async () => {
  const { windowId } = await freshWindow();
  const tabs = [S().windows[windowId].tabIds[0], ...[1, 2, 3].map((i) => S().newTab(windowId, { url: `https://s${i}.example/`, background: true }))];
  const schema = methodsCatalog().find((m) => m.name === "splits.create").params.properties.tabs;
  assert.equal(schema.minItems, 2);
  assert.equal(schema.maxItems, 3);
  const four = await call("splits.create", { tabs });
  assert.equal(four.error?.code, "bad_request");
  assert.equal((await call("splits.create", { tabs: tabs.slice(0, 1) })).error?.code, "bad_request");
});

test("a read whose reply is too big to send counts as a failure", async () => {
  const { windowId } = await freshWindow();
  for (let i = 0; i < 40; i++) S().newTab(windowId, { url: `https://big${i}.example/?q=${"q".repeat(30_000)}`, background: true });
  takeCliCounts();
  const reply = await call("tabs.list", { window: windowId });
  assert.equal(reply.error?.code, "failed");
  assert.equal(takeCliCounts().cli_socket_call_failures, 1);
});

test("downloads.reveal's description names the platform's file manager, not Finder everywhere", () => {
  const reveal = methodsCatalog().find((m) => m.name === "downloads.reveal");
  assert.match(reveal.description, /Finder/, "macOS says Finder");
  assert.doesNotMatch(reveal.description.replace("Finder", ""), /Finder/);
});

test("tabs.reload reports failed when nothing reloaded, and withLivePage says whether it acted", async () => {
  const { tab } = await freshWindow();
  assert.equal(await withLivePage(tab, () => {}), false, "no view: it didn't act");
  assert.equal((await call("tabs.reload", { tab })).error?.code, "failed");
});

test("history.remove waits for the engine and reports a failed delete", async () => {
  await freshWindow();
  useBrowser.setState({ history: {} });
  const db = stub.chromeHistory("");
  db.clear();
  db.set("https://kept.example/", { title: "Kept", visits: [5] });
  stub.historyDeletes.failNext = true;
  try {
    const reply = await call("history.remove", { urls: ["https://kept.example/"] });
    assert.equal(reply.error?.code, "failed", JSON.stringify(reply));
    assert.ok(db.has("https://kept.example/"));
  } finally {
    stub.historyDeletes.failNext = false;
    db.clear();
    await tick();
  }
});
