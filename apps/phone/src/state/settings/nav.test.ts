import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSettings, followSettingsPath, offerBrowseForMePage, offerSyncPages, openSettings, pushSettings, settingsNav, settingsPath, settingsRouteFromKey, settingsRouteKey, type SettingsRoute } from "./nav.ts";

test("every settings route turns into a path key and back, a filter list keeping its id", () => {
  const routes: SettingsRoute[] = [{ page: "appearance" }, { page: "siteSettings" }, { page: "filterList", id: "easylist:v2" }, { page: "syncConnect" }, { page: "whatsSent" }];
  for (const route of routes) assert.deepEqual(settingsRouteFromKey(settingsRouteKey(route)), route);
  assert.equal(settingsRouteFromKey("nowhere"), null);
});

test("the native stack's path is the store's stack under the root, and a native pop leaves the store where the stack is", () => {
  openSettings();
  pushSettings({ page: "siteSettings" });
  pushSettings({ page: "filterLists" });
  assert.deepEqual(settingsPath(settingsNav().stack), ["siteSettings", "filterLists"]);
  followSettingsPath(["siteSettings"]);
  assert.deepEqual(settingsNav().stack, [{ page: "root" }, { page: "siteSettings" }]);
  assert.equal(settingsNav().popping, true);
  followSettingsPath([]);
  assert.deepEqual(settingsNav().stack, [{ page: "root" }]);
  closeSettings();
  followSettingsPath(["about"]);
  assert.equal(settingsNav().open, false);
});

test("where sync isn't offered, the sync pages are never opened or pushed, and the rest of Settings is untouched", () => {
  offerSyncPages(() => false);
  closeSettings();
  openSettings({ page: "sync" });
  assert.equal(settingsNav().open, false);
  openSettings({ page: "appearance" });
  assert.deepEqual(settingsNav().stack.map((route) => route.page), ["root", "appearance"]);
  for (const page of ["sync", "syncConnect", "syncWords", "syncScan"] as const) pushSettings({ page });
  assert.deepEqual(settingsNav().stack.map((route) => route.page), ["root", "appearance"]);
  offerSyncPages(() => true);
  pushSettings({ page: "sync" });
  assert.deepEqual(settingsNav().stack.map((route) => route.page), ["root", "appearance", "sync"]);
  closeSettings();
});

test("Browse for Me's page opens only where the phone offers it, as on iPhone, and never on Android", () => {
  closeSettings();
  assert.deepEqual(settingsRouteFromKey("browseForMe"), { page: "browseForMe" });
  offerBrowseForMePage(() => false);
  openSettings({ page: "browseForMe" });
  assert.equal(settingsNav().open, false);
  openSettings();
  pushSettings({ page: "browseForMe" });
  assert.deepEqual(settingsNav().stack.map((route) => route.page), ["root"]);
  offerBrowseForMePage(() => true);
  pushSettings({ page: "browseForMe" });
  assert.deepEqual(settingsNav().stack.map((route) => route.page), ["root", "browseForMe"]);
  closeSettings();
  offerBrowseForMePage(() => false);
});
