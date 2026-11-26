import assert from "node:assert/strict";
import { test } from "node:test";
const { interfaceScaleNative } = await import("../../test-native/shell.ts");
const { INTERFACE_SCALE_STEPS, interfaceScaleLabel, steppedInterfaceScale, validInterfaceScale } = await import("../../lib/interfaceScale.ts");
const { DEFAULT_SETTINGS, parseSettings, SETTING_SPECS } = await import("./settings.ts");
const { SYNCED_SETTINGS } = await import("../sync/settingsAdapter.ts");
const { SETUP_SETTING_KEYS } = await import("../presets/setupCode.ts");
const { isConfigSettingKey } = await import("./configAllowlist.ts");
const { readConfig } = await import("../config/configSettings.ts");
const { useBrowser } = await import("../browser/store.ts");
const { chooseInterfaceScale } = await import("./actions.ts");
const { currentInterfaceScale, rootSizeOfFrame, useInterfaceScale } = await import("./interfaceScale.ts");
const { startInterfaceScale } = await import("./interfaceScaleSync.ts");
const { startInterfaceScaleRefresh } = await import("../app/interfaceScaleRefresh.ts");
const { useProfileIconPicker } = await import("../profiles/iconPicker.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Interface size steps from 80% to 150% in 5% steps, and 100% is the default", () => {
  assert.equal(INTERFACE_SCALE_STEPS.length, 15);
  assert.equal(INTERFACE_SCALE_STEPS[0], 0.8);
  assert.equal(INTERFACE_SCALE_STEPS.at(-1), 1.5);
  assert.deepEqual(INTERFACE_SCALE_STEPS.map(interfaceScaleLabel).slice(0, 5), ["80%", "85%", "90%", "95%", "100%"]);
  assert.equal(DEFAULT_SETTINGS.interfaceScale, 1);
  for (const step of INTERFACE_SCALE_STEPS) assert.ok(validInterfaceScale(step), String(step));
});

test("a saved Interface size off the steps or out of range reads as 100%", () => {
  for (const bad of [0.75, 0.83, 1.12, 1.55, 2, 0, -1, Number.NaN, Infinity, "1.25", null]) {
    assert.equal(validInterfaceScale(bad), false, String(bad));
    assert.equal(parseSettings({ interfaceScale: bad }).interfaceScale, 1, String(bad));
  }
  assert.equal(parseSettings({ interfaceScale: 1.25 }).interfaceScale, 1.25);
  assert.ok(validInterfaceScale(0.1 + 0.2 + 0.85), "float noise on a step still reads as that step");
});

test("choosing a size snaps it to the nearest step inside the range", () => {
  assert.equal(steppedInterfaceScale(1.12), 1.1);
  assert.equal(steppedInterfaceScale(1.13), 1.15);
  assert.equal(steppedInterfaceScale(0.5), 0.8);
  assert.equal(steppedInterfaceScale(3), 1.5);
  assert.equal(steppedInterfaceScale(Number.NaN), 1);
  assert.equal(steppedInterfaceScale(1.1500000000000001), 1.15);
});

test("Interface size belongs to this Mac: it doesn't sync or travel in a setup code, and config.json can set it", () => {
  assert.equal(SETTING_SPECS.interfaceScale.synced, false);
  assert.ok(!SYNCED_SETTINGS.includes("interfaceScale"));
  assert.ok(!SETUP_SETTING_KEYS.includes("interfaceScale"));
  assert.ok(isConfigSettingKey("interfaceScale"));
  const good = readConfig(JSON.stringify({ settings: { interfaceScale: 1.25 } }), DEFAULT_SETTINGS);
  assert.deepEqual(good.patch, { interfaceScale: 1.25 });
  assert.deepEqual(good.problems, []);
  const bad = readConfig(JSON.stringify({ settings: { interfaceScale: 1.3333 } }), DEFAULT_SETTINGS);
  assert.deepEqual(bad.patch, {});
  assert.match(bad.problems.join("\n"), /interfaceScale must be 0\.8, 0\.85, .* or 1\.5/);
});

test("a window frame stays physical and converts to root points by dividing by the scale", () => {
  assert.deepEqual(rootSizeOfFrame([100, 200, 1250, 750], 1.25), { width: 1000, height: 600 });
  assert.deepEqual(rootSizeOfFrame([0, 0, 800, 600], 1), { width: 800, height: 600 });
});

test("the first choice after a launch at native's size reaches native even when it is the default the setting already held", async () => {
  interfaceScaleNative.scale = 1.25;
  interfaceScaleNative.applied.length = 0;
  const stop = startInterfaceScale();
  try {
    assert.equal(currentInterfaceScale(), 1.25);
    assert.equal(S().settings.interfaceScale, 1);
    chooseInterfaceScale(1);
    await settle();
    assert.deepEqual(interfaceScaleNative.applied, [1], "Back to 100% is a choice, not a change of the stored number");
    assert.equal(currentInterfaceScale(), 1);
    S().updateSettings({ sidebarSide: S().settings.sidebarSide });
    await settle();
    assert.deepEqual(interfaceScaleNative.applied, [1], "an unrelated settings change asks native nothing");
  } finally {
    stop();
    const meta = S().settingsMeta;
    useBrowser.setState({ settingsMeta: { ...meta, chosen: meta.chosen.filter((key) => key !== "interfaceScale") } });
    useInterfaceScale.setState({ scale: 1 });
    interfaceScaleNative.scale = 1;
  }
});

test("a size native refuses is asked for once, again when the setting is chosen again, and not on unrelated store changes", async () => {
  interfaceScaleNative.scale = 1;
  interfaceScaleNative.asked.length = 0;
  interfaceScaleNative.refuses = true;
  const stop = startInterfaceScale();
  const warn = console.warn;
  console.warn = () => {};
  try {
    chooseInterfaceScale(1.5);
    await settle();
    assert.deepEqual(interfaceScaleNative.asked, [1.5]);
    assert.equal(currentInterfaceScale(), 1);
    useBrowser.setState({ windowOrder: [...S().windowOrder] });
    await settle();
    assert.deepEqual(interfaceScaleNative.asked, [1.5], "a store change that isn't a settings change doesn't retry");
    interfaceScaleNative.refuses = false;
    chooseInterfaceScale(1.5);
    await settle();
    assert.deepEqual(interfaceScaleNative.asked, [1.5, 1.5]);
    assert.equal(currentInterfaceScale(), 1.5);
  } finally {
    console.warn = warn;
    interfaceScaleNative.refuses = false;
    stop();
    chooseInterfaceScale(1);
    const meta = S().settingsMeta;
    useBrowser.setState({ settingsMeta: { ...meta, chosen: meta.chosen.filter((key) => key !== "interfaceScale") } });
    useInterfaceScale.setState({ scale: 1 });
    interfaceScaleNative.scale = 1;
  }
});

test("a size change closes what was placed from measurements in the old size, the profile icon picker included", () => {
  const stop = startInterfaceScaleRefresh();
  try {
    useProfileIconPicker.setState({ picker: { profileId: "default", windowId: "w1", place: "sidebar", anchor: { x: 10, y: 730, width: 20, height: 20 } } });
    useInterfaceScale.setState({ scale: 1.5 });
    assert.equal(useProfileIconPicker.getState().picker, null);
  } finally {
    stop();
    useInterfaceScale.setState({ scale: 1 });
  }
});

test("launch adopts native's scale until a size is chosen here, then the chosen size wins and every change reaches native", async () => {
  interfaceScaleNative.scale = 1.25;
  interfaceScaleNative.applied.length = 0;
  const stop = startInterfaceScale();
  try {
    assert.equal(currentInterfaceScale(), 1.25, "nothing chosen yet: the size native drew the first frame at stays");
    assert.deepEqual(interfaceScaleNative.applied, []);
    chooseInterfaceScale(1.5);
    await settle();
    assert.deepEqual(interfaceScaleNative.applied, [1.5]);
    assert.equal(currentInterfaceScale(), 1.5);
    assert.ok(S().settingsMeta.chosen.includes("interfaceScale"));
    chooseInterfaceScale(1);
    await settle();
    assert.equal(currentInterfaceScale(), 1);
    assert.equal(S().settings.interfaceScale, 1);
  } finally {
    stop();
  }
  interfaceScaleNative.scale = 0.9;
  interfaceScaleNative.applied.length = 0;
  const again = startInterfaceScale();
  try {
    await settle();
    assert.deepEqual(interfaceScaleNative.applied, [1], "a chosen size is pushed when native disagrees (a hand-edited defaults or settings file)");
    assert.equal(currentInterfaceScale(), 1);
  } finally {
    again();
    useInterfaceScale.setState({ scale: 1 });
    interfaceScaleNative.scale = 1;
  }
});
