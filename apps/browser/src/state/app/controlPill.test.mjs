import assert from "node:assert/strict";
import { after, test } from "node:test";
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const { isConfigSettingKey, CONFIG_EXCLUDED_KEYS } = await import("../settings/configAllowlist.ts");
const { SYNCED_SETTINGS } = await import("../sync/settingsAdapter.ts");
const { useBrowser } = await import("../browser/store.ts");
const programControl = await import("./programControl.ts");
const telemetryClient = await import("../telemetry/client.ts");
const cliCounts = await import("../telemetry/cliCounts.ts");

after(() => telemetryClient.setSharing(false, "settings"));

const S = () => useBrowser.getState();

function resetPillState() {
  programControl.noteSocketServing(false);
  programControl.useControlServer.setState({ server: { state: "off", connections: 0, generation: 0, file: "" } });
  S().updateSettings({ cliControl: false, showCliPill: true, compactCliPill: false });
  programControl.useControlIndicator.setState({ shown: false, caller: null });
  cliCounts.takeCliCounts();
}

test("the control pill shows in full unless the compact switch is on, and config.json can set compactCliPill", () => {
  assert.equal(DEFAULT_SETTINGS.compactCliPill, false);
  assert.equal(isConfigSettingKey("compactCliPill"), true);
});

test("showCliPill defaults to true, syncs, and stays excluded from config.json", () => {
  assert.equal(DEFAULT_SETTINGS.showCliPill, true);
  assert.equal(SYNCED_SETTINGS.includes("showCliPill"), true);
  assert.equal(isConfigSettingKey("showCliPill"), false);
  assert.equal(CONFIG_EXCLUDED_KEYS.includes("showCliPill"), true);
});

test("every pill shown is counted, and the compact ones again on their own", () => {
  cliCounts.takeCliCounts();
  cliCounts.noteCliPillShown(false);
  cliCounts.noteCliPillShown(true);
  cliCounts.noteCliPillShown(true);
  const counts = cliCounts.takeCliCounts();
  assert.deepEqual([counts.cli_pill_shows, counts.cli_pill_compact_shows], [3, 2]);
  assert.deepEqual([cliCounts.takeCliCounts().cli_pill_shows, cliCounts.takeCliCounts().cli_pill_compact_shows], [0, 0]);
});

test("noteCliPillDismissed respects telemetry consent and resets on takeCliCounts", () => {
  telemetryClient.loadChoice();
  telemetryClient.setSharing(false, "settings");
  cliCounts.takeCliCounts();
  cliCounts.noteCliPillDismissed();
  assert.equal(cliCounts.takeCliCounts().cli_pill_dismissals, 0);
  telemetryClient.setSharing(true, "settings");
  cliCounts.noteCliPillDismissed();
  cliCounts.noteCliPillDismissed();
  assert.equal(cliCounts.takeCliCounts().cli_pill_dismissals, 2);
  assert.equal(cliCounts.takeCliCounts().cli_pill_dismissals, 0);
});

test("dismissing hides the pill without stopping control, ignores double clicks, and stays hidden until cliControl resets", (t) => {
  resetPillState();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  telemetryClient.loadChoice();
  telemetryClient.setSharing(true, "settings");
  S().updateSettings({ cliControl: true, showCliPill: true });
  programControl.noteSocketServing(true);
  programControl.noteControlCaller({ name: "Claude Code", app: null });
  programControl.noteSocketRun(1);
  assert.equal(programControl.useControlIndicator.getState().shown, true);
  cliCounts.takeCliCounts();

  programControl.dismissControlPill();
  programControl.dismissControlPill();
  assert.equal(programControl.useControlIndicator.getState().shown, false);
  assert.equal(S().settings.cliControl, true);
  assert.equal(cliCounts.takeCliCounts().cli_pill_dismissals, 1);

  programControl.noteSocketRun(-1);
  programControl.noteSocketRun(1);
  programControl.useControlServer.setState({ server: { state: "on", connections: 1, generation: 1, file: "" } });
  assert.equal(programControl.useControlIndicator.getState().shown, false);
  assert.equal(cliCounts.takeCliCounts().cli_pill_shows, 0);

  programControl.noteSocketRun(-1);
  programControl.noteSocketServing(false);
  programControl.useControlServer.setState({ server: { state: "off", connections: 0, generation: 2, file: "" } });
  S().updateSettings({ cliControl: false });
  S().updateSettings({ cliControl: true });
  programControl.noteSocketServing(true);
  programControl.noteSocketRun(1);
  assert.equal(programControl.useControlIndicator.getState().shown, true);
  programControl.noteSocketRun(-1);
  resetPillState();
});

test("dismissing during the 3-second idle hold finishes the logical hold and prevents stale caller leakage", (t) => {
  resetPillState();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  telemetryClient.loadChoice();
  telemetryClient.setSharing(true, "settings");
  S().updateSettings({ cliControl: true, showCliPill: true });
  programControl.noteSocketServing(true);
  programControl.noteControlCaller({ name: "Claude Code", app: null });
  programControl.noteSocketRun(1);
  programControl.noteSocketRun(-1);
  assert.equal(programControl.useControlIndicator.getState().shown, true);
  cliCounts.takeCliCounts();

  programControl.dismissControlPill();
  assert.equal(programControl.useControlIndicator.getState().shown, false);
  assert.equal(cliCounts.takeCliCounts().cli_pill_dismissals, 1);

  S().updateSettings({ showCliPill: false });
  S().updateSettings({ showCliPill: true });
  assert.equal(programControl.useControlIndicator.getState().shown, false);

  programControl.useControlServer.setState({ server: { state: "on", connections: 1, generation: 3, file: "" } });
  assert.deepEqual(programControl.useControlIndicator.getState(), { shown: true, caller: null });
  resetPillState();
});

test("toggling showCliPill hides mid-session, clears dismiss on re-enable, preserves active caller, and prevents stale caller after hidden session", (t) => {
  resetPillState();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  S().updateSettings({ cliControl: true, showCliPill: true });
  programControl.useControlServer.setState({ server: { state: "on", connections: 1, generation: 4, file: "" } });
  programControl.noteControlCaller({ name: "Claude Code", app: null });
  assert.deepEqual(programControl.useControlIndicator.getState(), { shown: true, caller: { name: "Claude Code", app: null } });

  programControl.dismissControlPill();
  assert.equal(programControl.useControlIndicator.getState().shown, false);
  S().updateSettings({ showCliPill: false });
  S().updateSettings({ showCliPill: true });
  assert.deepEqual(programControl.useControlIndicator.getState(), { shown: true, caller: { name: "Claude Code", app: null } });

  S().updateSettings({ showCliPill: false });
  assert.equal(programControl.useControlIndicator.getState().shown, false);
  assert.equal(S().settings.cliControl, true);

  programControl.useControlServer.setState({ server: { state: "on", connections: 0, generation: 5, file: "" } });
  t.mock.timers.tick(3000);
  programControl.useControlServer.setState({ server: { state: "on", connections: 1, generation: 6, file: "" } });
  assert.equal(programControl.useControlIndicator.getState().shown, false);

  S().updateSettings({ showCliPill: true });
  assert.deepEqual(programControl.useControlIndicator.getState(), { shown: true, caller: null });
  resetPillState();
});
