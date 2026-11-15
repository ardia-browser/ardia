import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { permissionValue } = await import("./siteControls.ts");

const sound = { siteMuted: false, soundBlocked: false };
const autoplay = (value, isDefault) => ({ autoplay: { value, isDefault } });

test("Site Controls shows Autoplay Blocked for a site that follows Block autoplay on every site, and a site's own choice otherwise", () => {
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: false });
  assert.equal(permissionValue("autoplay", autoplay("allow", true), sound), "allow");
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: true });
  assert.equal(permissionValue("autoplay", autoplay("allow", true), sound), "block");
  assert.equal(permissionValue("autoplay", autoplay("allow", false), sound), "allow");
  assert.equal(permissionValue("autoplay", autoplay("block", false), sound), "block");
  assert.equal(permissionValue("camera", { camera: { value: "ask", isDefault: true } }, sound), "ask");
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: false });
});

test("a site's sheet in Settings reads Autoplay as blocked while it follows Block autoplay on every site", async () => {
  const { effectiveSettingValue } = await import("./siteControls.ts");
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: false });
  assert.equal(effectiveSettingValue("autoplay", autoplay("allow", true)), "allow");
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: true });
  assert.equal(effectiveSettingValue("autoplay", autoplay("allow", true)), "block");
  assert.equal(effectiveSettingValue("autoplay", autoplay("allow", false)), "allow");
  assert.equal(effectiveSettingValue("popups", { popups: { value: "block", isDefault: true } }), "block");
  assert.equal(effectiveSettingValue("javascript", { javascript: { value: "allow", isDefault: true } }), "allow");
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: false });
});

test("Site Controls features Autoplay while Block autoplay on every site is on, so its exception sits in the main list", async () => {
  const { featuredPermissions, sitePermissionsFor } = await import("./siteControls.ts");
  const list = sitePermissionsFor("chromium");
  const settings = Object.fromEntries(list.map((p) => [p.type, { value: p.type === "autoplay" ? "allow" : "ask", isDefault: true }]));
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: false });
  assert.equal(featuredPermissions("no-such-tab", settings, list).has("autoplay"), false);
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: true });
  assert.equal(featuredPermissions("no-such-tab", settings, list).has("autoplay"), true);
  assert.equal(featuredPermissions("no-such-tab", settings, list).has("camera"), false);
  useBrowser.getState().updateSettings({ blockAutoplayEverywhere: false });
});
