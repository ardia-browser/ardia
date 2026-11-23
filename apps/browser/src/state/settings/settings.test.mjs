import assert from "node:assert/strict";
import { test } from "node:test";
const { DEFAULT_SETTINGS, parseSettings, SETTING_KEYS, SETTING_SPECS, parseSettingsMeta } = await import("./settings.ts");
const { useBrowser } = await import("../browser/store.ts");
const { settingsAdapter, SYNCED_SETTINGS } = await import("../sync/settingsAdapter.ts");
const { SETUP_SETTING_KEYS, SETTING_FIELDS } = await import("../presets/setupCode.ts");

const S = () => useBrowser.getState();

test("every default passes its own check", () => {
  for (const key of SETTING_KEYS) assert.ok(SETTING_SPECS[key].valid(DEFAULT_SETTINGS[key]), key);
});

test("dragging a tab onto another in the top tab strip groups them only once turned on", () => {
  assert.equal(DEFAULT_SETTINGS.dragToGroupInTopStrip, false);
});

test("a saved value of the wrong kind reads as the default, and the rest is kept", () => {
  const settings = parseSettings({
    tabLayout: "diagonal",
    sidebarWidth: -4,
    autoPictureInPicture: "yes",
    customSearchEngines: [{ id: 1 }],
    shortcuts: { newTab: ["t", "command"] },
    cleanUpInactiveTabsAfterMinutes: null,
  });
  assert.equal(settings.tabLayout, DEFAULT_SETTINGS.tabLayout);
  assert.equal(settings.sidebarWidth, DEFAULT_SETTINGS.sidebarWidth);
  assert.equal(settings.autoPictureInPicture, true);
  assert.deepEqual(settings.customSearchEngines, []);
  assert.deepEqual(settings.shortcuts, { newTab: ["t", "command"] });
  assert.equal(settings.cleanUpInactiveTabsAfterMinutes, null);
  assert.deepEqual(parseSettingsMeta({ chosen: ["shortcuts"], inferred: "everything" }), { chosen: ["shortcuts"], inferred: [] });
  assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
});

test("Peek and split view never both get ⌥-click from a saved file, and sync takes each record as it is", () => {
  const saved = parseSettings({ peekModifier: "alt", splitLinkModifier: "alt" });
  assert.deepEqual([saved.peekModifier, saved.splitLinkModifier], ["alt", "altShift"]);
  S().hydrate({ settings: { splitLinkModifier: "alt" }, settingsMeta: { chosen: ["splitLinkModifier"], inferred: [] } });
  settingsAdapter.apply(new Map([["set:peekModifier", { v: "alt" }]]), ["set:peekModifier"]);
  assert.deepEqual([S().settings.peekModifier, S().settings.splitLinkModifier], ["alt", "alt"], "moving one locally would make Macs that disagree flip it back and forth");
});

test("a synced value this version can't show is left out", () => {
  S().hydrate({ settings: {} });
  settingsAdapter.apply(
    new Map([
      ["set:selectedTabGlow", { v: "medium" }],
      ["set:showFullUrl", { v: null }],
      ["set:compactToolbar", { v: true }],
    ]),
    ["set:selectedTabGlow", "set:showFullUrl", "set:compactToolbar"],
  );
  assert.equal(S().settings.selectedTabGlow, DEFAULT_SETTINGS.selectedTabGlow);
  assert.equal(S().settings.showFullUrl, false);
  assert.equal(S().settings.compactToolbar, true);
  assert.ok(SYNCED_SETTINGS.includes("compactToolbar"));
});

test("address bar buttons follow the pin order without hover and respect bookmark visibility", async () => {
  const { addressBarButtons } = await import("./toolbarActions.ts");
  assert.deepEqual(addressBarButtons(null, true, false), []);
  assert.deepEqual(addressBarButtons(null, true, true), ["bookmark"]);
  assert.deepEqual(addressBarButtons(null, false, true), ["copyUrl"]);
  for (const hovered of [false, true]) {
    assert.deepEqual(addressBarButtons(["copyUrl", "bookmark"], true, hovered), ["copyUrl", "bookmark"]);
    assert.deepEqual(addressBarButtons(["bookmark", "copyUrl"], false, hovered), ["copyUrl"]);
    assert.deepEqual(addressBarButtons([], true, hovered), []);
  }
});

test("toolbar actions keep their order across reload and sync, including an intentionally empty toolbar", () => {
  assert.equal(parseSettings({}).toolbarActions, null);
  for (const invalid of [["bookmark", "bookmark"], ["extension"], "copyUrl"]) {
    assert.equal(parseSettings({ toolbarActions: invalid }).toolbarActions, null);
  }
  for (const value of [["copyUrl", "bookmark"], ["bookmark", "copyUrl"], ["copyUrl"], [], null]) {
    assert.deepEqual(parseSettings({ toolbarActions: value }).toolbarActions, value);
    settingsAdapter.apply(new Map([["set:toolbarActions", { v: value }]]), ["set:toolbarActions"]);
    assert.deepEqual(S().settings.toolbarActions, value);
  }
});

test("a setup code can carry every value its settings can take", () => {
  for (const key of SETUP_SETTING_KEYS) {
    const values = SETTING_SPECS[key].values;
    if (values) assert.deepEqual(values.filter((v) => !SETTING_FIELDS[key].values.includes(v)), [], key);
  }
});
