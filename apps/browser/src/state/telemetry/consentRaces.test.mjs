import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const relay = await import("./relay.ts");
const bar = await import("./barLoadFocus.ts");
const presses = await import("./tabPresses.ts");
const occlusion = await import("./windowOcclusionCounts.ts");
const diagnostics = await import("./diagnostics.ts");
const pressLoops = await import("./pressLoops.ts");
const work = await import("./workCounts.ts");
const failures = await import("./webNotificationFailures.ts");
const { reportNativeCrashes } = await import("./errors.ts");
const { showWebNotification } = await import("../site/webNotifications.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
after(() => client.setSharing(false, "settings"));

const turn = () => new Promise((resolve) => setImmediate(resolve));
const offAndOn = () => {
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
};

async function queued(event) {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === event).map((e) => e.properties);
}

test("F2 a bar load whose 2 s focus check spans sharing going off and on again isn't counted", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  webviews.set("bar-tab", { evaluate: async () => true });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    bar.noteBarLoad("bar-tab");
    offAndOn();
    mock.timers.tick(2000);
    await turn();
  } finally {
    mock.timers.reset();
  }
  assert.equal(bar.takeBarLoadFocusCounts().bar_loads, 0);
});

test("F2 a repeated row press whose native answer arrives after sharing went off and on again isn't counted", async () => {
  client.setSharing(true, "onboarding");
  const focus = stub.shellNativeModules.ArdiaFocus;
  const original = focus.pressRepeated;
  let answer;
  focus.pressRepeated = () => new Promise((resolve) => (answer = resolve));
  try {
    const pending = presses.noteRowPress(false);
    offAndOn();
    answer({ landedOn: "tab", ms: 100 });
    await pending;
  } finally {
    focus.pressRepeated = original;
  }
  presses.emitTabPresses(client.consentToken());
  assert.ok((await queued("tab_presses")).every((p) => !p.repeat_presses));
});

test("F2 a window focused while sharing was off isn't checked for occlusion once sharing is on", async () => {
  client.setSharing(false, "settings");
  stub.chromeWindowList.splice(0, stub.chromeWindowList.length, { id: "w-occluded", key: true, visible: true, chromeOccluded: false, occlusionVisible: true });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    stub.windows.emit({ type: "focus", windowId: "w-occluded" });
    client.setSharing(true, "settings");
    mock.timers.tick(1500);
    await turn();
  } finally {
    mock.timers.reset();
    stub.chromeWindowList.splice(0);
  }
  assert.equal(occlusion.takeWindowOcclusionCounts().focused_window_checks, 0);
});

test("F3 memory and settings snapshots started before sharing went off and on again aren't sent", async () => {
  client.setSharing(true, "onboarding");
  globalThis.acTestTasks = () => [{ type: "browser", memory: 300 * 1_048_576 }];
  const posted = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => (posted.push(String(init?.body ?? "")), { status: 503 });
  try {
    const hour = usage.devHourly();
    offAndOn();
    await hour;
  } finally {
    globalThis.acTestTasks = undefined;
    globalThis.fetch = fetch;
  }
  assert.deepEqual(await queued("perf_memory"), []);
  assert.deepEqual(await queued("settings_snapshot"), []);
  assert.equal(posted.some((body) => body.includes("perf_memory") || body.includes("settings_snapshot")), false);
});

test("F3 a crash read started while sharing was off doesn't send crashes from before sharing was turned on", async () => {
  client.setSharing(false, "settings");
  const app = stub.shellNativeModules.ArdiaApp;
  const original = app.crashReports;
  let answer;
  app.crashReports = () => new Promise((resolve) => (answer = resolve));
  try {
    const read = reportNativeCrashes();
    client.setSharing(true, "settings");
    answer([{ time: Date.now() - 60_000, process: "browser", appVersion: "0.3.0", exceptionType: "EXC_CRASH", signal: "SIGABRT", frames: [], exceptionFrames: [], images: [] }]);
    await read;
  } finally {
    app.crashReports = original;
  }
  assert.deepEqual(await queued("$exception"), []);
});

test("F3 main-process work keeps the newest sample as its baseline when two reads overlap", async () => {
  const app = stub.shellNativeModules.ArdiaApp;
  const original = app.diagnosticsSample;
  const pending = [];
  let answered = 0;
  const answer = async (read, sample) => {
    let done = false;
    read.then(() => (done = true), () => (done = true));
    for (let i = 0; i < 200 && !done; i++) {
      while (answered < pending.length) pending[answered++](sample);
      await turn();
    }
    assert.ok(done, "the read never got its sample");
    return read;
  };
  app.diagnosticsSample = () => new Promise((resolve) => pending.push(resolve));
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const first = diagnostics.takeMainProcessWork();
    const second = diagnostics.takeMainProcessWork();
    await answer(first, { cpuMs: 100, wakeups: 0 });
    await answer(second, { cpuMs: 200, wakeups: 0 });
    mock.timers.tick(120_000);
    const third = await answer(diagnostics.takeMainProcessWork(), { cpuMs: 1400, wakeups: 0 });
    assert.equal(third.browser_cpu_pct, 1);
  } finally {
    mock.timers.reset();
    app.diagnosticsSample = original;
  }
});

test("F3 a consent period change starts a new main-process baseline, so presses that brought Ardia forward before it aren't counted after it", async () => {
  client.setSharing(true, "settings");
  const app = stub.shellNativeModules.ArdiaApp;
  const original = app.diagnosticsSample;
  let sample = { cpuMs: 100, wakeups: 0, dragRegionActivatingPresses: 2 };
  app.diagnosticsSample = async () => ({ ...sample });
  mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  try {
    await diagnostics.takeMainProcessWork();
    sample = { cpuMs: 200, wakeups: 0, dragRegionActivatingPresses: 9 };
    offAndOn();
    for (let i = 0; i < 20; i++) await turn();
    mock.timers.tick(120_000);
    sample = { cpuMs: 1400, wakeups: 0, dragRegionActivatingPresses: 10 };
    const work = await diagnostics.takeMainProcessWork();
    assert.equal(work.drag_region_activating_presses, 1);
  } finally {
    mock.timers.reset();
    app.diagnosticsSample = original;
  }
});

test("F4 a web notification received while sharing was off isn't reported as failed after sharing is turned on", async () => {
  client.setSharing(false, "settings");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://site.example/" });
  const tabId = activeTabId(S(), w);
  const notifications = stub.shellNativeModules.ArdiaNotifications;
  const { notificationPermission, postNotification } = notifications;
  let allow;
  notifications.notificationPermission = () => new Promise((resolve) => (allow = resolve));
  notifications.postNotification = () => Promise.resolve({ icon: "none", errorCode: 1, errorDomain: "UNErrorDomain" });
  try {
    showWebNotification(tabId, { id: "n1", origin: "https://site.example", title: "Hi", body: "There", silent: false });
    client.setSharing(true, "settings");
    allow("granted");
    for (let i = 0; i < 5; i++) await turn();
  } finally {
    Object.assign(notifications, { notificationPermission, postNotification });
  }
  assert.deepEqual(await queued("web_notification_failed"), []);
});

test("F6 a press loop stamped with an earlier consent period isn't sent, and one stamped with the current period is", async () => {
  client.setSharing(true, "onboarding");
  const earlier = client.consentEpoch();
  offAndOn();
  pressLoops.trackPressLoopLong({ loop: "windowMove", inner: "windowMove", open: true, buttonsHeld: true, epoch: earlier });
  pressLoops.trackPressLoopLong({ loop: "windowMove", inner: "windowMove", open: true, buttonsHeld: true, epoch: "" });
  pressLoops.trackPressLoopLong({ loop: "windowMove", inner: "windowMove", open: true, buttonsHeld: true });
  pressLoops.trackPressLoopLong({ loop: "windowDragRegion", inner: "windowDragRegion", open: true, buttonsHeld: false, epoch: client.consentEpoch() });
  assert.deepEqual((await queued("press_loop_long")).map((p) => p.loop), ["windowDragRegion"]);
});

test("F6 the focus hand-off counts learn each new consent epoch, so native drops outcomes of hand-offs begun before it", () => {
  const focus = stub.shellNativeModules.ArdiaFocus;
  const epochs = [];
  focus.setConsentEpoch = (epoch) => void epochs.push(epoch);
  try {
    client.setSharing(true, "onboarding");
    offAndOn();
  } finally {
    delete focus.setConsentEpoch;
  }
  assert.equal(epochs.length >= 2, true);
  assert.notEqual(epochs.at(-1), epochs.at(-2));
});

const unpaintedRecord = (epoch) => ({ window: "regular", trigger: "key", seen: true, occlusion: "visible", overruled: false, appActive: true, windows: 1, views: 1, unpainted: 1, reasons: 2, epoch });

test("F6 a paint check stamped with an earlier consent period isn't reported", async () => {
  client.setSharing(true, "onboarding");
  const earlier = client.consentEpoch();
  offAndOn();
  diagnostics.trackWindowUnpainted(unpaintedRecord(earlier));
  diagnostics.trackWindowUnpainted(unpaintedRecord(""));
  assert.deepEqual(await queued("window_unpainted"), []);
});

test("F6 the unpainted-window cap starts over when sharing goes off and on again", async () => {
  client.setSharing(true, "onboarding");
  for (let i = 0; i < 25; i++) diagnostics.trackWindowUnpainted(unpaintedRecord(client.consentEpoch()));
  offAndOn();
  diagnostics.trackWindowUnpainted(unpaintedRecord(client.consentEpoch()));
  assert.equal((await queued("window_unpainted")).length, 1);
});

test("F7 notification failures send only fixed names for the error domain and the icon status", () => {
  const sent = { titleLength: 2, bodyLength: 5, iconRequested: true, iconSent: false };
  const odd = failures.webNotificationFailureProperties(sent, { icon: "icon at /Users/someone/x.png", errorDomain: "Some free text domain", errorCode: 3 });
  assert.equal(odd.icon_status, "other");
  assert.equal(odd.error_domain, "other");
  const known = failures.webNotificationFailureProperties(sent, { icon: "download_failed", errorDomain: "UNErrorDomain", errorCode: 1 });
  assert.equal(known.icon_status, "download_failed");
  assert.equal(known.error_domain, "UNErrorDomain");
});

test("F8 sync sends the total time spent applying bookmarks and history, as What's Sent says", async () => {
  client.setSharing(true, "onboarding");
  work.takeSyncWorkCounts();
  const bookmarks = work.withSyncWorkCounts("bookmark", { prefix: "b:", extract: () => null, apply: () => true });
  bookmarks.apply(new Map([["b:1", 1]]), new Set(), () => undefined, {});
  const taken = work.takeSyncWorkCounts();
  assert.equal(typeof taken.sync_bookmark_apply_ms_total, "number");
  assert.equal(typeof taken.sync_history_apply_ms_total, "number");
});

test("F5 a window that relays telemetry forwards events captured while sharing is off with no consent, so the leader only keeps them locally", () => {
  client.setSharing(false, "settings");
  const forwarded = [];
  relay.setTelemetryRelay({ capture: (event, _props, consent) => forwarded.push([event, consent]), log: (_level, message, _attributes, consent) => forwarded.push([message, consent]), resetId: async () => "", change: () => {}, installId: () => null });
  try {
    client.capture("relayed_while_off", {}, client.consentNow());
    client.queueLog("warn", "relayed log while off", {}, client.consentNow());
  } finally {
    relay.setTelemetryRelay(null);
  }
  assert.deepEqual(forwarded, [["relayed_while_off", null], ["relayed log while off", null]]);
});
