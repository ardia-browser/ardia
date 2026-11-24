import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
import { useBrowser } from "../browser/store.ts";
import { WindowContext } from "../browser/hooks.ts";
import { useScopedLook } from "../app/theme.ts";
import { scopedTheme, profileTheme } from "../../components/ui/theme.ts";
import { DEFAULT_SETTINGS, parseSettings, SETTING_SPECS } from "../settings/settings.ts";
import { SYNCED_SETTINGS } from "../sync/settingsAdapter.ts";
import { settingsSnapshot } from "../telemetry/settingsSnapshot.ts";
import { isConfigSettingKey } from "../settings/configAllowlist.ts";
import { provideProfileLooks } from "../profiles/looks.ts";
import { launchBackdrop } from "./launchBackdrop.ts";
import { flushPersistence, loadSession, startPersistence } from "../session/persist.ts";
import { docs } from "../../test-native/index.ts";
import { search } from "../../components/settings/searchMatch.ts";
import { SETTINGS_INDEX, setting } from "../../components/settings/settingsIndex.ts";

const S = () => useBrowser.getState();
const preset = { color: "plum" };
const custom = {
  color: "blue",
  theme: {
    stops: [{ x: 0.5, y: 0.5, color: { r: 0.2, g: 0.4, b: 0.8, a: 0.4 } }],
    intensity: 0.5, grain: 0.3, texture: "grain", mode: "auto", translucency: 0.6,
  },
};

test("window translucency defaults on, persists false, and stays device-local", () => {
  assert.equal(DEFAULT_SETTINGS.windowTranslucency, true);
  assert.equal(parseSettings({ windowTranslucency: false }).windowTranslucency, false);
  assert.equal(parseSettings({ windowTranslucency: "off" }).windowTranslucency, true);
  assert.equal(SETTING_SPECS.windowTranslucency.synced, false);
  assert.ok(!SYNCED_SETTINGS.includes("windowTranslucency"));
  assert.ok(isConfigSettingKey("windowTranslucency"));
  assert.equal(search(SETTINGS_INDEX, "opaque")[0].entry.id, "advanced.windowTranslucency");
  assert.equal(setting("advanced.windowTranslucency").pane, "advanced");
});

test("the existing settings snapshot measures translucency choices and their default", () => {
  for (const enabled of [false, true]) {
    const snapshot = settingsSnapshot({ ...DEFAULT_SETTINGS, windowTranslucency: enabled });
    assert.equal(snapshot.setting_windowTranslucency, String(enabled));
    assert.equal(snapshot.default_windowTranslucency, "true");
  }
});

test("disabling window translucency preserves cached preset and custom colours and blur amounts", () => {
  const original = JSON.stringify(custom);
  for (const dark of [false, true]) {
    for (const adaptTextToColor of [false, true]) {
      for (const profile of [preset, custom, { ...custom, theme: { ...custom.theme, translucency: 0 } }]) {
        const normal = scopedTheme(false, profile, dark, "own", null, adaptTextToColor);
        const opaque = scopedTheme(false, profile, dark, "own", null, adaptTextToColor, false);
        assert.equal(opaque.backdrop.backgroundBlurEnabled, false);
        assert.deepEqual(opaque, { ...normal, backdrop: { ...normal.backdrop, backgroundBlurEnabled: false } });
        assert.equal(scopedTheme(false, profile, dark, "own", null, adaptTextToColor, false), opaque);
        assert.equal(scopedTheme(false, profile, dark, "own", null, adaptTextToColor, true), normal);
        assert.equal(normal.adaptiveInk, Boolean(profile.theme) && adaptTextToColor);
        assert.equal(normal.backdrop.backgroundBlurEnabled, profile.theme ? profile.theme.translucency > 0 : true);
      }
    }
  }
  assert.equal(JSON.stringify(custom), original);
});

test("restoring translucency respects the independently resolved light and dark custom looks", () => {
  const profile = { ...custom, theme: { ...custom.theme, translucency: 0, dark: { ...custom.theme, translucency: 1 } } };
  for (const dark of [false, true]) {
    assert.equal(scopedTheme(false, profile, dark, "own", null, true, false).backdrop.backgroundBlurEnabled, false);
    assert.equal(scopedTheme(false, profile, dark, "own", null, true, true).backdrop.backgroundBlurEnabled, dark);
  }
});

test("open regular, private and little windows react to the global setting without changing their theme colours", () => {
  S().hydrate({ settings: {} });
  const windows = [S().createWindow({}), S().createWindow({ kind: "private" }), S().createWindow({ kind: "small" })];
  const views = windows.map((window) => mount(() => useScopedLook(scopedTheme), { contexts: [[WindowContext, window]] }));
  try {
    const before = views.map((view) => view.value);
    assert.ok(before.every((theme) => theme.backdrop.backgroundBlurEnabled));
    assert.equal(before[1].dark, true);
    S().updateSettings({ windowTranslucency: false });
    views.forEach((view, index) => {
      assert.equal(view.value.backdrop.backgroundBlurEnabled, false);
      assert.deepEqual(view.value.windowTint, before[index].windowTint);
      assert.equal(view.value.dark, before[index].dark);
    });
    S().updateSettings({ windowTranslucency: true });
    views.forEach((view, index) => assert.equal(view.value, before[index]));
  } finally {
    views.forEach((view) => view.unmount());
  }
});

test("window translucency preserves the saved text adaptation choice in the window scope", () => {
  S().hydrate({ settings: {} });
  const window = S().createWindow({});
  S().setProfileLook(S().windows[window].profileId, { color: custom.color, theme: custom.theme });
  const view = mount(() => useScopedLook(scopedTheme), { contexts: [[WindowContext, window]] });
  try {
    for (const adaptTextToColor of [false, true]) {
      S().updateSettings({ adaptTextToColor, windowTranslucency: true });
      const normal = view.value;
      assert.equal(normal.adaptiveInk, adaptTextToColor);
      S().updateSettings({ windowTranslucency: false });
      assert.equal(view.value.adaptiveInk, adaptTextToColor);
      assert.deepEqual(view.value, { ...normal, backdrop: { ...normal.backdrop, backgroundBlurEnabled: false } });
    }
  } finally {
    view.unmount();
  }
});

test("the saved startup backdrop follows the global override and the selected custom look", () => {
  provideProfileLooks({ accent: () => "", theme: profileTheme });
  S().hydrate({ settings: {} });
  const window = S().createWindow({});
  const profileId = S().windows[window].profileId;
  for (const profile of [preset, custom, { ...custom, theme: { ...custom.theme, translucency: 0 } }]) {
    S().setProfileLook(profileId, { color: profile.color, theme: profile.theme ?? null });
    S().updateSettings({ windowTranslucency: true });
    const normal = launchBackdrop(S(), window);
    assert.equal(normal.backgroundBlurEnabled, profile.theme ? profile.theme.translucency > 0 : true);
    S().updateSettings({ windowTranslucency: false });
    assert.deepEqual(launchBackdrop(S(), window), { ...normal, backgroundBlurEnabled: false });
  }
});

test("changing translucency saves and restores both choices and their early startup material", () => {
  provideProfileLooks({ accent: () => "", theme: profileTheme });
  for (const enabled of [false, true]) {
    docs.clear();
    const stop = startPersistence();
    try {
      const window = S().createWindow({ url: "https://example.com/" });
      S().setFocusedWindow(window);
      S().updateSettings({ windowTranslucency: enabled });
      flushPersistence();
      const saved = JSON.parse(docs.get("session.json"));
      assert.equal(saved.settings.windowTranslucency, enabled);
      assert.equal(saved.launchBackdrop.backgroundBlurEnabled, enabled);
    } finally {
      stop();
    }
    S().hydrate({ settings: { windowTranslucency: !enabled } });
    assert.equal(S().settings.windowTranslucency, !enabled);
    const restored = loadSession();
    S().hydrate(restored);
    assert.equal(S().settings.windowTranslucency, enabled);
    assert.equal(launchBackdrop(S(), restored.focusedWindowId).backgroundBlurEnabled, enabled);
  }
});
