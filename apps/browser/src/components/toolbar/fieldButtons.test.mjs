import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldButtonsShown, sidebarFieldButtons } from "./fieldButtons.ts";
import { DEFAULT_SETTINGS, parseSettings, SETTING_SPECS } from "../../state/settings/settings.ts";
import { isConfigSettingKey } from "../../state/settings/configAllowlist.ts";
import { settingsSnapshot } from "../../state/telemetry/settingsSnapshot.ts";

test("the address bar's buttons show on hover by default, and always when asked", () => {
  assert.equal(DEFAULT_SETTINGS.addressBarButtons, "hover");
  assert.equal(fieldButtonsShown("hover", false), false);
  assert.equal(fieldButtonsShown("hover", true), true);
  assert.equal(fieldButtonsShown("always", false), true);
  assert.equal(fieldButtonsShown("always", true), true);
});

const sidebar = (o) => sidebarFieldButtons({ mode: "hover", hovered: false, insecure: false, extensionsHeld: false, ...o });

test("with buttons on hover, the sidebar address field shows only the address until the pointer is over it, then Site Controls, Bookmark and the extensions on the right", () => {
  assert.deepEqual(sidebar(), { leading: false, siteControls: false, page: false, extensions: false });
  assert.deepEqual(sidebar({ hovered: true }), { leading: false, siteControls: true, page: true, extensions: true });
});

test("the sidebar field always shows the not-secure lock on the left, and an open extension popup keeps the extensions shown", () => {
  assert.deepEqual(sidebar({ insecure: true }), { leading: true, siteControls: false, page: false, extensions: false });
  assert.deepEqual(sidebar({ insecure: true, hovered: true }), { leading: true, siteControls: false, page: true, extensions: true });
  assert.equal(sidebar({ extensionsHeld: true }).extensions, true);
});

test("with buttons always shown, the sidebar field keeps Site Controls on the left and its extensions, as before", () => {
  assert.deepEqual(sidebar({ mode: "always" }), { leading: true, siteControls: false, page: true, extensions: true });
  assert.deepEqual(sidebar({ mode: "always", hovered: true }), { leading: true, siteControls: false, page: true, extensions: true });
});

test("the address bar buttons setting syncs, sits in config files and in the daily settings snapshot, and a value it doesn't know falls back to hover", () => {
  assert.equal(SETTING_SPECS.addressBarButtons.synced, true);
  assert.ok(isConfigSettingKey("addressBarButtons"));
  assert.equal(parseSettings({ addressBarButtons: "always" }).addressBarButtons, "always");
  assert.equal(parseSettings({ addressBarButtons: "sometimes" }).addressBarButtons, "hover");
  assert.equal(settingsSnapshot(parseSettings({ addressBarButtons: "always" })).setting_addressBarButtons, "always");
});
