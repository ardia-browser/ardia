import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { goToSettingsPane, SETTINGS_PANES, useSettingsNav } = await import("../settings/settingsWindows.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const appWindows = shellNativeModules.ArdiaAppWindows;
const { openWindow, windowIds } = appWindows;
const { fire, call, ok } = socketClient(61);
const settingsOpen = async () => (await windowIds()).includes("settings");

after(() => {
  Object.assign(appWindows, { openWindow, windowIds });
  S().updateSettings({ cliControl: false });
});

beforeEach(async () => {
  Object.assign(appWindows, { openWindow, windowIds });
  await freshWindow();
  await appWindows.closeWindow("settings");
  goToSettingsPane("general");
});

function holdWindowList() {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  appWindows.windowIds = () => held.then(() => windowIds());
  return () => {
    appWindows.windowIds = windowIds;
    release();
  };
}

test("settings.window says whether Settings is open and which pane it's at", async () => {
  const closed = await ok("settings.window");
  assert.equal(closed.open, false);
  assert.deepEqual(closed.panes, [...SETTINGS_PANES]);
  const opened = await ok("settings.open", { pane: "shortcuts" });
  assert.deepEqual([opened.open, opened.pane], [true, "shortcuts"]);
  assert.equal(useSettingsNav.getState().pane, "shortcuts", "the window's own navigation moved");
  assert.deepEqual(await ok("settings.window"), opened);
});

test("settings.open answers only once the native window is there", async () => {
  let finishOpen;
  appWindows.openWindow = (id, options) => new Promise((resolve) => (finishOpen = () => resolve(openWindow(id, options))));
  let answered = false;
  const reply = fire("settings.open", { pane: "advanced" }).then((r) => ((answered = true), r));
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(answered, false, "answered before the window existed");
  finishOpen();
  const opened = await reply;
  assert.deepEqual([opened.result?.open, opened.result?.pane], [true, "advanced"]);
});

test("settings.open fails when the person moves Settings elsewhere while the window opens", async () => {
  let finishOpen;
  appWindows.openWindow = (id, options) => new Promise((resolve) => (finishOpen = () => resolve(openWindow(id, options))));
  const reply = fire("settings.open", { pane: "advanced" });
  for (let i = 0; i < 20 && !finishOpen; i++) await tick();
  goToSettingsPane("appearance");
  finishOpen();
  const answer = await reply;
  assert.equal(answer.error?.code, "failed", JSON.stringify(answer));
  assert.match(answer.error.message, /moved away from advanced/);
});

test("settings.window follows a pane the person picks in the window", async () => {
  await ok("settings.open", { pane: "general" });
  goToSettingsPane("appearance");
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

test("settings.open checks its profile again when its turn comes, after an earlier change", async () => {
  const work = S().createProfile({ name: "Work" });
  await ok("settings.open", { pane: "general" });
  const release = holdWindowList();
  const closing = fire("settings.close");
  const opening = socketClient(64).fire("settings.open", { pane: "profiles", profile: work });
  for (let i = 0; i < 5; i++) await tick();
  S().deleteProfile(work);
  release();
  await closing;
  assert.equal((await opening).error?.code, "no_window");
  assert.notEqual(useSettingsNav.getState().profileId, work);
});

test("settings.open fails when its profile goes away while the window opens", async () => {
  const work = S().createProfile({ name: "Work" });
  let finishOpen;
  appWindows.openWindow = (id, options) => new Promise((resolve) => (finishOpen = () => resolve(openWindow(id, options))));
  const reply = fire("settings.open", { pane: "profiles", profile: work });
  for (let i = 0; i < 20 && !finishOpen; i++) await tick();
  S().deleteProfile(work);
  finishOpen();
  const answer = await reply;
  assert.equal(answer.error?.code, "failed", JSON.stringify(answer));
});

test("settings.open at a profile other than the default shows that profile, and a bare reopen keeps it", async () => {
  const work = S().createProfile({ name: "Work" });
  const opened = await ok("settings.open", { pane: "profiles", profile: work });
  assert.deepEqual([opened.pane, opened.profile], ["profiles", work]);
  await ok("settings.close");
  const reopened = await ok("settings.open");
  assert.deepEqual([reopened.pane, reopened.profile], ["profiles", work]);
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
  const release = holdWindowList();
  const reply = fire("settings.close").catch(() => null);
  for (let i = 0; i < 5; i++) await tick();
  S().updateSettings({ cliControl: false });
  release();
  await reply;
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(await settingsOpen(), true, "the window stayed open");
});

test("an open and a close sent together run one after the other, so the window ends closed", async () => {
  let finishOpen;
  appWindows.openWindow = (id, options) => new Promise((resolve) => (finishOpen = () => resolve(openWindow(id, options))));
  const opening = fire("settings.open", { pane: "tabs" });
  const closing = socketClient(62).fire("settings.close");
  for (let i = 0; i < 20 && !finishOpen; i++) await tick();
  finishOpen();
  const [opened, closed] = await Promise.all([opening, closing]);
  assert.ok(!opened.error, JSON.stringify(opened.error));
  assert.ok(!closed.error, JSON.stringify(closed.error));
  assert.equal(await settingsOpen(), false);
});

test("the Settings window calls are refused where Settings is a page of its own", async () => {
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
