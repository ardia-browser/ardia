import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, parseSettings, SETTING_SPECS } from "./settings.ts";
import { isConfigSettingKey } from "./configAllowlist.ts";
import { settingsSnapshot } from "../telemetry/settingsSnapshot.ts";
import { startWindowButtonStyle, windowButtonStyleIn } from "../windows/windowButtons.ts";
import { unshownSettings } from "../../components/settings/settingsIndex.ts";

const linux = await import("../../lib/platformChrome.linux.ts");

test("window buttons default to native, stay on this device, sit in config files and in the daily settings snapshot", () => {
  assert.equal(DEFAULT_SETTINGS.windowButtons, "native");
  assert.equal(SETTING_SPECS.windowButtons.synced, false);
  assert.ok(isConfigSettingKey("windowButtons"));
  assert.equal(parseSettings({ windowButtons: "trafficLights" }).windowButtons, "trafficLights");
  assert.equal(parseSettings({ windowButtons: "hidden" }).windowButtons, "hidden");
  assert.equal(parseSettings({ windowButtons: "windows" }).windowButtons, "native");
  assert.equal(settingsSnapshot(parseSettings({ windowButtons: "hidden" })).setting_windowButtons, "hidden");
  const snap = settingsSnapshot(parseSettings({ windowButtons: "trafficLights" }));
  assert.equal(snap.setting_windowButtons, "trafficLights");
  assert.equal(snap.default_windowButtons, "native");
});

test("a platform without the choice keeps its own buttons whatever was saved", () => {
  const lights = { settings: { ...DEFAULT_SETTINGS, windowButtons: "trafficLights" } };
  assert.equal(windowButtonStyleIn({ settings: DEFAULT_SETTINGS }, []), "trafficLights", "the Mac's are the traffic lights");
  assert.equal(windowButtonStyleIn(lights, linux.WINDOW_BUTTON_STYLES), "trafficLights");
  assert.equal(windowButtonStyleIn({ settings: DEFAULT_SETTINGS }, linux.WINDOW_BUTTON_STYLES), "native");
  assert.ok(unshownSettings(DEFAULT_SETTINGS, { top: false }).split("\n").includes("appearance.windowButtons"), "the Mac's Settings don't show the row");
});

test("on Linux the window chrome follows the setting live, before anything that reads it on the same change", () => {
  let state = { settings: { ...DEFAULT_SETTINGS } };
  const listeners = [];
  const store = { getState: () => state, subscribe: (listener) => (listeners.push(listener), () => listeners.splice(listeners.indexOf(listener), 1)) };
  const seen = [];
  const stop = startWindowButtonStyle(store, { styles: linux.WINDOW_BUTTON_STYLES, apply: linux.applyWindowButtonStyle });
  store.subscribe(() => seen.push(linux.WINDOW_CHROME.trailingWidth));
  assert.deepEqual(linux.WINDOW_CHROME, linux.NATIVE_BUTTONS_CHROME);
  const set = (windowButtons) => {
    state = { settings: { ...state.settings, windowButtons } };
    for (const listener of [...listeners]) listener(state);
  };
  set("trafficLights");
  assert.deepEqual(linux.WINDOW_CHROME, linux.TRAFFIC_LIGHTS_CHROME);
  set("native");
  assert.deepEqual(linux.WINDOW_CHROME, linux.NATIVE_BUTTONS_CHROME);
  assert.deepEqual(seen, [0, linux.NATIVE_BUTTONS_CHROME.trailingWidth]);
  stop();
  set("trafficLights");
  assert.deepEqual(linux.WINDOW_CHROME, linux.NATIVE_BUTTONS_CHROME, "a stopped sync leaves the chrome alone");
});

test("choosing Hidden on Linux takes the window buttons away live, and choosing native brings them back", () => {
  let state = { settings: { ...DEFAULT_SETTINGS } };
  const listeners = [];
  const store = { getState: () => state, subscribe: (listener) => (listeners.push(listener), () => listeners.splice(listeners.indexOf(listener), 1)) };
  const stop = startWindowButtonStyle(store, { styles: linux.WINDOW_BUTTON_STYLES, apply: linux.applyWindowButtonStyle });
  const set = (windowButtons) => {
    state = { settings: { ...state.settings, windowButtons } };
    for (const listener of [...listeners]) listener(state);
  };
  set("hidden");
  assert.deepEqual(linux.WINDOW_CHROME, linux.HIDDEN_BUTTONS_CHROME);
  assert.equal(windowButtonStyleIn(state, linux.WINDOW_BUTTON_STYLES), "hidden");
  set("trafficLights");
  assert.deepEqual(linux.WINDOW_CHROME, linux.TRAFFIC_LIGHTS_CHROME);
  set("hidden");
  assert.deepEqual(linux.WINDOW_CHROME, linux.HIDDEN_BUTTONS_CHROME);
  set("native");
  assert.deepEqual(linux.WINDOW_CHROME, linux.NATIVE_BUTTONS_CHROME);
  stop();
});

test("a saved choice of traffic lights applies before the first window draws", () => {
  const state = { settings: { ...DEFAULT_SETTINGS, windowButtons: "trafficLights" } };
  const stop = startWindowButtonStyle({ getState: () => state, subscribe: () => () => {} }, { styles: linux.WINDOW_BUTTON_STYLES, apply: linux.applyWindowButtonStyle });
  assert.deepEqual(linux.WINDOW_CHROME, linux.TRAFFIC_LIGHTS_CHROME);
  stop();
  linux.applyWindowButtonStyle("native");
});

test("on the Mac starting the sync changes nothing", () => {
  let subscribed = false;
  const store = { getState: () => ({ settings: { ...DEFAULT_SETTINGS, windowButtons: "native" } }), subscribe: () => ((subscribed = true), () => {}) };
  startWindowButtonStyle(store);
  assert.equal(subscribed, false);
});
