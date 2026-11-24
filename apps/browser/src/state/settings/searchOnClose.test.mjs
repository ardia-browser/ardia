import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { currentSettingsSearch, previewSetting, setSettingsQuery, settingsSearchHost } = await import("./searchState.ts");
const { openSettings } = await import("./settingsWindows.ts");

const THEME = { id: "appearance.theme", pane: "appearance", section: "theme" };

test("closing Settings drops its search, so opening it again starts with an empty field and no results (#3227)", () => {
  const closeSettings = settingsSearchHost();
  setSettingsQuery("theme");
  previewSetting(THEME);
  assert.equal(currentSettingsSearch().previewing, true, "the search is showing a result");
  closeSettings();
  openSettings();
  const search = currentSettingsSearch();
  assert.equal(search.query, "");
  assert.equal(search.previewing, false);
  assert.equal(search.reveal, null);
  assert.equal(search.previewSection, null);
});

test("opening Settings again while it's still open keeps the search in it", () => {
  setSettingsQuery("theme");
  openSettings();
  assert.equal(currentSettingsSearch().query, "theme");
  setSettingsQuery("");
});

test("the Settings window holds its search for as long as it's open", () => {
  const source = readFileSync(new URL("../../components/settings/SettingsWindow.tsx", import.meta.url), "utf8");
  assert.match(source, /useEffect\(\(\) => settingsSearchHost\(\), \[\]\);/);
});
