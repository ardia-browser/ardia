import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { loadSession } = await import("../session/persist.ts");
const { DEFAULT_SETTINGS } = await import("./settings.ts");
const { CONFIG_SETTING_KEYS } = await import("./configAllowlist.ts");
const { settingsAdapter } = await import("../sync/settingsAdapter.ts");
const { startNativeSettings } = await import("./nativeSettings.ts");
const { useProfileTheme } = await import("../../components/window/ThemeScope.tsx");
const media = await import("../media/media.ts");
const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const THEME = { stops: [{ x: 0.5, y: 0.5, color: { r: 0.95, g: 0.9, b: 0.3, a: 1 } }], intensity: 1, mode: "dark", grain: 0, texture: "grain", translucency: 0 };
const PROFILE = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0, theme: THEME };
const OFF_IN_0246 = { commandScrollZoom: false, sidebarMediaControls: false, adaptTextToColor: false };

const sessionOf0246 = (choices) => ({
  version: 11,
  profiles: { default: PROFILE },
  profileOrder: ["default"],
  settings: { ...DEFAULT_SETTINGS, ...choices },
  settingsMeta: { chosen: Object.keys(choices), inferred: [] },
  windows: [],
  windowOrder: [],
  tabs: [],
  groups: [],
  splits: [],
  closedTabs: [],
  closedWindows: [],
});
const load = (choices) => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(sessionOf0246(choices)));
  S().hydrate(loadSession());
};

function commandScrollZoomSent() {
  const webView = ardiaCoreNativeModules.ArdiaWebView;
  const call = webView.call;
  const sent = [];
  webView.call = (verb, profile, json) => {
    if (verb === "setCommandScrollZoom") sent.push(JSON.parse(json).enabled);
    return call(verb, profile, json);
  };
  const stop = startNativeSettings();
  stop();
  webView.call = call;
  return sent;
}

function hiddenPlayers() {
  const w = S().createWindow({ url: "a.com" });
  const playing = S().newTab(w, { url: "music.com", background: true });
  return media.hiddenPlayerTabs(S(), w, S().windows[w].profileId, [playing]);
}

const adaptiveInk = () => mount(() => useProfileTheme("default")).value.adaptiveInk;

test("the four 0.2.46 choices still load from a 0.2.46 file, with the Import button's under its new name", () => {
  load({ ...OFF_IN_0246, hideBookmarksBarImport: true });
  for (const [key, value] of Object.entries(OFF_IN_0246)) {
    assert.equal(S().settings[key], value, key);
    assert.ok(S().settingsMeta.chosen.includes(key), `${key} stays chosen`);
    assert.ok(CONFIG_SETTING_KEYS.includes(key), `${key} can be set from the config file`);
  }
  assert.equal(S().settings.bookmarksImportDismissed, true);
});

test("⌘-scroll zoom turned off in 0.2.46 stays off", () => {
  load({ commandScrollZoom: false });
  assert.deepEqual(commandScrollZoomSent(), [false]);
  load({});
  assert.deepEqual(commandScrollZoomSent(), [true]);
});

test("sidebar media controls turned off in 0.2.46 stay off", () => {
  load({ sidebarMediaControls: false });
  assert.deepEqual(hiddenPlayers(), []);
  load({});
  assert.equal(hiddenPlayers().length, 1);
});

test("text that doesn't adapt to a custom theme's colour in 0.2.46 still doesn't", () => {
  load({ adaptTextToColor: false });
  assert.equal(adaptiveInk(), false);
  load({});
  assert.equal(adaptiveInk(), true);
});

test("a hidden Import button on the empty bookmarks bar stays hidden", () => {
  load({ hideBookmarksBarImport: true });
  assert.equal(S().settings.bookmarksImportDismissed, true);
  load({});
  assert.equal(S().settings.bookmarksImportDismissed, false);
});

test("the kept choices sync, so another Mac follows them and can't reset them", () => {
  load(OFF_IN_0246);
  const published = settingsAdapter.extract(() => undefined).values;
  for (const key of Object.keys(OFF_IN_0246)) assert.ok(published.has(`set:${key}`), key);
});
