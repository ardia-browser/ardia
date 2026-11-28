import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const setTimeoutHoldingExit = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = setTimeoutHoldingExit(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};

globalThis.__DEV__ = false;
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/state/app/programControl.ts") || specifier !== "../pages/urls") return next(specifier, context);
    const stub = "export const isInternalTab = (t) => /^ardia:\\/\\//i.test(t.page.nav?.url ?? t.url ?? '');";
    return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
  },
});
const calls = [];
const replies = [];
globalThis.acTestCliControl = (on) => {
  calls.push(on);
  return new Promise((resolve) => replies.push(resolve));
};
const { useBrowser } = await import("../browser/store.ts");
const cli = await import("./programControl.ts");
const { userTurnedControlOff } = await import("./programControlSetting.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const settle = () => new Promise((r) => setImmediate(r));
const setOn = (on) => useBrowser.getState().updateSettings({ cliControl: on });
const { emitEvent } = await import("../../test-native/index.ts");
const emit = (status) => emitEvent("engine.cliControl", status);
const { markTabReady } = await import("../tabs/pageState.ts");
const ready = (tabId) => (markTabReady(tabId), cli.noteTabReady(tabId));

cli.startProgramControl();
await settle();
replies.shift()({ state: "off", generation: 0 });
await settle();

test("a failure from a superseded enable doesn't turn off a newer retry", async () => {
  calls.length = 0;
  setOn(true);
  const first = replies.shift();
  setOn(false);
  replies.shift()({ state: "off", generation: 1 });
  setOn(true);
  replies.shift()({ state: "starting", generation: 2 });
  await settle();
  first({ state: "off", generation: 1, reason: "Couldn't listen on 127.0.0.1." });
  emit({ state: "off", generation: 1, reason: "Couldn't listen on 127.0.0.1." });
  await settle();
  assert.deepEqual(calls, [true, false, true]);
  assert.equal(useBrowser.getState().settings.cliControl, true);
  assert.equal(cli.useControlServer.getState().server?.generation, 2);
});

test("a failure of the current start still turns the setting off and keeps the reason", async () => {
  emit({ state: "off", generation: 2, reason: "Couldn't write ArdiaControl.json: is a directory" });
  await settle();
  assert.equal(useBrowser.getState().settings.cliControl, false);
  assert.match(cli.useControlServer.getState().server?.reason ?? "", /is a directory/);
  assert.deepEqual(calls, [true, false, true, false]);
});

test("the engine stopping control itself is not the user turning it off", () => {
  assert.equal(useBrowser.getState().settings.cliControl, false);
  assert.equal(userTurnedControlOff(), false, "approving the Command Line plugin again must be able to turn control on");
  assert.ok(useBrowser.getState().settingsMeta.inferred.includes("cliControl"));
});

test("an Off the user chose, in Settings or with the pill's Stop, is still the user's", async () => {
  setOn(true);
  assert.equal(userTurnedControlOff(), false, "On is not an Off");
  setOn(false);
  assert.equal(userTurnedControlOff(), true, "the Settings toggle");
  setOn(true);
  cli.stopProgramControl();
  assert.equal(useBrowser.getState().settings.cliControl, false);
  assert.equal(userTurnedControlOff(), true, "the pill's Stop");
  while (replies.length) replies.shift()({ state: "off", generation: 2 });
  await settle();
});

test("the engine stopping control itself is counted once, by what stopped it, and never a user's Off", async () => {
  setConsentPeriod(true, "test-epoch");
  takeCliCounts();
  setOn(true);
  replies.shift()({ state: "on", generation: 2, connections: 0 });
  await settle();
  emit({ state: "off", generation: 2, reason: "The control server didn't start." });
  emit({ state: "off", generation: 2, reason: "The control server didn't start." });
  await settle();
  const selfStops = (counts) => Object.fromEntries(Object.entries(counts).filter(([key, n]) => key.startsWith("cli_control_self_stop_") && n));
  assert.deepEqual(selfStops(takeCliCounts()), { cli_control_self_stop_deadline: 1 });
  setOn(true);
  replies.shift()({ state: "on", generation: 2, connections: 0 });
  await settle();
  cli.stopProgramControl();
  while (replies.length) replies.shift()({ state: "off", generation: 2, reason: "Couldn't listen on 127.0.0.1." });
  await settle();
  assert.deepEqual(selfStops(takeCliCounts()), {}, "Stop from the pill is the user's choice");
  setConsentPeriod(false, null);
});

test("the engine hears which page the user is looking at while control is on", async () => {
  const active = [];
  globalThis.acTestCliActive = (id) => (active.push(id), Promise.resolve({}));
  const S = useBrowser.getState;
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  S().setFocusedWindow(w);
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://b.com", background: true });
  ready(a);
  ready(b);
  emit({ state: "on", generation: 3, connections: 0 });
  await settle();
  assert.deepEqual(active, [a]);
  S().activate(b);
  await settle();
  assert.deepEqual(active, [a, b]);
  S().newTab(w, {});
  await settle();
  assert.deepEqual(active, [a, b, null], "New Tab has no page");
  emit({ state: "off", generation: 3 });
  S().activate(a);
  await settle();
  assert.deepEqual(active, [a, b, null], "nothing is sent while control is off");
});

test("a page parked behind New Tab or an Ardia page is not what the user is looking at", async () => {
  const active = [];
  globalThis.acTestCliActive = (id) => (active.push(id), Promise.resolve({}));
  const { patchPage } = await import("../tabs/pageState.ts");
  const S = useBrowser.getState;
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  S().setFocusedWindow(w);
  const a = S().windows[w].tabIds[0];
  ready(a);
  emit({ state: "on", generation: 4, connections: 0 });
  await settle();
  assert.deepEqual(active, [a]);
  const tab = S().tabs[a];
  patchPage(a, { newTabShown: { url: tab.url, title: tab.title, favicon: null } });
  S().updateTab(a, { url: "", title: "", favicon: null });
  await settle();
  assert.deepEqual(active, [a, null], "Back to New Tab keeps the WebContents for Forward, but shows New Tab");
  patchPage(a, { newTabShown: null });
  S().updateTab(a, { url: tab.url, title: tab.title });
  await settle();
  assert.deepEqual(active, [a, null, a], "Forward shows the page again");
  S().updateTab(a, { url: "ardia://settings", page: { kind: "loaded", nav: { ...S().tabs[a].page.nav, url: "ardia://settings" } } });
  await settle();
  assert.deepEqual(active, [a, null, a, null], "an Ardia page over a parked WebContents");
  emit({ state: "off", generation: 4 });
  await settle();
});

test("a restore after the engine stopped control itself is counted as restored only when the engine says the server is on", async () => {
  const { restoreControlAtLaunch, controlStoppedItself } = await import("./programControlSetting.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  setConsentPeriod(true, "test-epoch");
  while (replies.length) replies.shift()({ state: "off", generation: 5 });
  await settle();
  setOn(true);
  replies.shift()({ state: "on", generation: 5, connections: 0 });
  await settle();
  emit({ state: "off", generation: 5, reason: "The control server didn't start." });
  await settle();
  assert.equal(controlStoppedItself(), true);
  replies.shift()({ state: "off", generation: 5, reason: "The control server didn't start." });
  await settle();
  takeCliCounts();
  restoreControlAtLaunch(consentToken());
  assert.equal(useBrowser.getState().settings.cliControl, true);
  replies.shift()({ state: "off", generation: 6, reason: "Couldn't listen on 127.0.0.1." });
  await settle();
  let counts = takeCliCounts();
  assert.deepEqual([counts.cli_control_restore_tries_launch, counts.cli_control_restored, counts.cli_control_self_stop_listen], [1, 0, 1], "a restore the engine refused again is a self-stop, not a recovery");
  assert.equal(controlStoppedItself(), true);
  replies.shift()({ state: "off", generation: 6, reason: "Couldn't listen on 127.0.0.1." });
  await settle();
  restoreControlAtLaunch(consentToken());
  replies.shift()({ state: "on", generation: 7, connections: 0 });
  await settle();
  emit({ state: "on", generation: 7, connections: 1 });
  await settle();
  counts = takeCliCounts();
  assert.deepEqual([counts.cli_control_restore_tries_launch, counts.cli_control_restored], [1, 1], "the server coming back is counted once");
  assert.equal(replies.length, 0);
  setConsentPeriod(false, null);
});

test("a restore the person cancels with Off isn't counted when they turn control on themselves later", async () => {
  const { restoreControlAtLaunch, controlStoppedItself } = await import("./programControlSetting.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  setConsentPeriod(true, "test-epoch");
  setOn(false);
  while (replies.length) replies.shift()({ state: "off", generation: 8 });
  await settle();
  setOn(true);
  replies.shift()({ state: "on", generation: 8, connections: 0 });
  await settle();
  emit({ state: "off", generation: 8, reason: "The control server didn't start." });
  await settle();
  replies.shift()({ state: "off", generation: 8, reason: "The control server didn't start." });
  await settle();
  assert.equal(controlStoppedItself(), true);
  takeCliCounts();
  restoreControlAtLaunch(consentToken());
  const restoring = replies.shift();
  cli.stopProgramControl();
  restoring({ state: "starting", generation: 9 });
  replies.shift()({ state: "off", generation: 9 });
  await settle();
  setOn(true);
  replies.shift()({ state: "on", generation: 10, connections: 0 });
  await settle();
  emit({ state: "on", generation: 10, connections: 1 });
  await settle();
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_control_restore_tries_launch, counts.cli_control_restored], [1, 0], "the person's own On isn't the cancelled restore coming back");
  assert.equal(replies.length, 0);
  setConsentPeriod(false, null);
});

test("an earlier generation's off that arrives after a restore starts doesn't erase the restore", async () => {
  const { restoreControlAtLaunch, controlStoppedItself } = await import("./programControlSetting.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  setConsentPeriod(true, "test-epoch");
  setOn(false);
  while (replies.length) replies.shift()({ state: "off", generation: 11 });
  await settle();
  setOn(true);
  replies.shift()({ state: "on", generation: 11, connections: 0 });
  await settle();
  emit({ state: "off", generation: 11, reason: "The control server didn't start." });
  await settle();
  replies.shift()({ state: "off", generation: 11, reason: "The control server didn't start." });
  await settle();
  assert.equal(controlStoppedItself(), true);
  takeCliCounts();
  restoreControlAtLaunch(consentToken());
  emit({ state: "off", generation: 11 });
  await settle();
  replies.shift()({ state: "starting", generation: 12 });
  await settle();
  emit({ state: "off", generation: 11 });
  emit({ state: "on", generation: 12, connections: 0 });
  await settle();
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_control_restore_tries_launch, counts.cli_control_restored], [1, 1], "the restore's own generation coming on is what counts");
  assert.equal(replies.length, 0);
  setConsentPeriod(false, null);
});
