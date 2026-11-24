import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { parseSession } = await import("../session/persist.ts");
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const { CONFIG_SETTING_KEYS } = await import("../settings/configAllowlist.ts");
const { checkedSettings } = await import("../config/configSettings.ts");
const { chooseIcon } = await import("./actions.ts");
const { switcherIconOf } = await import("./switcherMark.ts");
const { switcherIcons } = await import("../../components/profiles/ProfileIcons.tsx");

const S = () => useBrowser.getState();
const profile = (id, icon) => ({ id, name: id, color: "plum", icon, createdAt: 0 });
const PROFILES = { work: profile("work", "symbol:briefcase.fill"), home: profile("home", "🔥"), play: profile("play", null) };

const savedBefore = (legacy) =>
  JSON.stringify({
    version: 11,
    profiles: PROFILES,
    profileOrder: ["work", "home", "play"],
    settings: { ...DEFAULT_SETTINGS, ...legacy },
    settingsMeta: { chosen: Object.keys(legacy), inferred: [] },
    windows: [],
    windowOrder: [],
    tabs: [],
    groups: [],
    splits: [],
    closedTabs: [],
    closedWindows: [],
  });

const shownAfterUpdate = (legacy) => {
  const session = parseSession(savedBefore(legacy));
  S().hydrate(session);
  const ids = S().profileOrder;
  return { shown: S().settings.showProfileDots, marks: ids.map((id) => switcherIconOf(S().profiles[id])), badges: ids.map((id) => S().profiles[id].icon) };
};

const BADGES = ["symbol:briefcase.fill", "🔥", null];

test("Dots before the update: every profile is still a dot in the switcher, and its badge keeps its icon", () => {
  assert.deepEqual(shownAfterUpdate({ showProfileDots: true, profileSwitcherIcons: false }), { shown: true, marks: [null, null, null], badges: BADGES });
});

test("Icons before the update: each profile keeps the icon it showed", () => {
  assert.deepEqual(shownAfterUpdate({ showProfileDots: true, profileSwitcherIcons: true }), { shown: true, marks: BADGES, badges: BADGES });
});

test("Nothing before the update stays hidden, and turning the switcher back on shows what it showed before", () => {
  assert.deepEqual(shownAfterUpdate({ showProfileDots: false, profileSwitcherIcons: false }), { shown: false, marks: [null, null, null], badges: BADGES });
  assert.deepEqual(shownAfterUpdate({ showProfileDots: false, profileSwitcherIcons: true }), { shown: false, marks: BADGES, badges: BADGES });
});

test("the old setting is gone from the store, so the next save drops it and a second launch changes nothing", () => {
  shownAfterUpdate({ showProfileDots: true, profileSwitcherIcons: false });
  assert.equal("profileSwitcherIcons" in S().settings, false);
  chooseIcon("home", "🔥");
  const saved = JSON.stringify({ version: 11, profiles: S().profiles, profileOrder: S().profileOrder, settings: S().settings, windows: [], windowOrder: [], tabs: [] });
  S().hydrate(parseSession(saved));
  assert.deepEqual(S().profileOrder.map((id) => switcherIconOf(S().profiles[id])), [null, "🔥", null]);
});

test("a profile shows its icon once one is chosen, and a dot again once it is removed", () => {
  S().hydrate({ profiles: { work: profile("work", null), home: profile("home", null) }, profileOrder: ["work", "home"] });
  assert.equal(switcherIconOf(S().profiles.work), null);
  chooseIcon("work", "symbol:briefcase.fill");
  assert.equal(switcherIconOf(S().profiles.work), "symbol:briefcase.fill");
  chooseIcon("work", null);
  assert.equal(S().profiles.work.icon, null);
  assert.equal(switcherIconOf(S().profiles.work), null);
  assert.equal(switcherIconOf(S().profiles.home), null);
});

test("a kept dot gives way when the icon is chosen again, changed by sync or import, but not when only the name syncs", () => {
  S().hydrate({ profiles: { home: { ...profile("home", "🔥"), switcherDot: true } }, profileOrder: ["home"] });
  S().updateProfile("home", { name: "Home", icon: "🔥" });
  assert.equal(switcherIconOf(S().profiles.home), null);
  S().updateProfile("home", { icon: "🌊" });
  assert.equal(switcherIconOf(S().profiles.home), "🌊");
  S().hydrate({ profiles: { home: { ...profile("home", "🔥"), switcherDot: true } }, profileOrder: ["home"] });
  chooseIcon("home", "🔥");
  assert.equal(switcherIconOf(S().profiles.home), "🔥");
  assert.equal("switcherDot" in S().profiles.home && S().profiles.home.switcherDot !== undefined, false);
});

test("icons that don't fit the sidebar fall back to dots for every profile", () => {
  assert.deepEqual(switcherIcons(["🔥", null], 1000), ["🔥", null]);
  assert.deepEqual(switcherIcons(["🔥", "🌊"], 10), [null, null]);
});

test("a config file that still names the old setting raises no problem", () => {
  assert.equal(CONFIG_SETTING_KEYS.includes("profileSwitcherIcons"), false);
  const { problems } = checkedSettings("config.json", { profileSwitcherIcons: true, showProfileDots: false }, DEFAULT_SETTINGS);
  assert.deepEqual(problems, []);
});
