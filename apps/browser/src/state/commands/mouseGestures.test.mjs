import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { menuState } = await import("./menuState.ts");
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
