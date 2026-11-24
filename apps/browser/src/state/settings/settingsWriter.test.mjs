import assert from "node:assert/strict";
import { after, test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SETTINGS, writableSettingsPatch } = await import("./settings.ts");
const { takeSettingsWriteCounts } = await import("../telemetry/settingsWriteCounts.ts");
const client = await import("../telemetry/client.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const fresh = (settings = {}) => {
  S().hydrate({});
  useBrowser.setState({ settings: { ...DEFAULT_SETTINGS, ...settings }, settingsMeta: { chosen: [], inferred: [] } });
};

test("a rejected auto-hide value leaves each window's own auto-hide choice", () => {
  fresh();
  const w = S().createWindow({ url: "https://a.example/" });
  useBrowser.setState({ windows: { ...S().windows, [w]: { ...S().windows[w], autoHideTabs: true } } });
  for (const fromSync of [false, true]) {
    S().updateSettings({ autoHideTabs: "yes" }, { fromSync });
    assert.equal(S().windows[w].autoHideTabs, true);
    assert.equal(S().settings.autoHideTabs, false);
  }
});

test("a rejected link modifier doesn't stop the two link keys being kept apart", () => {
  fresh({ peekModifier: "alt", splitLinkModifier: "altShift" });
  S().updateSettings({ peekModifier: 5, splitLinkModifier: "alt" });
  assert.equal(S().settings.splitLinkModifier === "alt" && S().settings.peekModifier === "alt", false);
});

test("a mixed write keeps the valid keys, reports the rejected ones and counts each once", () => {
  fresh();
  client.setSharing(true, "settings");
  takeSettingsWriteCounts();
  const w = S().createWindow({ url: "https://a.example/" });
  useBrowser.setState({ windows: { ...S().windows, [w]: { ...S().windows[w], autoHideTabs: true } } });
  const mixed = { showFullUrl: true, readerFont: "comic", notASetting: 1, autoHideTabs: 1 };
  assert.deepEqual([...writableSettingsPatch(mixed).rejected].sort(), ["autoHideTabs", "notASetting", "readerFont"]);
  takeSettingsWriteCounts();
  S().updateSettings(mixed);
  assert.equal(S().settings.showFullUrl, true);
  assert.equal(S().settings.readerFont, "serif");
  assert.equal(S().windows[w].autoHideTabs, true);
  assert.deepEqual(S().settingsMeta.chosen, ["showFullUrl"]);
  assert.equal(takeSettingsWriteCounts().settings_writes_rejected, 3);
  S().updateSettings({ showFullUrl: false });
  assert.equal(takeSettingsWriteCounts().settings_writes_rejected, 0);
  client.setSharing(false, "settings");
});

test("a size with a missing side and a record that isn't a plain object are turned down", () => {
  fresh();
  S().updateSettings({ littleArdiaSize: [, 500], developerModeSites: new Date(0), shortcuts: new Map() });
  assert.deepEqual(S().settings.littleArdiaSize, DEFAULT_SETTINGS.littleArdiaSize);
  assert.deepEqual(S().settings.developerModeSites, {});
  assert.deepEqual(S().settings.shortcuts, {});
});

test("resizing Little Ardia never saves a size its setting would turn down", () => {
  fresh();
  const little = S().createWindow({ kind: "small", url: "https://l.example/" });
  S().setWindowFrame(little, [0, 0, 700, 500]);
  S().setWindowFrame(little, [0, 0, Number.NaN, 520]);
  S().setWindowFrame(little, [0, 0, 0, 530]);
  const size = S().settings.littleArdiaSize;
  assert.ok(size.every((n) => Number.isFinite(n) && n > 0), JSON.stringify(size));
});

test("the default profile is only ever set to a profile id string", () => {
  fresh();
  S().setDefaultProfile(["default"]);
  assert.equal(typeof S().settings.defaultProfileId, "string");
});
