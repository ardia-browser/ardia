import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
const now = Date.now();
const previousStart = now - 3 * 60 * 60_000;
Object.assign(stub.appInfo, { appVersion: "0.3.1", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false, processStart: now - 2000, bootTime: now - 60_000 });
const previousContext = {
  at: previousStart + 90 * 60_000,
  session_start: previousStart,
  tabs: 2464,
  windows: 2,
  profiles: 1,
  footprint_mb: 1762,
  app_memory_mb: 9800,
  free_disk_gb: 3.4,
  memory_pressure: "critical",
  page_processes_gone: 1,
};
stub.docs.set(
  "telemetry.json",
  JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.0", sessionOpen: true, lastLaunchAt: previousStart, context: previousContext }),
);
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const { reportNativeCrashes } = await import("./errors.ts");
const diagnostics = await import("./diagnostics.ts");
const presses = await import("./tabPresses.ts");
after(() => client.setSharing(false, "settings"));

const events = (name) => JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").events?.filter((e) => e.event === name) ?? [];
const session = client.startClient();

test("an unclean launch hands back the last context the crashed session saved", () => {
  assert.equal(session.previous, "unclean");
  assert.equal(session.updatedFrom, "0.3.0");
  assert.deepEqual(session.context, previousContext);
  const props = diagnostics.contextProperties(session.context, "prev_", now);
  assert.equal(props.prev_tabs, 2464);
  assert.equal(props.prev_memory_pressure, "critical");
  assert.equal(props.prev_session_min, 90);
  assert.equal(props.prev_age_min, 90);
});

test("a crash of the previous version arrives on the next one, tagged with the version that crashed and its context", async () => {
  stub.diagnostics.crashReports = [
    {
      time: previousStart + 100 * 60_000,
      process: "browser",
      appVersion: "0.3.0",
      build: "104",
      exceptionType: "EXC_BREAKPOINT",
      signal: "SIGTRAP",
      terminationNamespace: "SIGNAL",
      uptimeSeconds: 6000,
      vmWritableMB: 12000,
      frames: [{ image: "Chromium Framework", offset: 0x10 }],
    },
    {
      time: previousStart + 101 * 60_000,
      process: "renderer",
      engineVersion: "156.0.8078.79",
      exceptionType: "EXC_BAD_ACCESS",
      signal: "SIGSEGV",
      uptimeSeconds: 40,
      frames: [{ image: "Chromium Framework", offset: 0x20 }],
    },
  ];
  await reportNativeCrashes([session.context]);
  const [browser, renderer] = events("$exception").slice(-2).map((e) => e.properties);
  assert.equal(browser.source, "native_crash");
  assert.equal(browser.crash_process, "browser");
  assert.equal(browser.crashed_version, "0.3.0");
  assert.equal(browser.crashed_build, "104");
  assert.equal(browser.$app_version, "0.3.1");
  assert.equal(browser.crash_termination, "SIGNAL");
  assert.equal(browser.crash_uptime_s, 6000);
  assert.equal(browser.crash_vm_writable_mb, 12000);
  assert.equal(browser.ctx_tabs, 2464);
  assert.equal(browser.ctx_free_disk_gb, 3.4);
  assert.equal(browser.ctx_age_min, 10);
  assert.equal(renderer.source, "helper_crash");
  assert.equal(renderer.crash_process, "renderer");
  assert.equal(renderer.crashed_version, null);
  assert.equal(renderer.crashed_engine_version, "156.0.8078.79");
  assert.equal(renderer.$exception_list[0].mechanism.type, "helper_crash");
  assert.equal(client.crashCursor(), previousStart + 101 * 60_000);
});

test("a crash gets the latest context sampled at or before it in its own session, else none", async () => {
  const start = stub.appInfo.processStart;
  const sample = (at) => ({ ...previousContext, at, session_start: start, tabs: at - start });
  stub.diagnostics.crashReports = [
    { time: start + 1000, fileTime: start + 1900, process: "renderer", frames: [] },
    { time: start + 1200, fileTime: start + 1950, process: "renderer", frames: [] },
  ];
  await reportNativeCrashes([session.context, sample(start + 500), sample(start + 1100)]);
  const [first, second] = events("$exception").slice(-2).map((e) => e.properties);
  assert.equal(first.ctx_tabs, 500);
  assert.equal(second.ctx_tabs, 1100);
  assert.equal(client.crashCursor(), start + 1950);
  stub.diagnostics.crashReports = [{ time: start + 2500, fileTime: start + 2600, process: "renderer", frames: [] }];
  await reportNativeCrashes([session.context, sample(start + 3000)]);
  const late = events("$exception").at(-1).properties;
  assert.equal("ctx_tabs" in late, false, "a sample taken after the crash, or one from an older session, is not its context");
});

test("a crash from before the saved context's session gets no context", async () => {
  stub.diagnostics.crashReports = [{ time: previousStart - 1000 + 200 * 60_000, process: "gpu", frames: [] }];
  await reportNativeCrashes([{ ...previousContext, session_start: previousStart + 300 * 60_000 }]);
  const props = events("$exception").at(-1).properties;
  assert.equal(props.crash_process, "gpu");
  assert.equal("ctx_tabs" in props, false);
});

test("hardware comes as chip, GPU, memory, displays and hardware decode flags, no model or serial", async () => {
  stub.diagnostics.hardware = { chip: "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz", gpu: "AMD Radeon Pro 5500M", memoryGB: 32, displays: 2, maxScale: 2, hardwareDecode: { av1: false, vp9: false, hevc: true, h264: true } };
  assert.deepEqual(await diagnostics.hardwareProperties(), {
    chip: "Intel Core i9-9980HK CPU",
    gpu: "AMD Radeon Pro 5500M",
    memory_gb: 32,
    displays: 2,
    max_scale: 2,
    hw_decode_av1: false,
    hw_decode_vp9: false,
    hw_decode_hevc: true,
    hw_decode_h264: true,
  });
});

test("a recorded context is saved for the next launch and holds only counts and sizes", async () => {
  const context = await diagnostics.recordContext();
  assert.deepEqual(Object.keys(context).sort(), ["app_memory_mb", "at", "footprint_mb", "free_disk_gb", "hermes_heap_mb", "memory_pressure", "page_processes_gone", "profiles", "session_start", "tabs", "webui_page", "webui_pages", "windows"]);
  assert.equal(context.webui_page, null);
  assert.equal(context.webui_pages, null);
  assert.equal(context.footprint_mb, 500);
  assert.equal(JSON.parse(stub.docs.get("telemetry.json")).context.footprint_mb, 500);
  assert.equal(context.hermes_heap_mb, null, "an engine that reports no heap size leaves it null");
});

test("the context sample holds Hermes's JS heap in whole megabytes, null when it can't be read, and a crash carries it as ctx_hermes_heap_mb", async () => {
  const previous = globalThis.HermesInternal;
  const heap = (stats) => (globalThis.HermesInternal = { getInstrumentedStats: stats });
  try {
    heap(() => ({ js_heapSize: 3.5 * 1024 * 1024 * 1024 }));
    const big = await diagnostics.recordContext();
    assert.equal(big.hermes_heap_mb, 3584);
    assert.equal(JSON.parse(stub.docs.get("telemetry.json")).context.hermes_heap_mb, 3584);

    heap(() => ({ js_heapSize: 123_456_789 }));
    assert.equal((await diagnostics.recordContext()).hermes_heap_mb, 118);

    for (const unreadable of [() => ({}), () => ({ js_heapSize: "big" }), () => ({ js_heapSize: -1 }), () => ({ js_heapSize: NaN }), () => undefined, () => { throw new Error("stats"); }]) {
      heap(unreadable);
      assert.equal((await diagnostics.recordContext()).hermes_heap_mb, null);
    }
    globalThis.HermesInternal = {};
    assert.equal((await diagnostics.recordContext()).hermes_heap_mb, null);
    globalThis.HermesInternal = undefined;
    assert.equal((await diagnostics.recordContext()).hermes_heap_mb, null);

    heap(() => ({ js_heapSize: 2 * 1024 * 1024 * 1024 }));
    const sampled = await diagnostics.recordContext();
    const time = Math.max(sampled.at, client.crashCursor()) + 1000;
    stub.diagnostics.crashReports = [{ time, fileTime: time + 500, process: "browser", exceptionType: "EXC_CRASH", signal: "SIGABRT", frames: [{ image: "hermes", offset: 0x19bea4 }] }];
    await reportNativeCrashes([sampled]);
    const crash = events("$exception").at(-1).properties;
    assert.equal(crash.ctx_hermes_heap_mb, 2048);
    assert.equal(diagnostics.contextProperties({ at: 5000, session_start: 1000 }, "ctx_", 6000).ctx_hermes_heap_mb, null, "a sample saved before the field existed");
  } finally {
    globalThis.HermesInternal = previous;
  }
});

test("the built-in page is the host and first path segment of an ardia:// or chrome:// URL, and null for any web URL", () => {
  const page = diagnostics.webuiPage;
  assert.equal(page("chrome://settings/cookies"), "settings/cookies");
  assert.equal(page("ardia://settings/cookies"), "settings/cookies");
  assert.equal(page("CHROME://Settings/Cookies/detail?site=https%3A%2F%2Fprivate.example#top"), "settings/cookies");
  assert.equal(page("chrome://settings/?search=private"), "settings");
  assert.equal(page("ardia://history"), "history");
  assert.equal(page("ardia://newtab/"), "newtab");
  assert.equal(page("chrome://net-internals#dns"), "net-internals");
  assert.equal(page("chrome://settings/some-text-that-is-longer-than-a-page-name-could-be"), "settings");
  for (const url of ["https://example.com/settings/cookies", "http://localhost:3000/chrome://settings", "https://chrome/settings", "view-source:chrome://settings/cookies", "about:blank", "file:///Users/me/ardia://history", "chrome://user@private.example/x", "chrome://my.private.example/x", "chrome://", "", null, undefined]) {
    assert.equal(page(url), null, String(url));
  }
});

test("the context sample records the built-in page the active tab is on, and a navigation to or from one samples at once", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://private.example/inbox?token=secret" });
  const tab = S().windows[w].tabIds[0];
  assert.equal((await diagnostics.recordContext()).webui_page, null);

  const sampled = () => diagnostics.contextSamples().length;
  const waitForSample = async (from) => {
    for (let i = 0; i < 200 && sampled() === from; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return diagnostics.contextSamples().at(-1);
  };
  diagnostics.startContextSamples();
  try {
    let from = sampled();
    S().updateTab(tab, { url: "https://private.example/other", title: "Other" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sampled(), from, "a web page change takes no extra sample");

    S().updateTab(tab, { url: "chrome://settings/cookies" });
    const settings = await waitForSample(from);
    assert.equal(settings.webui_page, "settings/cookies");
    assert.equal(settings.session_start, stub.appInfo.processStart);
    assert.equal(JSON.parse(stub.docs.get("telemetry.json")).context.webui_page, "settings/cookies");

    const after = Math.max(settings.at, client.crashCursor()) + 1000;
    stub.diagnostics.crashReports = [{ time: after, fileTime: after + 500, process: "browser", frames: [{ image: "Chromium Framework", offset: 0x30 }] }];
    await reportNativeCrashes([settings]);
    const crash = events("$exception").at(-1).properties;
    assert.equal(crash.crash_process, "browser");
    assert.equal(crash.ctx_webui_page, "settings/cookies");

    from = sampled();
    S().updateTab(tab, { url: "https://private.example/" });
    const away = await waitForSample(from);
    assert.equal(away.webui_page, null, "leaving the page is sampled too, so a later crash isn't blamed on it");
  } finally {
    diagnostics.stopContextSamples();
  }
});

test("the built-in page comes from the focused window's tab, a Little Ardia window included", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  S().createWindow({ url: "chrome://history" });
  const small = S().createWindow({ kind: "small", url: "https://private.example/" });
  S().setFocusedWindow(small);
  assert.equal((await diagnostics.recordContext()).webui_page, null);
});

test("a burst of built-in page samples keeps the samples from before it, so a crash read an hour later still finds its context", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  useBrowser.getState().hydrate({});
  useBrowser.getState().createWindow({ url: "chrome://settings/cookies" });
  const beforeBurst = await diagnostics.recordContext();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 30; i++) await diagnostics.recordContext();
  const found = diagnostics.contextAt(diagnostics.contextSamples(), beforeBurst.at, [beforeBurst.session_start]);
  assert.equal(found?.at, beforeBurst.at);
  assert.equal(found?.webui_page, "settings/cookies");
});

test("two samples recorded in the same millisecond: the later one is the context", () => {
  const first = { at: 1000, session_start: 500, webui_page: null };
  const later = { at: 1000, session_start: 500, webui_page: "settings/cookies" };
  assert.equal(diagnostics.contextAt([first, later], 1000, [500])?.webui_page, "settings/cookies");
});

test("the saved context keeps the last 3 built-in pages, and a native crash sends them with their age in minutes as ctx_webui_pages", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const S = () => useBrowser.getState();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  S().hydrate({});
  const w = S().createWindow({ url: "https://private.example/" });
  const tab = S().windows[w].tabIds[0];
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const visit = async (url, minutesLater) => {
      clock += minutesLater * 60_000;
      S().updateTab(tab, { url });
      return diagnostics.recordContext();
    };
    await visit("chrome://history", 0);
    await visit("chrome://settings/cookies/detail?site=https%3A%2F%2Fprivate.example", 5);
    await visit("https://private.example/inbox?token=secret", 5);
    await visit("ardia://downloads", 5);
    await visit("chrome://flags/?q=secret", 5);
    const last = await visit("chrome://flags/", 2);
    assert.equal(last.webui_page, "flags");
    const saved = JSON.parse(stub.docs.get("telemetry.json")).context;
    assert.equal(saved.webui_pages, last.webui_pages);
    assert.equal(last.webui_pages.split(",").length, 3, "the oldest of four pages is dropped and a page seen twice counts once");
    assert.equal(last.webui_pages.includes("history"), false);
    assert.equal(last.webui_pages.includes("private"), false);

    const time = clock + 8 * 60_000;
    stub.diagnostics.crashReports = [{ time, fileTime: time + 500, process: "browser", exceptionType: "EXC_BAD_ACCESS", signal: "SIGSEGV", frames: [{ image: "Chromium Framework", offset: 0xee9858 }] }];
    await reportNativeCrashes([saved]);
    const crash = events("$exception").at(-1).properties;
    assert.equal(crash.crash_process, "browser");
    assert.equal(crash.ctx_webui_page, "flags");
    assert.equal(crash.ctx_webui_pages, "flags:8,downloads:15,settings/cookies:25");

    S().updateTab(tab, { url: "https://private.example/" });
    clock += 60_000;
    const away = await diagnostics.recordContext();
    assert.equal(away.webui_page, null);
    assert.equal(away.webui_pages, last.webui_pages, "leaving to a web page keeps the pages the session was on");
  } finally {
    Date.now = realNow;
  }
});

test("a sample that finishes after sharing was turned off keeps no built-in page, so turning sharing back on can't send it", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const S = () => useBrowser.getState();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  S().hydrate({});
  const w = S().createWindow({ url: "https://private.example/" });
  const tab = S().windows[w].tabIds[0];
  assert.equal((await diagnostics.recordContext()).webui_pages, null);
  S().updateTab(tab, { url: "chrome://history" });
  const pending = diagnostics.recordContext();
  client.setSharing(false, "settings");
  assert.equal(await pending, null);
  S().updateTab(tab, { url: "https://private.example/" });
  client.setSharing(true, "settings");
  const next = await diagnostics.recordContext();
  assert.equal(next.webui_page, null);
  assert.equal(next.webui_pages, null, "history was shown only while sharing was off");
});

test("deleting a profile erases its built-in pages, including the one its window was showing", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const S = () => useBrowser.getState();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  S().hydrate({});
  S().createWindow({ url: "https://private.example/" });
  const work = S().createProfile({ name: "Work" });
  const w = S().createWindow({ profileId: work, url: "chrome://settings/cookies" });
  S().setFocusedWindow(w);
  assert.equal((await diagnostics.recordContext()).webui_page, "settings/cookies");
  diagnostics.startContextSamples();
  try {
    S().deleteProfile(work);
    const after = await diagnostics.recordContext();
    assert.equal(after.webui_page, null);
    assert.equal(after.webui_pages, null, "the deleted profile's settings page came back");
  } finally {
    diagnostics.stopContextSamples();
  }
});

test("a page process that goes away sends its reason, exit code, visibility and counts, capped per session", async () => {
  diagnostics.trackPageProcessGone({ reason: "oom", code: 9 }, true, { translate: "translating", translate_stage: "model", translating_tabs: 2, translated_tabs: 1 });
  diagnostics.trackPageProcessGone({ reason: "https://private.example", code: 1.5 }, false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.saveQueueNow();
  const [oom, odd] = events("page_process_gone").map((e) => e.properties);
  assert.equal(oom.reason, "oom");
  assert.equal(oom.exit_code, 9);
  assert.equal(oom.visible, true);
  assert.equal(oom.gone_this_session, 1);
  assert.equal(oom.translate, "translating");
  assert.equal(oom.translate_stage, "model");
  assert.equal(oom.translating_tabs, 2);
  assert.equal(oom.translated_tabs, 1);
  assert.equal(odd.translate, undefined);
  assert.equal(odd.reason, "unknown");
  assert.equal(odd.exit_code, null);
  for (let i = 0; i < 40; i++) diagnostics.trackPageProcessGone({ reason: "crashed", code: 11 }, false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.saveQueueNow();
  assert.equal(events("page_process_gone").length, 30);
});

test("a lost-hover episode sends only its enums, flags and duration, capped per session", async () => {
  const episode = { reason: "halfActive", halfActive: true, appActive: false, runningActive: true, frontmost: true, menuActive: true, trigger: "click", keyWindow: "blockerPage", mainWindow: "none", preventKey: true, canKey: false, windowMain: true, overPage: true, cover: "none", coverClear: false, healed: true, healWorked: true, healRefused: "menuShown", healRefusedLast: "notClick", healRefusedWindow: "sharing:normal:browser", otherWindowClicks: 3, endedBy: "heal", seconds: 3.4, episode: 1, epoch: client.consentEpoch() };
  diagnostics.trackHoverLost(episode);
  diagnostics.trackHoverLost({ ...episode, reason: "https://private.example", keyWindow: "Title of a page", endedBy: 7, healWorked: null, seconds: -5, trigger: "drag", healRefused: "https://private.example", healRefusedLast: "Title of a page", healRefusedWindow: "NSLocalWindowSharingWindow", otherWindowClicks: 1e9 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.saveQueueNow();
  const [healed, odd] = events("page_hover_lost").map((e) => e.properties);
  assert.equal(healed.reason, "halfActive");
  assert.equal(healed.half_active, true);
  assert.equal(healed.app_active, false);
  assert.equal(healed.running_active, true);
  assert.equal(healed.frontmost, true);
  assert.equal(healed.menu_active, true);
  assert.equal(healed.trigger, "click");
  assert.equal(healed.key_window, "blockerPage");
  assert.equal(healed.main_window, "none");
  assert.equal(healed.prevent_key, true);
  assert.equal(healed.can_key, false);
  assert.equal(healed.window_main, true);
  assert.equal(healed.healed, true);
  assert.equal(healed.heal_worked, true);
  assert.equal(healed.heal_refused, "menuShown");
  assert.equal(healed.heal_refused_last, "notClick");
  assert.equal(healed.heal_refused_window, "sharing:normal:browser");
  assert.equal(healed.other_window_clicks, 3);
  assert.equal(healed.ended_by, "heal");
  assert.equal(healed.lost_seconds, 3);
  assert.equal(healed.responder, "unknown");
  assert.equal(healed.cover_window, "none");
  diagnostics.trackHoverLost({ ...episode, reason: "coveredByWindow", responder: "window", coverWindow: "other" });
  diagnostics.trackHoverLost({ ...episode, responder: "Some View Class" });
  const unrecorded = { ...episode };
  for (const field of ["healRefused", "healRefusedLast", "healRefusedWindow", "otherWindowClicks"]) delete unrecorded[field];
  diagnostics.trackHoverLost(unrecorded);
  diagnostics.trackHoverLost({ ...episode, healRefused: "none", healRefusedLast: "keyPopup", healRefusedWindow: "none", otherWindowClicks: -3 });
  diagnostics.trackHoverLost({ ...episode, healRefusedWindow: "menu:popUp", otherWindowClicks: "many" });
  diagnostics.trackHoverLost({ ...episode, healRefusedWindow: "panel:normal:Some App's Window Title", otherWindowClicks: 2.6 });
  diagnostics.trackHoverLost({ ...episode, reason: "coveredByView", cover: "reactNative", coverClear: true, coverView: "rnView", coverClearView: "appKit", coverSize: "full", endedBy: "windowClosed" });
  diagnostics.trackHoverLost({ ...episode, reason: "coveredByView", coverView: "RCTView", coverClearView: "https://private.example", coverSize: "Title of a page", endedBy: "Quit" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.saveQueueNow();
  const [covered, oddResponder, unrecordedRefusal, noRefusal, notAnEnum, notAWindow, quitWhileCovered, oddCover] = events("page_hover_lost").slice(2).map((e) => e.properties);
  assert.equal(quitWhileCovered.reason, "coveredByView");
  assert.equal(quitWhileCovered.cover_clear, true);
  assert.equal(quitWhileCovered.cover_view, "rnView");
  assert.equal(quitWhileCovered.cover_clear_view, "appKit");
  assert.equal(quitWhileCovered.cover_size, "full");
  assert.equal(quitWhileCovered.ended_by, "windowClosed");
  assert.equal(oddCover.cover_view, "unknown");
  assert.equal(oddCover.cover_clear_view, "unknown");
  assert.equal(oddCover.cover_size, "unknown");
  assert.equal(oddCover.ended_by, "unknown");
  assert.equal(unrecordedRefusal.cover_view, "unknown");
  assert.equal(unrecordedRefusal.cover_size, "unknown");
  assert.equal(covered.reason, "coveredByWindow");
  assert.equal(covered.responder, "window");
  assert.equal(covered.cover_window, "other");
  assert.equal(oddResponder.responder, "unknown");
  assert.equal(odd.reason, "unknown");
  assert.equal(odd.key_window, "unknown");
  assert.equal(odd.ended_by, "unknown");
  assert.equal(odd.heal_worked, null);
  assert.equal(odd.heal_refused, "unknown");
  assert.equal(odd.heal_refused_last, "unknown");
  assert.equal(odd.heal_refused_window, "unknown");
  assert.equal(odd.other_window_clicks, 1000);
  assert.equal(unrecordedRefusal.heal_refused, "unknown");
  assert.equal(unrecordedRefusal.heal_refused_last, "unknown");
  assert.equal(unrecordedRefusal.heal_refused_window, "unknown");
  assert.equal(unrecordedRefusal.other_window_clicks, null);
  assert.equal(noRefusal.heal_refused, "none");
  assert.equal(noRefusal.heal_refused_last, "keyPopup");
  assert.equal(noRefusal.heal_refused_window, "none");
  assert.equal(noRefusal.other_window_clicks, 0);
  assert.equal(notAnEnum.heal_refused_window, "unknown");
  assert.equal(notAnEnum.other_window_clicks, null);
  assert.equal(notAWindow.heal_refused_window, "unknown");
  assert.equal(notAWindow.other_window_clicks, 3);
  assert.equal(odd.lost_seconds, 0);
  assert.equal(odd.trigger, "move");
  for (let i = 0; i < 30; i++) diagnostics.trackHoverLost(episode);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.saveQueueNow();
  assert.equal(events("page_hover_lost").length, 20);
});

test("an unpainted window sends its enums, flags, counts and reason bits, capped per session", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const record = { window: "private", trigger: "seen", seen: true, occlusion: "visible", overruled: false, appActive: true, windows: 2, views: 3, unpainted: 2, reasons: (1 << 0) | (1 << 4) | (1 << 7) };
  diagnostics.trackWindowUnpainted({ ...record, epoch: client.consentEpoch() });
  diagnostics.trackWindowUnpainted({ epoch: client.consentEpoch(), window: "https://private.example", trigger: "Title of a page", seen: 1, occlusion: 7, overruled: "yes", appActive: "yes", windows: 1e9, views: -4, unpainted: 1e9, reasons: "all", url: "https://private.example", title: "Inbox", profile: "Work" });
  const settings = useBrowser.getState().settings;
  useBrowser.setState({ settings: { ...settings, shareTabsAcrossWindows: true } });
  diagnostics.trackWindowUnpainted({ ...record, epoch: client.consentEpoch() });
  useBrowser.setState({ settings });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.saveQueueNow();
  const [first, odd, shared] = events("window_unpainted").map((e) => e.properties);
  assert.equal(first.app_active, true);
  assert.equal(first.windows, 2);
  assert.equal(first.share_tabs, false);
  assert.equal(shared.share_tabs, true);
  assert.equal(odd.app_active, false);
  assert.equal(odd.windows, 1000);
  assert.equal(first.window, "private");
  assert.equal(first.trigger, "seen");
  assert.equal(first.seen, true);
  assert.equal(first.occlusion, "visible");
  assert.equal(first.overruled, false);
  assert.equal(first.views, 3);
  assert.equal(first.unpainted, 2);
  assert.equal(first.alpha_zero, true);
  assert.equal(first.view_hidden, false);
  assert.equal(first.page_hidden, false);
  assert.equal(first.page_detached, false);
  assert.equal(first.frame_hold_awaiting, true);
  assert.equal(first.stand_in_lent, false);
  assert.equal(first.stand_in_leaving, false);
  assert.equal(first.veil_up, true);
  assert.equal(odd.window, "unknown");
  assert.equal(odd.trigger, "unknown");
  assert.equal(odd.seen, false);
  assert.equal(odd.occlusion, "unknown");
  assert.equal(odd.overruled, false);
  assert.equal(odd.views, 0);
  assert.equal(odd.unpainted, 1000);
  assert.equal(odd.alpha_zero, false);
  assert.equal(odd.veil_up, false);
  assert.equal(JSON.stringify(odd).includes("private.example"), false);
  assert.equal(JSON.stringify(odd).includes("Inbox"), false);
  assert.equal(JSON.stringify(odd).includes("Work"), false);
  for (let i = 0; i < 30; i++) diagnostics.trackWindowUnpainted({ ...record, epoch: client.consentEpoch() });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.saveQueueNow();
  assert.equal(events("window_unpainted").length, 20);
});

test("tab presses count clicks, drags turned into clicks, drags and presses that got no answer", async () => {
  presses.notePressStarted(true);
  presses.notePressEnded("click", "t1");
  presses.notePagePress("t1");
  presses.notePressStarted(true);
  presses.notePressEnded("dragClick", "t2");
  presses.notePressStarted(true);
  presses.notePressEnded("drag");
  presses.notePressStarted();
  presses.notePressStarted();
  presses.notePressEnded("click", "t3");
  presses.notePagePress("t4");
  stub.pressesWithoutRelease.count = 2;
  stub.pressRepeated.earlier = { landedOn: "RCTView<Surface", ms: 600 };
  await presses.noteRowPress(true);
  stub.pressRepeated.earlier = { landedOn: "RCTView<Surface", ms: 20 };
  await presses.noteRowPress(true);
  stub.pressRepeated.earlier = null;
  presses.noteRangeSelect(true);
  presses.noteRangeSelect(false);
  presses.notePagePressRefused();
  presses.noteDragWithoutDrop();
  for (const kind of ["gap", "gap", "split_left", "split_right", "split_right", "split_pinned", "split_unpinned", "split_unpinned", "tile", "other_profile", "other_profile", "profile_icon"]) presses.noteSidebarDrop(kind);
  presses.noteDragProfileSwitch("icon");
  presses.noteDragProfileSwitch(null);
  presses.noteDragProfileSwitch("icon");
  presses.noteDragProfileSwitch("edge");
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  const props = events("tab_presses").at(-1).properties;
  assert.equal(props.drags_without_drop, 1);
  assert.deepEqual([props.drops_gap, props.drops_split_left, props.drops_split_right, props.drops_split_pinned, props.drops_split_unpinned, props.drops_tile], [2, 1, 2, 1, 2, 1]);
  assert.deepEqual([props.drops_other_profile, props.drops_profile_icon, props.drag_profile_switches, props.drag_profile_holds, props.drag_profile_edge_holds], [2, 1, 4, 2, 1]);
  assert.deepEqual([props.range_selects, props.range_from_shown], [2, 1]);
  assert.deepEqual([props.repeat_presses, props.repeat_on_new_tab, props.repeat_gap_ms_p50, props.repeat_landed_on], [1, 1, 600, "RCTView<Surface"]);
  assert.equal(props.lost_releases, 2);
  assert.equal(props.presses, 5);
  assert.equal(props.clicks, 2);
  assert.equal(props.drag_clicks, 1);
  assert.equal(props.drags, 1);
  assert.equal(props.unanswered, 1);
  assert.equal(props.down_switches, 3);
  assert.equal(props.held_n, 2);
  assert.ok(props.held_ms_p50 >= 0 && props.held_ms_p50 < 1000);
  assert.equal(props.page_refused, 1);
  assert.equal(props.page_click_n, 1);
  assert.ok(props.page_click_ms_p50 >= 0 && props.page_click_ms_p50 < 1000);
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  assert.equal(events("tab_presses").length, 1);
  stub.pressesWithoutRelease.count = 3;
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  assert.equal(events("tab_presses").length, 2);
  assert.deepEqual([events("tab_presses").at(-1).properties.lost_releases, events("tab_presses").at(-1).properties.presses], [1, 0]);
  presses.noteRangeSelect(true);
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  assert.equal(events("tab_presses").length, 3, "a ⇧-click whose press went out in the previous hour still sends its range");
  assert.deepEqual([events("tab_presses").at(-1).properties.range_selects, events("tab_presses").at(-1).properties.presses], [1, 0]);
});

test("an hour with only refused page presses still sends them", async () => {
  presses.notePagePressRefused();
  presses.notePagePressRefused();
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  assert.equal(events("tab_presses").length, 4);
  const props = events("tab_presses").at(-1).properties;
  assert.equal(props.presses, 0);
  assert.equal(props.down_switches, 0);
  assert.equal(props.page_refused, 2);
  assert.deepEqual([props.lost_releases, props.repeat_presses, props.repeat_gap_ms_p50, props.repeat_landed_on], [0, 0, null, null]);
  assert.equal(props.page_click_n, 0);
  assert.equal(props.page_click_ms_p50, null);
  assert.equal(props.held_n, 0);
  assert.equal(props.held_ms_p50, null);
  assert.ok(Object.values(props).every((v) => v !== undefined && !Number.isNaN(v)), JSON.stringify(props));
});

test("an hour with only a drag let go with no place to drop still sends it", async () => {
  presses.noteDragWithoutDrop();
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  assert.equal(events("tab_presses").length, 5);
  const props = events("tab_presses").at(-1).properties;
  assert.deepEqual([props.drags_without_drop, props.presses, props.drags], [1, 0, 0]);
});

const touch = (x, y, startTimeStamp) => ({ nativeEvent: { identifier: "0", pageX: x, pageY: y }, touchHistory: { touchBank: [{ startTimeStamp }] } });
const sent = async () => {
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  return events("tab_presses").at(-1).properties;
};

test("a click endHeldTabPress drops is counted under the condition that dropped it, with no tab id", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  const hold = (tabId, start) => held.holdTabPress("win-a", tabId, touch(10, 10, start));
  hold("tab-1", 100);
  held.endHeldTabPress(["tab-1"], null);
  hold("tab-2", 200);
  held.endHeldTabPress(["other"], touch(10, 10, 200));
  hold("tab-3", undefined);
  held.endHeldTabPress(["tab-3"], touch(10, 10, 300));
  hold("tab-4", 400);
  held.endHeldTabPress(["tab-4"], touch(10, 10, 999));
  hold("tab-5", 500);
  held.endHeldTabPress([], null);
  hold("tab-6", 600);
  held.endHeldTabPress(["tab-6"], touch(10, 10, 600));

  const props = await sent();
  assert.equal(props.presses, 6);
  assert.equal(props.drags, 5);
  assert.equal(props.drag_clicks, 1);
  assert.equal(props.drop_no_release, 2);
  assert.equal(props.drop_not_dragged, 1);
  assert.equal(props.drop_no_start, 1);
  assert.equal(props.drop_start_mismatch, 1);
  assert.equal(props.drop_no_release + props.drop_not_dragged + props.drop_no_start + props.drop_start_mismatch, props.drags);
  assert.ok(!JSON.stringify(props).includes("tab-"), "no tab id goes out with the counts");
});

test("presses Pressable ends without onPress are counted with the window's key state and the drift, whichever of onPress and onPressOut comes first", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  const { useBrowser } = await import("../browser/store.ts");
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  useBrowser.setState((s) => ({ ui: { ...s.ui, focusOrder: ["win-a", "win-b"] } }));
  const hold = (windowId, tabId, start) => held.holdTabPress(windowId, tabId, touch(10, 10, start));

  const away = hold("win-b", "tab-1", 100);
  held.pressOutTabPress(away, touch(17, 10, 100));
  held.endHeldTabPress([], null);
  const slow = hold("win-a", "tab-2", 200);
  held.pressOutTabPress(slow, touch(11, 10, 200));
  held.clickHeldTabPress("win-a", "tab-2", touch(11, 10, 200), slow);
  const quick = hold("win-a", "tab-3", 300);
  held.clickHeldTabPress("win-a", "tab-3", touch(10, 12, 300), quick);
  held.pressOutTabPress(quick, touch(10, 12, 300));
  held.pressOutTabPress(quick, touch(10, 12, 300));
  held.pressOutTabPress(hold("win-a", "tab-4", 400), { nativeEvent: {} });
  held.pressOutTabPress(hold("win-a", "tab-5", 500), touch(40, 10, 500));
  await tick();

  const props = await sent();
  assert.equal(props.presses, 5);
  assert.equal(props.clicks, 2);
  assert.equal(props.press_out_no_press, 3);
  assert.equal(props.unfocused_presses, 1);
  assert.equal(props.unfocused_no_press, 1);
  assert.deepEqual([props.drift_lt5, props.drift_5_9, props.drift_10_plus, props.drift_unknown], [2, 1, 1, 1]);
  assert.deepEqual([props.no_press_drift_lt5, props.no_press_drift_5_9, props.no_press_drift_10_plus, props.no_press_drift_unknown], [0, 1, 1, 1]);
  assert.ok(!JSON.stringify(props).includes("tab-"), "no tab id goes out with the counts");
});

test("a press that leaves the tab and comes back before release is one press, and its click counts no lost click", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  const first = held.holdTabPress("win-a", "tab-1", touch(10, 10, 700));
  held.pressOutTabPress(first, touch(40, 10, 700));
  const back = held.holdTabPress("win-a", "tab-1", touch(12, 10, 700), first);
  assert.equal(back, first, "the same gesture keeps its record");
  held.pressOutTabPress(back, touch(12, 10, 700));
  held.clickHeldTabPress("win-a", "tab-1", touch(12, 10, 700), back);
  const early = held.holdTabPress("win-a", "tab-2", touch(10, 10, 710));
  held.pressOutTabPress(early, touch(40, 10, 710));
  const again = held.holdTabPress("win-a", "tab-2", touch(10, 10, 710), early);
  held.clickHeldTabPress("win-a", "tab-2", touch(10, 10, 710), again);
  held.pressOutTabPress(again, touch(10, 10, 710));

  const props = await sent();
  assert.equal(props.presses, 2);
  assert.equal(props.clicks, 2);
  assert.equal(props.press_out_no_press, 0);
  assert.deepEqual([props.drift_lt5, props.drift_5_9, props.drift_10_plus, props.drift_unknown], [2, 0, 0, 0], "one drift per gesture, from where it was released");
});

test("a press released off the tab counts one lost click, at the next press or when the hour's event is built", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  const off = held.holdTabPress("win-a", "tab-1", touch(10, 10, 800));
  held.pressOutTabPress(off, touch(40, 10, 800));
  assert.equal(presses.devTabPresses().press_out_no_press, 0, "not counted while Pressable may still answer");
  const next = held.holdTabPress("win-a", "tab-2", touch(10, 10, 900), off);
  assert.equal(presses.devTabPresses().press_out_no_press, 1, "the next gesture settles it");
  held.pressOutTabPress(next, touch(17, 10, 900));

  const props = await sent();
  assert.equal(props.presses, 2);
  assert.equal(props.press_out_no_press, 2);
  assert.deepEqual([props.no_press_drift_lt5, props.no_press_drift_5_9, props.no_press_drift_10_plus, props.no_press_drift_unknown], [0, 1, 1, 0]);
  assert.equal(presses.devTabPresses().unansweredOut, false);
});

test("a lost click still waiting when the hour's event is built goes out in that event, even with no press that hour", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  const press = held.holdTabPress("win-a", "tab-1", touch(10, 10, 1000));
  const before = await sent();
  assert.equal(before.presses, 1);
  assert.equal(before.press_out_no_press, 0);
  held.pressOutTabPress(press, touch(40, 10, 1000));
  const count = events("tab_presses").length;
  const props = await sent();
  assert.equal(events("tab_presses").length, count + 1, "the hour with only the lost click still sends");
  assert.equal(props.presses, 0);
  assert.equal(props.press_out_no_press, 1);
  assert.equal(props.no_press_drift_10_plus, 1);
});

test("turning sharing off forgets pending presses and samples, so they never go out under the next install id", async () => {
  await diagnostics.recordContext();
  assert.ok(diagnostics.contextSamples().length > 0);
  presses.notePressStarted();
  presses.notePressEnded("click", "t9");
  presses.notePressStarted();
  presses.notePagePressRefused();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  assert.equal(diagnostics.contextSamples().length, 0);
  presses.notePagePress("t9");
  presses.notePressEnded("click", "t9");
  presses.emitTabPresses(client.consentToken());
  await client.saveQueueNow();
  assert.equal(events("tab_presses").length, 0);
  assert.deepEqual(Object.values(presses.devTabPresses()).filter((n) => n !== 0 && n !== false), []);
  assert.ok("drop_start_mismatch" in presses.devTabPresses() && "no_press_drift_unknown" in presses.devTabPresses() && "page_refused" in presses.devTabPresses() && "drags_without_drop" in presses.devTabPresses());
});

test("with sharing off no context is saved, and tab presses aren't counted, kept in the local copy or queued", async () => {
  client.setSharing(false, "settings");
  assert.equal(await diagnostics.recordContext(), null);
  assert.equal(JSON.parse(stub.docs.get("telemetry.json")).context, null);
  const { flushLocal } = await import("./localStore.ts");
  flushLocal();
  const tabPressLines = () => stub.telemetryLocal.records().filter((r) => r.event === "tab_presses");
  const before = tabPressLines().length;
  presses.notePressStarted();
  presses.notePressEnded("click", "t1");
  presses.emitTabPresses(client.consentToken());
  flushLocal();
  assert.equal(tabPressLines().length, before);
  assert.deepEqual(tabPressLines().filter((r) => r.sent === false), []);
  assert.deepEqual(Object.values(presses.devTabPresses()).filter((n) => n !== 0 && n !== false), []);
  assert.equal(client.devState().queued.events, 0);
});
