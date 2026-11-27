import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
const { S, socketClient, freshWindow, tick, settingsUi } = await import("./fixtures/socketHarness.mjs");
const { goToSettingsPane, SETTINGS_PANES, useSettingsNav, useShownSettings } = await import("../settings/settingsWindows.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

const appWindows = shellNativeModules.ArdiaAppWindows;
const { windowIds } = appWindows;
const { fire, call, ok } = socketClient(61);
const settingsOpen = async () => (await windowIds()).includes("settings");

after(() => {
  appWindows.windowIds = windowIds;
  Object.assign(settingsUi, { delayMs: 0, unmountDelayMs: 0, shows: true });
  S().updateSettings({ cliControl: false });
});

beforeEach(async () => {
  Object.assign(settingsUi, { delayMs: 0, unmountDelayMs: 0, shows: true });
  appWindows.windowIds = windowIds;
  await freshWindow();
  await appWindows.closeWindow("settings");
  goToSettingsPane("general");
});

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(done, ms = 6000) {
  const deadline = Date.now() + ms;
  while (!(await done()) && Date.now() < deadline) await later(20);
}

async function slowCall(method, params, connection = 63) {
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id: 1, method, params }) });
  await until(() => stub.controlSocket.replies.slice(before).some((r) => r.connection === connection));
  const reply = stub.controlSocket.replies.slice(before).find((r) => r.connection === connection);
  assert.ok(reply, `no reply to ${method}`);
  return JSON.parse(reply.line);
}

test("settings.window says whether Settings is open and which pane it shows", async () => {
  const closed = await ok("settings.window");
  assert.equal(closed.open, false);
  assert.deepEqual(closed.panes, [...SETTINGS_PANES]);
  const opened = await ok("settings.open", { pane: "shortcuts" });
  assert.deepEqual([opened.open, opened.pane], [true, "shortcuts"]);
  assert.deepEqual(await ok("settings.window"), opened);
});

test("settings.open answers only once the Settings window shows the pane, not when navigation merely moved", async () => {
  settingsUi.delayMs = 120;
  const started = Date.now();
  const opened = await ok("settings.open", { pane: "advanced" });
  assert.ok(Date.now() - started >= settingsUi.delayMs, "answered before the window showed the pane");
  assert.equal(opened.pane, "advanced");
  assert.equal(useShownSettings.getState().shown?.pane, "advanced");
});

test("a reopen right after a close waits for the new window, not the old one still unmounting", async () => {
  await ok("settings.open", { pane: "advanced" });
  const oldRoot = useShownSettings.getState().root;
  settingsUi.unmountDelayMs = 200;
  settingsUi.delayMs = 80;
  await ok("settings.close");
  const started = Date.now();
  const reopened = await ok("settings.open", { pane: "advanced" });
  assert.ok(Date.now() - started >= settingsUi.delayMs, "answered from the old window's report");
  assert.equal(reopened.pane, "advanced");
  assert.ok(useShownSettings.getState().root > oldRoot);
  await until(() => Date.now() - started > settingsUi.unmountDelayMs + 20, 1000);
  assert.equal((await ok("settings.window")).pane, "advanced", "the old window's late unmount didn't clear the new one");
});

test("settings.window names no pane while the window is open but hasn't shown one yet", async () => {
  settingsUi.shows = false;
  await slowCall("settings.open", { pane: "tabs" });
  const row = await ok("settings.window");
  assert.deepEqual([row.open, row.pane, row.profile], [true, null, null]);
});

test("settings.open checks its profile again when its turn comes, after an earlier change", async () => {
  const work = S().createProfile({ name: "Work" });
  await ok("settings.open", { pane: "general" });
  settingsUi.unmountDelayMs = 0;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  appWindows.windowIds = () => held.then(() => windowIds());
  const closing = fire("settings.close");
  const opening = socketClient(64).fire("settings.open", { pane: "profiles", profile: work });
  for (let i = 0; i < 5; i++) await tick();
  S().deleteProfile(work);
  release();
  appWindows.windowIds = windowIds;
  await closing;
  const opened = await opening;
  assert.equal(opened.error?.code, "no_window", JSON.stringify(opened));
});

test("settings.open fails when the window opens but never shows the pane", async () => {
  settingsUi.shows = false;
  const reply = await slowCall("settings.open", { pane: "tabs" });
  assert.equal(reply.error?.code, "failed");
  assert.match(reply.error.message, /isn't showing tabs/);
});

test("settings.window follows a pane the person picks in the window", async () => {
  await ok("settings.open", { pane: "general" });
  goToSettingsPane("appearance");
  await until(() => useShownSettings.getState().shown?.pane === "appearance", 1000);
  assert.equal((await ok("settings.window")).pane, "appearance");
});

test("settings.open takes a profile only on the profiles pane, and only a real one", async () => {
  const profile = S().settings.defaultProfileId;
  const shown = await ok("settings.open", { pane: "profiles", profile });
  assert.deepEqual([shown.pane, shown.profile], ["profiles", profile]);
  assert.equal((await call("settings.open", { pane: "general", profile })).error?.code, "bad_request");
  assert.equal((await call("settings.open", { profile })).error?.code, "bad_request");
  assert.equal((await call("settings.open", { pane: "profiles", profile: "nope" })).error?.code, "no_window");
  assert.equal((await call("settings.open", { pane: "secrets" })).error?.code, "bad_request");
  assert.equal(useSettingsNav.getState().pane, "profiles", "a refused call moved nothing");
});

test("settings.open without a pane brings Settings back where it was, page and profile included", async () => {
  const profile = S().settings.defaultProfileId;
  goToSettingsPane("profiles", profile, "sites");
  const backBefore = useSettingsNav.getState().back.length;
  const reopened = await ok("settings.open");
  assert.deepEqual([reopened.open, reopened.pane, reopened.profile, reopened.detail], [true, "profiles", profile, "sites"]);
  assert.equal(useSettingsNav.getState().back.length, backBefore, "no new step in Settings' history");
});

test("settings.close closes the window and answers once it's gone", async () => {
  await ok("settings.open", { pane: "advanced" });
  const closed = await ok("settings.close");
  assert.equal(closed.open, false);
  assert.equal(await settingsOpen(), false);
  assert.equal((await ok("settings.close")).open, false, "closing it again is fine");
});

test("settings.close fails when Ardia can't list its windows, instead of saying it closed", async () => {
  await ok("settings.open", { pane: "advanced" });
  appWindows.windowIds = () => Promise.reject(new Error("gone"));
  assert.equal((await call("settings.close")).error?.code, "failed");
  appWindows.windowIds = windowIds;
  assert.equal(await settingsOpen(), true);
});

test("settings.close closes nothing once control is turned off while it waits", async () => {
  await ok("settings.open", { pane: "advanced" });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  appWindows.windowIds = () => held.then(() => windowIds());
  const reply = fire("settings.close");
  for (let i = 0; i < 5; i++) await tick();
  S().updateSettings({ cliControl: false });
  release();
  await reply.catch(() => null);
  for (let i = 0; i < 20; i++) await tick();
  appWindows.windowIds = windowIds;
  assert.equal(await settingsOpen(), true, "the window stayed open");
});

test("an open and a close sent together run one after the other, so the window ends closed", async () => {
  settingsUi.delayMs = 60;
  const other = socketClient(62);
  const [opened, closed] = await Promise.all([fire("settings.open", { pane: "tabs" }), other.fire("settings.close")]);
  assert.ok(!opened.error, JSON.stringify(opened.error));
  assert.ok(!closed.error, JSON.stringify(closed.error));
  assert.equal(await settingsOpen(), false);
  assert.equal(useShownSettings.getState().shown, null);
});

test("the Settings window calls are refused where Settings can't report what it shows", async () => {
  PLATFORM_FEATURES.settingsWindowControl = false;
  try {
    for (const [method, params] of [["settings.window"], ["settings.open", { pane: "general" }], ["settings.close"]]) {
      assert.equal((await call(method, params)).error?.code, "refused", method);
    }
    assert.equal(await settingsOpen(), false, "nothing opened");
  } finally {
    PLATFORM_FEATURES.settingsWindowControl = true;
  }
});

test("methods lists the Settings window calls", async () => {
  const names = (await ok("methods")).map((m) => m.name);
  for (const name of ["settings.window", "settings.open", "settings.close"]) assert.ok(names.includes(name), name);
});
