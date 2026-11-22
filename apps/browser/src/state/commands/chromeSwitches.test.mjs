import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const switches = await import("./chromeSwitches.ts");
const { CHROME_SWITCHES, ctrlTabPresetFollowing, newTabPositionFollowing, switchChanges, withChromeDefaults } = switches;

const MRU = CHROME_SWITCHES.ctrlTab.pref;
const NEXT = CHROME_SWITCHES.newTabs.pref;
const all = (values = {}) => withChromeDefaults(values);
const changed = (on) => ({ on, firstLook: false });
const first = (on) => ({ on, firstLook: true });

test("a switch that moved since the last look is a change, one that didn't is not", () => {
  assert.deepEqual(switchChanges({ "": all() }, { "": all({ [NEXT]: true }) }), { newTabs: changed(true) });
  assert.deepEqual(switchChanges({ "": all({ [NEXT]: true }) }, { "": all() }), { newTabs: changed(false) });
  assert.deepEqual(switchChanges({ "": all({ [NEXT]: true }) }, { "": all({ [NEXT]: true }) }), {});
});

test("the first look reports only switches already moved off Chrome's default", () => {
  assert.deepEqual(switchChanges({}, { "": all() }), {});
  assert.deepEqual(switchChanges({}, { "": all({ [MRU]: true, [NEXT]: true }) }), { ctrlTab: first(true), newTabs: first(true) });
});

test("a ⌃Tab value seen by an earlier version keeps ⌃Tab where it is, and the newer switches get their first look", () => {
  assert.deepEqual(switchChanges({ "": { [MRU]: true } }, { "": all({ [MRU]: true, [NEXT]: true }) }), { newTabs: first(true) });
});

test("a change in one profile is followed even when another profile's value is unchanged", () => {
  assert.deepEqual(switchChanges({ "": all(), work: all() }, { "": all(), work: all({ [MRU]: true }) }), { ctrlTab: changed(true) });
});

test("⌃Tab follows the most recently used switch, and the first look moves only the default", () => {
  assert.equal(ctrlTabPresetFollowing(changed(true), "step"), "switcher");
  assert.equal(ctrlTabPresetFollowing(changed(false), "switcher"), "step");
  assert.equal(ctrlTabPresetFollowing(changed(true), "switcher"), null);
  assert.equal(ctrlTabPresetFollowing(first(true), "step"), "switcher");
  assert.equal(ctrlTabPresetFollowing(first(true), "custom"), null);
});

test("opening new tabs next to the active tab picks Next to current tab, and off goes back to where the button sits", () => {
  assert.equal(newTabPositionFollowing(changed(true), { newTabPosition: "top", newTabButtonPosition: "top" }), "nextToCurrent");
  assert.equal(newTabPositionFollowing(changed(true), { newTabPosition: "nextToCurrent", newTabButtonPosition: "bottom" }), null);
  assert.equal(newTabPositionFollowing(changed(false), { newTabPosition: "nextToCurrent", newTabButtonPosition: "top" }), "top");
  assert.equal(newTabPositionFollowing(changed(false), { newTabPosition: "bottom", newTabButtonPosition: "bottom" }), null);
  assert.equal(newTabPositionFollowing(first(true), { newTabPosition: "bottom", newTabButtonPosition: "bottom" }), "nextToCurrent");
  assert.equal(newTabPositionFollowing(first(true), { newTabPosition: "top", newTabButtonPosition: "top" }), null);
});

const sidebarDefaults = {
  defaultsOf: (id) =>
    id === "toggleSidebar"
      ? [
          { key: "s", modifiers: ["command"] },
          { key: "l", modifiers: ["command", "shift"] },
        ]
      : [],
};

test("the vertical tabs key off takes ⌘S from Auto-Hide Tabs and keeps its other key, and on gives ⌘S back", () => {
  const { hideTabsKeyFollowing } = switches;
  const COLLAPSE = CHROME_SWITCHES.hideTabsKey.pref;
  assert.deepEqual(switchChanges({}, { "": all({ [COLLAPSE]: false }) }), { hideTabsKey: first(false) });
  assert.deepEqual(hideTabsKeyFollowing(changed(false), {}, sidebarDefaults), { key: "l", modifiers: ["command", "shift"] });
  assert.equal(hideTabsKeyFollowing(changed(true), { toggleSidebar: ["l", "command", "shift"] }, sidebarDefaults), null);
  assert.equal(hideTabsKeyFollowing(changed(true), { toggleSidebar: ["h", "command"] }, sidebarDefaults), undefined);
  assert.equal(hideTabsKeyFollowing(changed(false), { toggleSidebar: ["h", "command"] }, sidebarDefaults), undefined);
  assert.equal(hideTabsKeyFollowing(changed(false), {}, { defaultsOf: () => [] }), undefined);
});
