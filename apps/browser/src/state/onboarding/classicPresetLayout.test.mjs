import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { tabLayoutOf } from "../browser/model.ts";
import { chooseSource, finishOnboarding, questionsFor, resolveDraft, startOnboarding, useOnboarding, PRESETS } from "./onboarding.ts";
import { classicTabs } from "./presets.ts";
import { DEFAULT_SETTINGS } from "../settings/settings.ts";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures.ts";
import { PLATFORM_FEATURES as LINUX_FEATURES } from "../../lib/platformFeatures.linux.ts";
import { PLATFORM_FEATURES as WIN_FEATURES } from "../../lib/platformFeatures.win.ts";
import { usePlugins } from "../plugins/store.ts";
import { loadSession, SESSION_VERSION } from "../session/persist.ts";
import * as stub from "../../test-native/index.ts";

usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const CLASSIC_SOURCES = ["chrome", "firefox", "brave", "edge", "helium", "chromium", "vivaldi", "opera"];
const PROFILE = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => useOnboarding.setState({ windowId: null, leaving: false, redo: false });

const withLinuxPresets = (run) => {
  const saved = Object.fromEntries(CLASSIC_SOURCES.map((source) => [source, PRESETS[source]]));
  for (const source of CLASSIC_SOURCES) {
    const { tabLayout: _top, ...rest } = PRESETS[source];
    PRESETS[source] = rest;
  }
  try {
    run();
  } finally {
    Object.assign(PRESETS, saved);
  }
};

test("sidebar tabs are the app's default layout", () => {
  assert.equal(DEFAULT_SETTINGS.tabLayout, "sidebar");
});

test("only Linux keeps the classic-browser presets from putting tabs along the top", () => {
  assert.equal(LINUX_FEATURES.classicPresetsPutTabsOnTop, false);
  for (const features of [PLATFORM_FEATURES, WIN_FEATURES]) assert.equal(features.classicPresetsPutTabsOnTop, true);
  assert.equal("tabLayout" in classicTabs(LINUX_FEATURES), false);
  assert.equal(classicTabs(PLATFORM_FEATURES).tabLayout, "top");
  for (const source of CLASSIC_SOURCES) assert.equal(PRESETS[source].tabLayout, "top", `${source} on macOS`);
});

test("the Linux classic presets keep every other choice they make", () => {
  const { tabLayout: _top, ...rest } = classicTabs(PLATFORM_FEATURES);
  assert.deepEqual(classicTabs(LINUX_FEATURES), rest);
});

test("on Linux, coming from a classic browser asks the tabs question with the sidebar preselected and finishes in the sidebar", () => {
  withLinuxPresets(() => {
    for (const source of CLASSIC_SOURCES) {
      const id = S().createWindow();
      startOnboarding(id, "source");
      chooseSource(source);
      assert.ok(questionsFor("layout").some((q) => q.id === "tabs"), `${source} asks where tabs go`);
      const { tabLayout } = resolveDraft(["tabLayout"], useOnboarding.getState().draft, useOnboarding.getState().preset, { ...S().settings, tabLayout: tabLayoutOf(S(), id) }, S().settingsMeta.chosen);
      assert.equal(tabLayout, "sidebar", source);
      finishOnboarding();
      assert.equal(tabLayoutOf(S(), id), "sidebar", source);
      settle();
    }
  });
});

test("on macOS a classic browser still answers the tabs question with top tabs", () => {
  const id = S().createWindow();
  startOnboarding(id, "source");
  chooseSource("chrome");
  assert.equal(questionsFor("layout").some((q) => q.id === "tabs"), false);
  settle();
});

test("a Linux user who already has top tabs keeps them: saved layouts are never rewritten", () => {
  withLinuxPresets(() => {
    stub.docs.clear();
    stub.docs.set("session.json", JSON.stringify({
      version: SESSION_VERSION, profiles: { default: PROFILE }, profileOrder: ["default"],
      settings: { ...DEFAULT_SETTINGS, tabLayout: "top" }, settingsMeta: { chosen: ["tabLayout"], inferred: [] },
      windows: [], windowOrder: [], tabs: [], groups: [], splits: [], closedTabs: [], closedWindows: [],
    }));
    S().hydrate(loadSession());
    assert.equal(S().settings.tabLayout, "top");
    assert.ok(S().settingsMeta.chosen.includes("tabLayout"));
  });
});
