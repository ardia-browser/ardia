import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { settingsAdapter } = await import("../sync/settingsAdapter.ts");
const { DEFAULT_SETTINGS, defaultSearchEngine } = await import("./settings.ts");

const S = () => useBrowser.getState();
const mine = { id: "engine-1", name: "Mine", keyword: "m", url: "https://mine.example/?q=%s" };

function withMyEngine() {
  useBrowser.setState({ settings: { ...DEFAULT_SETTINGS, customSearchEngines: [mine], searchEngine: "engine-1" }, settingsMeta: { chosen: ["customSearchEngines", "searchEngine"], inferred: [] } });
}

test("a malformed custom-engine write leaves the saved list and the selected engine alone", () => {
  for (const bad of [null, "engines", 7, { 0: mine }, [mine, null], [mine, "x"], [{ id: "a" }]]) {
    for (const fromSync of [false, true]) {
      withMyEngine();
      S().updateSettings({ customSearchEngines: bad }, { fromSync });
      assert.deepEqual(S().settings.customSearchEngines, [mine], `${JSON.stringify(bad)} fromSync=${fromSync}`);
      assert.equal(defaultSearchEngine(S().settings).id, "engine-1");
    }
  }
});

test("a malformed synced custom-engine record leaves the saved list alone", () => {
  withMyEngine();
  settingsAdapter.apply(new Map([["set:customSearchEngines", { v: "engines" }]]), ["set:customSearchEngines"]);
  assert.deepEqual(S().settings.customSearchEngines, [mine]);
});

test("a malformed write isn't recorded as a choice", () => {
  useBrowser.setState({ settings: { ...DEFAULT_SETTINGS, customSearchEngines: [mine] }, settingsMeta: { chosen: [], inferred: [] } });
  S().updateSettings({ customSearchEngines: null });
  assert.deepEqual(S().settingsMeta.chosen, []);
});

test("a deliberate empty list still clears the custom engines", () => {
  withMyEngine();
  S().updateSettings({ customSearchEngines: [] });
  assert.deepEqual(S().settings.customSearchEngines, []);
});
