import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../../state/browser/store.ts");
const { DEFAULT_SETTINGS, SETTING_SPECS } = await import("../../state/settings/settings.ts");
const { CONFIG_SETTING_KEYS } = await import("../../state/settings/configAllowlist.ts");
const { startNativeSettings } = await import("../../state/settings/nativeSettings.ts");
const { settingsSnapshot } = await import("../../state/telemetry/settingsSnapshot.ts");
const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");
const { search } = await import("./searchMatch.ts");
const { findSetting, SETTINGS_INDEX } = await import("./settingsIndex.ts");

const S = () => useBrowser.getState();

after(() => {
  S().updateSettings({ commandScrollZoom: true });
});

test("⌘-scroll zoom has a Settings row in Advanced › Browsing and is first for its search queries", () => {
  const entry = findSetting("advanced.commandScrollZoom");
  assert.ok(entry, "advanced.commandScrollZoom is in Settings");
  assert.equal(entry.pane, "advanced");
  assert.equal(entry.section, "Browsing");
  assert.equal(entry.explained, true);
  for (const query of ["⌘-scroll", "cmd scroll", "command scroll", "mouse wheel", "scroll zoom", "wheel zoom", "accidental zoom"]) {
    const first = search(SETTINGS_INDEX, query)[0]?.entry.id;
    assert.equal(first, "advanced.commandScrollZoom", query);
  }
});

test("toggling commandScrollZoom sends the setting to the native web view and records it in telemetry", () => {
  assert.equal(DEFAULT_SETTINGS.commandScrollZoom, true);
  assert.equal(SETTING_SPECS.commandScrollZoom.synced, true);
  assert.ok(CONFIG_SETTING_KEYS.includes("commandScrollZoom"));

  const webView = ardiaCoreNativeModules.ArdiaWebView;
  const originalCall = webView.call;
  const sent = [];
  webView.call = (verb, profile, json) => {
    if (verb === "setCommandScrollZoom") sent.push(JSON.parse(json).enabled);
    return originalCall(verb, profile, json);
  };
  S().hydrate({});
  const stop = startNativeSettings();
  try {
    S().updateSettings({ commandScrollZoom: false });
    assert.equal(settingsSnapshot(S().settings).setting_commandScrollZoom, "false");
    assert.equal(settingsSnapshot(S().settings).default_commandScrollZoom, "true");
    S().updateSettings({ commandScrollZoom: true });
    assert.equal(settingsSnapshot(S().settings).setting_commandScrollZoom, "true");
    assert.deepEqual(sent, [true, false, true]);
  } finally {
    stop();
    webView.call = originalCall;
  }
});
