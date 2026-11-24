import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, newTabOpensOf, parseSettings } from "./settings.ts";
import { useBrowser } from "../browser/store.ts";
import { settingsAdapter, SYNCED_SETTINGS } from "../sync/settingsAdapter.ts";
import { addressBarInSidebar, minimalismIn, openingLightsCenter } from "../windows/layout.ts";
import { addressFieldShown, commandKeyPlacement } from "../omnibox/barPlacement.ts";
import { newTabOpensBar } from "../omnibox/newTabBarPolicy.ts";
import { takeMinimalismCounts } from "../telemetry/minimalismCounts.ts";
import { settingsSnapshot } from "../telemetry/settingsSnapshot.ts";
import { isConfigSettingKey } from "./configAllowlist.ts";
import { minimalismLookOf, MINIMALISM_HIDDEN, MINIMALISM_METRICS } from "../../lib/minimalismLook.ts";
import { DEFAULT_LOOK, resolveLook } from "../../lib/themeLook.ts";
import { ARC_LIGHTS_CENTER } from "../windows/dockMotion.ts";

test("minimalism is off by default, and malformed values stay off", () => {
  assert.equal(DEFAULT_SETTINGS.minimalismMode, false);
  for (const value of [undefined, null, "true", 1, {}]) assert.equal(parseSettings({ minimalismMode: value }).minimalismMode, false);
  assert.ok(SYNCED_SETTINGS.includes("minimalismMode"));
  assert.ok(isConfigSettingKey("minimalismMode"));
});

test("⌘T opens the command bar while it's on, and the saved New Tab choice comes back when it's off", () => {
  useBrowser.getState().hydrate({ settings: { newTabOpens: "page" } });
  useBrowser.getState().updateSettings({ minimalismMode: true });
  assert.equal(newTabOpensOf(useBrowser.getState().settings), "commandBar");
  assert.ok(newTabOpensBar(useBrowser.getState()));
  assert.equal(useBrowser.getState().settings.newTabOpens, "page");
  useBrowser.getState().updateSettings({ minimalismMode: false });
  assert.equal(newTabOpensOf(useBrowser.getState().settings), "page");
  assert.ok(!newTabOpensBar(useBrowser.getState()));
});

test("a minimal window has no toolbar field, so ⌘L opens the command bar in the centre, and its page is flat", () => {
  useBrowser.getState().hydrate({ settings: { addressBar: "toolbar", pageFrame: 9 } });
  const id = useBrowser.getState().createWindow();
  useBrowser.getState().newTab(id, { url: "https://example.com/" });
  assert.equal(addressFieldShown(useBrowser.getState(), id), true);
  useBrowser.getState().updateSettings({ minimalismMode: true });
  const s = useBrowser.getState();
  assert.ok(minimalismIn(s, id));
  assert.ok(addressBarInSidebar(s, id));
  assert.equal(addressFieldShown(s, id), false);
  assert.equal(commandKeyPlacement(s, id), "centredNoField");
  assert.deepEqual(openingLightsCenter(s, id)?.slice(0, 2), [...ARC_LIGHTS_CENTER]);
  assert.equal(s.settings.addressBar, "toolbar");
  assert.equal(s.settings.pageFrame, 9);
  useBrowser.getState().updateSettings({ minimalismMode: false });
  assert.ok(!addressBarInSidebar(useBrowser.getState(), id));
});

test("Little Ardia keeps its own toolbar", () => {
  useBrowser.getState().hydrate({ settings: { minimalismMode: true } });
  const id = useBrowser.getState().createWindow();
  assert.equal(minimalismIn(useBrowser.getState(), id), true);
  useBrowser.setState((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], kind: "small" } } }));
  assert.equal(minimalismIn(useBrowser.getState(), id), false);
});

test("the sidebar look gets denser rows, smaller tiles and no extra parts, and a theme's own metrics win", () => {
  const look = minimalismLookOf(DEFAULT_LOOK);
  assert.deepEqual(look.metrics, MINIMALISM_METRICS);
  for (const part of MINIMALISM_HIDDEN) assert.ok(look.hidden.has(part));
  assert.equal(minimalismLookOf(DEFAULT_LOOK), look);
  const themed = minimalismLookOf(resolveLook({ metrics: { rowHeight: 40 } }));
  assert.equal(themed.metrics.rowHeight, 40);
  assert.equal(themed.metrics.rowGap, MINIMALISM_METRICS.rowGap);
});

test("turning it on and off is counted, and the daily settings snapshot says whether it's on", () => {
  takeMinimalismCounts();
  useBrowser.getState().hydrate({ settings: {} });
  useBrowser.getState().updateSettings({ minimalismMode: true });
  useBrowser.getState().updateSettings({ minimalismMode: true });
  useBrowser.getState().updateSettings({ minimalismMode: false });
  assert.deepEqual(takeMinimalismCounts(), { minimalism_turned_on: 1, minimalism_turned_off: 1 });
  assert.deepEqual(takeMinimalismCounts(), { minimalism_turned_on: 0, minimalism_turned_off: 0 });
  const snap = settingsSnapshot({ ...DEFAULT_SETTINGS, minimalismMode: true });
  assert.equal(snap.setting_minimalismMode, "true");
  assert.equal(snap.default_minimalismMode, "false");
});

test("sync carries the mode", () => {
  useBrowser.getState().hydrate({ settings: {} });
  settingsAdapter.apply(new Map([["set:minimalismMode", { v: true }]]), ["set:minimalismMode"]);
  assert.equal(useBrowser.getState().settings.minimalismMode, true);
});
