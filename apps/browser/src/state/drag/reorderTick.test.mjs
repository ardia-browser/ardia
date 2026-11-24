import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { loadSession } = await import("../session/persist.ts");
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const { CONFIG_SETTING_KEYS } = await import("../settings/configAllowlist.ts");
const { reorderTick } = await import("./reorderTick.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const KEY = "tabReorderHaptics";
const PROFILE = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const system = shellNativeModules.ArdiaSystem;
const originalTick = system.hapticTick;
let ticks = 0;
system.hapticTick = () => void ticks++;
after(() => {
  system.hapticTick = originalTick;
  S().updateSettings({ [KEY]: true });
});

const sessionOf0246 = (settings) => ({
  version: 11,
  profiles: { default: PROFILE },
  profileOrder: ["default"],
  settings,
  settingsMeta: { chosen: [KEY], inferred: [] },
  windows: [],
  windowOrder: [],
  tabs: [],
  groups: [],
  splits: [],
  closedTabs: [],
  closedWindows: [],
});
const load = (saved) => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(saved));
  S().hydrate(loadSession());
};
const ticksFor = (on) => {
  S().updateSettings({ [KEY]: on });
  ticks = 0;
  reorderTick();
  reorderTick();
  return ticks;
};

test("reordering ticks by default, as in 0.2.46", () => {
  assert.equal(DEFAULT_SETTINGS[KEY], true);
  assert.ok(CONFIG_SETTING_KEYS.includes(KEY));
});

test("an off saved by 0.2.46 stays off after the update", () => {
  load(sessionOf0246({ ...DEFAULT_SETTINGS, [KEY]: false }));
  assert.equal(S().settings[KEY], false);
  assert.ok(S().settingsMeta.chosen.includes(KEY));
});

test("the reorder tick follows the setting", () => {
  assert.equal(ticksFor(true), 2);
  assert.equal(ticksFor(false), 0);
});
