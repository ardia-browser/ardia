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

test("on Linux the native buttons follow the desktop's layout live, and a layout change while another style is chosen waits for native", async () => {
  const { onWindowChromeChange } = await import("../../lib/windowChrome.ts");
  const { parseButtonLayout } = await import("../../lib/windowButtonLayout.ts");
  let state = { settings: { ...DEFAULT_SETTINGS } };
  let desktop = { raw: null, reported: false };
  const listeners = [];
  const desktopListeners = [];
  const store = { getState: () => state, subscribe: (listener) => (listeners.push(listener), () => listeners.splice(listeners.indexOf(listener), 1)) };
  const desktopStore = { getState: () => desktop, subscribe: (listener) => (desktopListeners.push(listener), () => desktopListeners.splice(desktopListeners.indexOf(listener), 1)) };
  let changes = 0;
  const stopWatching = onWindowChromeChange(() => changes++);
  const stop = startWindowButtonStyle(store, { styles: linux.WINDOW_BUTTON_STYLES, apply: linux.applyWindowButtonStyle }, desktopStore);
  const report = (raw) => {
    desktop = { raw, reported: true };
    for (const listener of [...desktopListeners]) listener(desktop);
  };
  const choose = (windowButtons) => {
    state = { settings: { ...state.settings, windowButtons } };
    for (const listener of [...listeners]) listener(state);
  };
  assert.deepEqual(linux.WINDOW_CHROME, linux.NATIVE_BUTTONS_CHROME);
  report("close,minimize,maximize:");
  assert.deepEqual(linux.WINDOW_CHROME, linux.nativeButtonsChrome(parseButtonLayout("close,minimize,maximize:")));
  assert.equal(changes, 1, "every window's layout hooks hear the change");
  report("close,minimize,maximize:");
  assert.equal(changes, 1, "the same layout again wakes nothing");
  choose("trafficLights");
  report("appmenu:close");
  assert.deepEqual(linux.WINDOW_CHROME, linux.TRAFFIC_LIGHTS_CHROME);
  choose("native");
  assert.deepEqual(linux.WINDOW_CHROME, linux.nativeButtonsChrome(parseButtonLayout("appmenu:close")));
  report(null);
  assert.deepEqual(linux.WINDOW_CHROME, linux.NATIVE_BUTTONS_CHROME, "a desktop that stops reporting a layout gets today's buttons back");
  desktop = { raw: "appmenu:close", reported: true, tiling: true };
  for (const listener of [...desktopListeners]) listener(desktop);
  assert.deepEqual(linux.WINDOW_CHROME.leadingButtons, [], "a tiling desktop draws no window buttons");
  assert.deepEqual(linux.WINDOW_CHROME.trailingButtons, ["menu"], "and keeps the … alone at the right");
  assert.ok(linux.WINDOW_CHROME.trailingWidth > 0 && linux.WINDOW_CHROME.titleBarHeight > 0, "with room kept for it");
  choose("trafficLights");
  assert.deepEqual(linux.WINDOW_CHROME, linux.TRAFFIC_LIGHTS_CHROME, "traffic lights still show on a tiling desktop");
  choose("hidden");
  assert.deepEqual(linux.WINDOW_CHROME, linux.HIDDEN_BUTTONS_CHROME);
  choose("native");
  report(null);
  stop();
  stopWatching();
  report("close:maximize");
  assert.deepEqual(linux.WINDOW_CHROME, linux.NATIVE_BUTTONS_CHROME, "a stopped sync leaves the chrome alone");
});

test("the daily settings snapshot says on Linux which side the desktop's buttons are on and how many, and nothing on the Mac or Windows", async () => {
  const { windowButtonLayoutSnapshot } = await import("../telemetry/settingsSnapshot.ts");
  assert.deepEqual(windowButtonLayoutSnapshot({ raw: "close:maximize", reported: true }, true), { window_buttons_side: "both", window_buttons_count: "2", window_buttons_from_desktop: "true", window_buttons_tiling_desktop: "false" });
  assert.deepEqual(windowButtonLayoutSnapshot({ raw: "appmenu:close", reported: true }, true), { window_buttons_side: "right", window_buttons_count: "1", window_buttons_from_desktop: "true", window_buttons_tiling_desktop: "false" });
  assert.deepEqual(windowButtonLayoutSnapshot({ raw: null, reported: false }, true), { window_buttons_side: "right", window_buttons_count: "3", window_buttons_from_desktop: "false", window_buttons_tiling_desktop: "false" });
  assert.deepEqual(windowButtonLayoutSnapshot({ raw: "menu:close", reported: true, tiling: true }, true), { window_buttons_side: "none", window_buttons_count: "0", window_buttons_from_desktop: "true", window_buttons_tiling_desktop: "true" });
  assert.deepEqual(windowButtonLayoutSnapshot({ raw: "close:maximize", reported: true }, false), {});
});
