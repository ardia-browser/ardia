import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { menuState } = await import("./menuState.ts");
const { runCommand } = await import("./commands.ts");
const { gestureRoute } = await import("./gestureTab.ts");
const { settingsSnapshot } = await import("../telemetry/settingsSnapshot.ts");
const { noteMouseGestureRun, takeMouseGestureCounts } = await import("../telemetry/mouseGestureCounts.ts");
const { isConfigSettingKey } = await import("../settings/configAllowlist.ts");
const { SETTING_SPECS } = await import("../settings/settings.ts");
await import("../../test-native/index.ts");
const client = await import("../telemetry/client.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();

test("mouse gestures are off until turned on, and the menu state tells the Mac when they are", () => {
  S().hydrate({});
  S().createWindow({ url: "https://a.com/" });
  assert.equal(S().settings.mouseGestures, false);
  assert.equal(menuState(S()).mouseGestures, false);
  S().updateSettings({ mouseGestures: true });
  assert.equal(menuState(S()).mouseGestures, true);
  S().updateSettings({ mouseGestures: false });
  assert.equal(menuState(S()).mouseGestures, false);
});

test("the setting syncs, can be set from the config file and is in the daily snapshot", () => {
  assert.equal(SETTING_SPECS.mouseGestures.synced, true);
  assert.ok(isConfigSettingKey("mouseGestures"));
  assert.equal(settingsSnapshot({ ...S().settings, mouseGestures: true }).setting_mouseGestures, "true");
  assert.equal(settingsSnapshot({ ...S().settings, mouseGestures: false }).default_mouseGestures, "false");
});

test("gesture runs are counted by action only, with consent, and anything else is dropped", async () => {
  noteMouseGestureRun("back", null);
  assert.equal(takeMouseGestureCounts().mouse_gesture_runs_back, 0, "not counted without a consent token");
  await client.setSharing(true, "onboarding");
  const consent = client.consentToken();
  noteMouseGestureRun("back", consent);
  noteMouseGestureRun("back", consent);
  noteMouseGestureRun("close_tab", consent);
  noteMouseGestureRun("closeTab", consent);
  noteMouseGestureRun("https://a.com/", consent);
  const counts = takeMouseGestureCounts();
  assert.equal(counts.mouse_gesture_runs_back, 2);
  assert.equal(counts.mouse_gesture_runs_close_tab, 1);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.keys(counts).length, 8);
  assert.deepEqual(Object.values(takeMouseGestureCounts()), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("Close Tab drawn on a page closes that tab only, even with a sidebar multi-selection", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  S().setFocusedWindow(w);
  const [a] = S().windows[w].tabIds;
  const b = S().newTab(w, { url: "https://b.com/" });
  const c = S().newTab(w, { url: "https://c.com/" });
  S().activate(b);
  S().setSelection(w, [b, c]);
  const event = { command: "closeTab", arg: null, windowId: w, mouseGesture: "close_tab", gestureTabId: b };
  const route = gestureRoute(S(), event);
  assert.deepEqual(route, { run: true, tabId: b });
  runCommand(event, { tabId: route.tabId });
  assert.equal(S().tabs[b], undefined);
  assert.equal(S().tabs[a]?.url, "https://a.com/");
  assert.equal(S().tabs[c]?.url, "https://c.com/");
});

test("a gesture runs on its own tab, drops when that tab is gone, and keeps Little Ardia's limits", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const [a] = S().windows[w].tabIds;
  const b = S().newTab(w, { url: "https://b.com/" });
  const other = S().createWindow({ url: "https://c.com/" });
  const [c] = S().windows[other].tabIds;
  const small = S().createWindow({ kind: "small", url: "https://little.example/" });
  const route = (windowId, gestureTabId, command = "back", mouseGesture = "back") => gestureRoute(S(), { command, windowId, gestureTabId, mouseGesture });
  assert.deepEqual(route(w, a), { run: true, tabId: a });
  assert.deepEqual(route(w, a, "back", null), { run: true, tabId: null }, "a command that isn't a gesture is untouched");
  assert.deepEqual(route(w, null), { run: true, tabId: null }, "a gesture whose page tab is unknown runs as the window's command");
  assert.deepEqual(route(w, c), { run: false, tabId: null }, "a tab that moved to another window is never acted on");
  S().closeTab(b);
  assert.deepEqual(route(w, b, "closeTab", "close_tab"), { run: false, tabId: null }, "a closed tab never falls back to the active tab or the selection");
  const [little] = S().windows[small].tabIds;
  assert.deepEqual(route(small, little, "nextTab", "next_tab"), { run: false, tabId: null }, "Little Ardia keeps Next Tab off, key window or not");
  assert.deepEqual(route(small, little, "back"), { run: true, tabId: null }, "Little Ardia keeps its own routing");
  assert.deepEqual(route(small, a, "back"), { run: false, tabId: null }, "a main window's tab never runs through Little Ardia");
  assert.deepEqual(route("w-gone", null, "closeTab", "close_tab"), { run: false, tabId: null }, "a window that closed never falls back to another one");
  S().closeWindow(small);
  assert.equal(S().windows[small], undefined);
  assert.deepEqual(route(small, little, "closeTab", "close_tab"), { run: false, tabId: null }, "a Little Ardia window that closed never sends its gesture to the main window");
});
