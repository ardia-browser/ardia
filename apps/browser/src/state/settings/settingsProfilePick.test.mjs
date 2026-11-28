import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { forgetSettingsScroll, goToSettingsPane, openSettings, replaceSettingsPlace, shownSettingsProfile, useSettingsNav } = await import("./settingsWindows.ts");
const { jumpToSetting } = await import("./searchState.ts");
const { settingsProfileFor } = await import("../extensions/store.ts");

const S = () => useBrowser.getState();
const nav = () => useSettingsNav.getState();
const shown = () => (nav().pane === "profiles" ? shownSettingsProfile(nav()) : null);
const clickSidebar = (pane) => goToSettingsPane(pane, settingsProfileFor(pane, nav()));
const pickProfile = (id) => replaceSettingsPlace(id);
const closeSettings = () => forgetSettingsScroll();

S().hydrate({});
const work = S().createProfile({ name: "Work" });
const play = S().createProfile({ name: "Play" });
const spare = S().createProfile({ name: "Spare" });
S().createWindow({ profileId: work });

test("before a profile has been shown, Settings › Profiles opens on the window's profile", () => {
  openSettings();
  clickSidebar("profiles");
  assert.equal(shown(), work);
});

test("the picked profile is still picked after visiting another pane", () => {
  pickProfile(play);
  clickSidebar("general");
  clickSidebar("profiles");
  assert.equal(shown(), play);
});

test("the picked profile is still picked after closing Settings on another pane and opening it again", () => {
  pickProfile(play);
  clickSidebar("general");
  closeSettings();
  openSettings();
  assert.equal(nav().pane, "general");
  clickSidebar("profiles");
  assert.equal(shown(), play);
});

test("closing Settings on Profiles and opening it again keeps the picked profile", () => {
  pickProfile(play);
  closeSettings();
  openSettings();
  assert.equal(shown(), play);
});

test("a search result on the Profiles page opens it on the picked profile", () => {
  pickProfile(play);
  jumpToSetting({ id: "general.defaultBrowser", pane: "general", section: "Default browser" });
  jumpToSetting({ id: "profiles.clearBrowsingData", pane: "profiles", section: "Data" });
  assert.equal(shown(), play);
});

test("an entry that names a profile opens that profile, which is then the one kept", () => {
  pickProfile(play);
  clickSidebar("general");
  openSettings("profiles", work);
  assert.equal(shown(), work);
  clickSidebar("general");
  clickSidebar("profiles");
  assert.equal(shown(), work);
});

test("a kept profile that has been deleted gives way to the window's profile", () => {
  openSettings("profiles", spare);
  clickSidebar("general");
  S().deleteProfile(spare);
  clickSidebar("profiles");
  assert.equal(shown(), work);
});
