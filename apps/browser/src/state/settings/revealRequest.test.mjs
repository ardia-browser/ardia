import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsBack, useSettingsNav } from "./settingsWindows.ts";
import { revealIsCurrent, revealSetting, revealStillWanted, useSettingsSearch } from "./searchState.ts";

const general = { pane: "general", profileId: null, detail: null };

test("a reveal belongs to its destination: Back to the pane before, or a detail page in the same pane, isn't it", () => {
  const reveal = { id: "general.defaultBrowser", at: 0, request: 7, place: general };
  assert.equal(revealStillWanted(reveal, 7, general), true);
  assert.equal(revealStillWanted(reveal, 7, { pane: "appearance", profileId: null, detail: null }), false);
  assert.equal(revealStillWanted(reveal, 7, { ...general, detail: "filterLists" }), false);
  assert.equal(revealStillWanted(reveal, 7, { ...general, profileId: "work" }), false);
  assert.equal(revealStillWanted(reveal, 8, general), false);
  assert.equal(revealStillWanted(null, 7, general), false);
});

test("pressing Back while a revealed pane still loads makes the reveal stale", () => {
  useSettingsNav.setState({ pane: "appearance", profileId: null, detail: null, back: [], forward: [] });
  revealSetting({ id: "general.defaultBrowser", pane: "general", section: "Default browser" }, "click", 0);
  const { request } = useSettingsSearch.getState().reveal;
  assert.equal(revealIsCurrent(request), true);
  settingsBack();
  assert.equal(useSettingsNav.getState().pane, "appearance");
  assert.equal(revealIsCurrent(request), false);
});

test("each reveal is a new request, so an older one can't finish for it", () => {
  useSettingsNav.setState({ pane: "appearance", profileId: null, detail: null, back: [], forward: [] });
  revealSetting({ id: "general.defaultBrowser", pane: "general", section: "Default browser" }, "click", 0);
  const first = useSettingsSearch.getState().reveal.request;
  revealSetting({ id: "general.openAtLogin", pane: "general", section: "Startup and quitting" }, "click", 1);
  assert.equal(revealIsCurrent(first), false);
  assert.equal(revealIsCurrent(useSettingsSearch.getState().reveal.request), true);
});
