import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { SETTINGS_PANES, useSettingsNav } = await import("../settings/settingsWindows.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

after(() => S().updateSettings({ cliControl: false }));

const { call, ok } = socketClient(61);
const appWindows = shellNativeModules.ArdiaAppWindows;

test("settings.window says whether Settings is open and which pane it shows", async () => {
  await freshWindow();
  await appWindows.closeWindow("settings");
  const closed = await ok("settings.window");
  assert.equal(closed.open, false);
  assert.deepEqual(closed.panes, [...SETTINGS_PANES]);
  const opened = await ok("settings.open", { pane: "shortcuts" });
  assert.equal(opened.open, true);
  assert.equal(opened.pane, "shortcuts");
  assert.equal(useSettingsNav.getState().pane, "shortcuts", "the window's own navigation moved");
  assert.deepEqual(await ok("settings.window"), opened);
});

test("settings.open takes a profile only on the profiles pane, and only a real one", async () => {
  await freshWindow();
  const profile = S().settings.defaultProfileId;
  const shown = await ok("settings.open", { pane: "profiles", profile });
  assert.equal(shown.pane, "profiles");
  assert.equal(shown.profile, profile);
  assert.equal((await call("settings.open", { pane: "general", profile })).error?.code, "bad_request");
  assert.equal((await call("settings.open", { pane: "profiles", profile: "nope" })).error?.code, "no_window");
  assert.equal((await call("settings.open", { pane: "secrets" })).error?.code, "bad_request");
  assert.equal(useSettingsNav.getState().pane, "profiles", "a refused call moved nothing");
});

test("settings.open without a pane brings Settings forward where it was", async () => {
  await freshWindow();
  await ok("settings.open", { pane: "appearance" });
  await appWindows.closeWindow("settings");
  const reopened = await ok("settings.open");
  assert.equal(reopened.open, true);
  assert.equal(reopened.pane, "appearance");
});

test("settings.close closes the window and answers once it's gone", async () => {
  await freshWindow();
  await ok("settings.open", { pane: "advanced" });
  const closed = await ok("settings.close");
  assert.equal(closed.open, false);
  assert.ok(!(await appWindows.windowIds()).includes("settings"));
  assert.equal((await ok("settings.close")).open, false, "closing it again is fine");
});

test("methods lists the Settings window calls", async () => {
  await freshWindow();
  const names = (await ok("methods")).map((m) => m.name);
  for (const name of ["settings.window", "settings.open", "settings.close"]) assert.ok(names.includes(name), name);
});
