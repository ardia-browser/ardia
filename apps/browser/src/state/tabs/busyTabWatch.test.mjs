import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { HOSTILE_STRINGS as NAMED_STRINGS, HOSTILE_VALUES as NAMED_VALUES, PROTOTYPE_KEYS } from "../../../../../scripts/security/hostile-inputs.mjs";

const HOSTILE_STRINGS = NAMED_STRINGS.map((entry) => entry.value);
const HOSTILE_VALUES = NAMED_VALUES.map((entry) => entry.value);

globalThis.__DEV__ = false;

const performance = import.meta.resolve("../../platform/performance.ts");
const realShownTabs = import.meta.resolve("./shownTabs.ts");
globalThis.busyTest = { tasks: [], lookups: 0, toasts: [], onLookup: null, slots: {}, trackSlots: false, hidden: [], validate: null, toastSeq: 0 };
const stubs = {
  "../../platform/performance": `export * from ${JSON.stringify(performance)};
    export const listTasks = async () => { globalThis.busyTest.lookups++; if (globalThis.busyTest.failLookups > 0) { globalThis.busyTest.failLookups--; throw new Error("task manager unavailable"); } const t = globalThis.busyTest.tasks; globalThis.busyTest.onLookup?.(); return t; };
    export const isKeepActiveSiteValid = () => globalThis.busyTest.validate ? globalThis.busyTest.validate() : Promise.resolve(true);
    export const childProcessCpu = async () => [];`,
  "./shownTabs": `import * as real from ${JSON.stringify(realShownTabs)};
    export const shownTabIds = (s) => ((globalThis.busyTest.shownCalls = (globalThis.busyTest.shownCalls ?? 0) + 1), real.shownTabIds(s));`,
  "../app/toasts": `export const useToasts = { getState: () => ({ toasts: globalThis.busyTest.slots }) };
    export const hideKeyedToast = (windowId, key) => globalThis.busyTest.hidden.push([windowId, key]);
    export const showToast = (windowId, title, message, options) => {
      globalThis.busyTest.toasts.push({ windowId, title, message, ...options });
      if (globalThis.busyTest.trackSlots) globalThis.busyTest.slots[windowId] = { id: ++globalThis.busyTest.toastSeq, title, key: options?.key };
    };`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (!/\/state\/tabs\/(?:busyTabWatch|memorySaver)\.ts$/.test(context.parentURL ?? "") || !(specifier in stubs)) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../browser/store.ts");
const { webviews, webviewRef } = await import("../../platform/webviews.ts");
const { readHeat, sustainedBusy, keptActive, siteToKeepActive, validReadings } = await import("./busyProcesses.ts");
const { watchBusyTabs, startBusyTabWatch, toastName } = await import("./busyTabWatch.ts");
const { shownTabIds } = await import("./shownTabs.ts");
const { takeBusyTabCounts } = await import("../telemetry/busyTabCounts.ts");
const { slowTimersForTests } = await import("../../platform/slowTimers.ts");
const { setQuitting } = await import("../app/quit.ts");
const { keepSiteActive, stopKeepingSiteActive } = await import("./memorySaver.ts");
const { keptSitesListed } = await import("./keptSites.ts");
const { parseSettings } = await import("../settings/settings.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
const { unshownSettings } = await import("../../components/settings/settingsIndex.ts");
const { readFileSync } = await import("node:fs");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "busy-tab-watch-test");

const S = () => useBrowser.getState();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("a process counts as busy once its last two minutes of readings average 0.7 of a core or more", () => {
  const reading = (pid, cpuMs, started = 1) => ({ pid, started, cpuMs });
  const at = 1_000_000;
  const run = (perTick, { from = 0, pid = 1, started = 1, heat = new Map(), base = 0 } = {}) => {
    let used = base;
    perTick.forEach((cores, i) => {
      used += i ? cores * 10_000 : 0;
      heat = readHeat(heat, [reading(pid, used, started)], at + (from + i) * 10 * SECOND);
    });
    return { heat, used };
  };
  const full = Array(13).fill(1);
  assert.deepEqual(sustainedBusy(run(full.slice(0, 12)).heat), [], "110 s at a full core isn't enough yet");
  let { heat } = run(full);
  assert.deepEqual(sustainedBusy(heat), [1], "120 s is");
  assert.deepEqual(sustainedBusy(run(Array(13).fill(0.6)).heat), [], "0.6 of a core never is");
  assert.deepEqual(sustainedBusy(run([1, 1, 1, 1, 1, 0.1, 1, 1, 1, 1, 1, 1, 1]).heat), [1], "one quiet reading in a busy run doesn't start the count again");
  assert.deepEqual(sustainedBusy(run([...full, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]).heat), [], "a run that has quietened down is no longer busy");
  heat = readHeat(run(full).heat, [], at + 130 * SECOND);
  assert.ok(!heat.has(1), "a process that ended is forgotten");
  heat = readHeat(run(full).heat, [reading(1, 0, 2)], at + 130 * SECOND);
  assert.deepEqual(sustainedBusy(heat), [], "a new process under a reused pid starts from its own first reading");
  const gapped = run(full.slice(0, 6)).heat;
  assert.deepEqual(sustainedBusy(run(full.slice(0, 7), { from: 8, heat: gapped, base: 60_000 }).heat), [], "readings too far apart (the watch was paused) don't continue a busy run");
});

test("readings and keep-active rules from outside are checked before they are used", () => {
  assert.deepEqual(validReadings([{ pid: 4, started: 9, cpuMs: 10 }, { pid: 4, started: 9, cpuMs: 11 }]), [{ pid: 4, started: 9, cpuMs: 10 }], "one reading per pid");
  for (const bad of HOSTILE_VALUES) {
    assert.deepEqual(validReadings(bad), [], "a reply that isn't a list gives nothing");
    const kept = validReadings([{ pid: bad, started: 1, cpuMs: 1 }, { pid: 2, started: bad, cpuMs: 1 }, { pid: 3, started: 1, cpuMs: bad }, bad]);
    for (const r of kept) for (const v of [r.pid, r.started, r.cpuMs]) assert.ok(typeof v === "number" && Number.isFinite(v) && v >= 0, `keeps only real numbers, not ${String(bad).slice(0, 20)}`);
    assert.ok(kept.every((r) => Number.isInteger(r.pid) && r.pid > 0));
  }
  assert.deepEqual(validReadings([{ pid: -1, started: 1, cpuMs: 1 }, { pid: 1.5, started: 1, cpuMs: 1 }, { pid: 2, started: 1, cpuMs: Infinity }, { pid: 3, started: 1, cpuMs: -1 }]), []);
  for (const rule of [...HOSTILE_STRINGS, ...PROTOTYPE_KEYS]) assert.doesNotThrow(() => keptActive("https://a.example/x?y=1", [rule]));
  assert.ok(!keptActive("https://a.example/", [1, null, {}]), "rules that aren't text match nothing");
});

function windowWithHiddenTab(lastActiveAt, { kind } = {}) {
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/", ...(kind ? { kind } : {}) });
  const hidden = S().newTab(w, { url: "https://miner.example/page", background: true });
  S().updateTab(hidden, { title: "Busy Loop Page", lastActiveAt });
  const front = Object.keys(S().tabs).find((id) => id !== hidden);
  const slept = [];
  webviews.clear();
  for (const id of [front, hidden]) webviews.set(id, { sleepIfHidden: async () => (slept.push(id), []), discard: async () => "discarded" });
  return { w, hidden, front, slept };
}

async function burn(start, minutes, cores = { 41: 1 }) {
  const used = {};
  for (let t = 0; t <= minutes * 6; t++) {
    const now = start + t * 10 * SECOND;
    await watchBusyTabs(now, async () => Object.entries(cores).map(([pid, c]) => ({ pid: +pid, started: 7, cpuMs: (used[pid] = (used[pid] ?? 0) + (t ? c * 10_000 : 0)) })));
  }
  return start + minutes * MINUTE;
}

const reset = () => {
  globalThis.busyTest.toasts.length = 0;
  globalThis.busyTest.lookups = 0;
  globalThis.busyTest.onLookup = null;
  globalThis.busyTest.slots = {};
  globalThis.busyTest.trackSlots = false;
  takeBusyTabCounts();
};

test("a hidden tab that keeps a core busy for two minutes gets one short warning; Sleep puts it to sleep and says so", async () => {
  const start = Date.now() + 1000 * MINUTE;
  const { w, hidden, slept } = windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab: Busy Loop Page", tabIds: [hidden] }];
  reset();
  await burn(start, 1.5);
  assert.equal(globalThis.busyTest.toasts.length, 0, "90 seconds isn't enough");
  assert.equal(globalThis.busyTest.lookups, 0, "and nobody asked Chrome's task manager which tabs the process holds");
  const end = await burn(start, 2);
  assert.equal(globalThis.busyTest.toasts.length, 1);
  const warning = globalThis.busyTest.toasts[0];
  assert.equal(warning.windowId, w);
  assert.equal(warning.title, "“Busy Loop Page” is using a lot of power");
  assert.equal(warning.message, undefined, "one line, no explanation");
  assert.deepEqual([warning.secondary.title, warning.action.title], ["Keep Running", "Sleep"]);
  await burn(end, 3);
  assert.equal(globalThis.busyTest.toasts.length, 1, "a warning left unanswered isn't repeated right away");
  warning.action.run();
  await settle();
  assert.deepEqual(slept, [hidden]);
  assert.equal(globalThis.busyTest.toasts[1].title, "“Busy Loop Page” is asleep");
  const counts = takeBusyTabCounts();
  assert.equal(counts.busy_tab_warnings, 1);
  assert.equal(counts.busy_tab_slept, 1);
  assert.ok(counts.busy_tab_watch_ticks >= 30);
  webviews.clear();
});

test("ownership is read again right before the warning: a tab that left the busy process isn't named", async () => {
  const start = Date.now() + 1500 * MINUTE;
  const { hidden } = windowWithHiddenTab(start + MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [hidden] }];
  globalThis.busyTest.onLookup = () => (globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [] }]);
  await burn(start, 4);
  assert.ok(globalThis.busyTest.lookups >= 2, "the owner was cached while the tab was still too recently seen, then read again before warning");
  assert.equal(globalThis.busyTest.toasts.length, 0);
  webviews.clear();
});

test("Sleep checks again: a tab that left the busy process, or was shown, since the warning is left alone and nothing is said", async () => {
  const start = Date.now() + 1800 * MINUTE;
  const { hidden, slept, w } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [hidden] }];
  await burn(start, 2);
  const warning = globalThis.busyTest.toasts[0];
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [] }];
  warning.action.run();
  await settle();
  assert.deepEqual(slept, [], "it moved to another process");
  assert.equal(globalThis.busyTest.toasts.length, 1, "and no confirmation is shown");
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [hidden] }];
  S().activate(hidden);
  assert.ok(shownTabIds(S()).has(hidden));
  warning.action.run();
  await settle();
  assert.deepEqual(slept, [], "it's on screen now");
  assert.equal(takeBusyTabCounts().busy_tab_sleep_moot, 2);
  webviews.clear();
});

test("Keep Running keeps the site active from then on, says so, and neither this tab nor the site is warned about again", async () => {
  const start = Date.now() + 2000 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [hidden] }];
  reset();
  await burn(start, 2);
  globalThis.busyTest.toasts[0].secondary.run();
  await settle();
  assert.deepEqual(S().settings.keepActiveSites, ["miner.example"]);
  assert.equal(globalThis.busyTest.toasts[1].title, "miner.example will keep running");
  await burn(start + 200 * MINUTE, 3);
  assert.equal(globalThis.busyTest.toasts.length, 2);
  assert.equal(takeBusyTabCounts().busy_tab_kept_running, 1);
  webviews.clear();
});

test("no warning for a private tab, a process that also draws a shown tab, a tab seen in the last two minutes, a playing tab, or an extension", async () => {
  const start = Date.now() + 3000 * MINUTE;
  reset();
  const { hidden: secret } = windowWithHiddenTab(start - 10 * MINUTE, { kind: "private" });
  globalThis.busyTest.tasks = [{ id: 1, pid: 40, type: "renderer", title: "Tab", tabIds: [secret] }];
  await burn(start, 3, { 40: 1 });
  assert.equal(globalThis.busyTest.toasts.length, 0, "a private tab is never named, in any window");
  const { hidden, front } = windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [hidden, front] }];
  await burn(start + 4 * MINUTE, 3);
  assert.equal(globalThis.busyTest.toasts.length, 0, "the busy process also draws the tab in front");
  const { hidden: recent } = windowWithHiddenTab(start + 9 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 1, pid: 42, type: "renderer", title: "Tab", tabIds: [recent] }];
  await burn(start + 8 * MINUTE, 2, { 42: 1 });
  assert.equal(globalThis.busyTest.toasts.length, 0, "it was in front a minute into the busy run, so it has been hidden for only one");
  const { hidden: playing } = windowWithHiddenTab(start - 10 * MINUTE);
  S().updateLive(playing, { playingAudio: true });
  globalThis.busyTest.tasks = [{ id: 1, pid: 43, type: "renderer", title: "Tab", tabIds: [playing] }];
  await burn(start + 20 * MINUTE, 3, { 43: 1 });
  assert.equal(globalThis.busyTest.toasts.length, 0, "a playing tab is meant to be working");
  windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 9, pid: 77, type: "extension", title: "Extension: Spinner", tabIds: [] }];
  await burn(start + 30 * MINUTE, 3, { 77: 1 });
  assert.equal(globalThis.busyTest.toasts.length, 0, "extension warnings are out of scope");
  webviews.clear();
});

test("hostile task rows and page titles reach neither the toast nor Sleep", async () => {
  const start = Date.now() + 4000 * MINUTE;
  for (const [i, title] of HOSTILE_STRINGS.entries()) {
    const { hidden, slept } = windowWithHiddenTab(start - 10 * MINUTE);
    S().updateTab(hidden, { title, customTitle: null });
    reset();
    const pid = 500 + i;
    globalThis.busyTest.tasks = [
      { pid, tabIds: [...PROTOTYPE_KEYS, ...HOSTILE_VALUES, hidden] },
      { pid: String(pid), tabIds: [hidden] },
      { pid, tabIds: "tab" },
      null,
      7,
      ...HOSTILE_VALUES,
    ];
    await burn(start + i * 10 * MINUTE, 2, { [pid]: 1 });
    assert.equal(globalThis.busyTest.toasts.length, 0, "a process listed with ids that aren't tabs isn't attributed");
    globalThis.busyTest.tasks = [{ pid, tabIds: [hidden] }, { pid, tabIds: PROTOTYPE_KEYS }];
    await burn(start + i * 10 * MINUTE + 3 * MINUTE, 2, { [pid]: 1 });
    assert.equal(globalThis.busyTest.toasts.length, 0, "nor one that holds prototype keys");
    globalThis.busyTest.tasks = [{ pid, tabIds: [hidden] }, { pid, title: 5 }, { pid, tabIds: [hidden, ""] }];
    await burn(start + i * 10 * MINUTE + 6 * MINUTE, 2, { [pid]: 1 });
    const warning = globalThis.busyTest.toasts[0];
    assert.ok(warning, `warns for title ${JSON.stringify(title).slice(0, 40)}`);
    assert.doesNotMatch(warning.title, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, "no control or line-break characters");
    assert.doesNotMatch(warning.title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone surrogates");
    assert.ok(Array.from(warning.title).length <= 60, "bounded length");
    warning.action.run();
    await settle();
    assert.deepEqual(slept, [hidden], "Sleep reaches only the store's own tab");
  }
  assert.equal(toastName("a b\u0000c‮ d"), "a b c d");
  assert.equal(toastName(42), "");
  webviews.clear();
});

test("Sleep does nothing once the process has calmed down below the threshold", async () => {
  const start = Date.now() + 5000 * MINUTE;
  const { hidden, slept } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ pid: 41, tabIds: [hidden] }];
  const used = { v: 0 };
  const tick = (t, cores) => watchBusyTabs(start + t * 10 * SECOND, async () => [{ pid: 41, started: 9, cpuMs: (used.v += t ? cores * 10_000 : 0) }]);
  for (let t = 0; t <= 12; t++) await tick(t, 1);
  const warning = globalThis.busyTest.toasts[0];
  assert.ok(warning);
  for (let t = 13; t <= 18; t++) await tick(t, 0);
  warning.action.run();
  await settle();
  assert.deepEqual(slept, [], "the last two minutes average under 0.7 of a core now");
  assert.equal(globalThis.busyTest.toasts.length, 1);
  assert.equal(takeBusyTabCounts().busy_tab_sleep_moot, 1);
  webviews.clear();
});

test("after quitting starts, Keep Running and a pending kept-site check write nothing", async () => {
  const start = Date.now() + 5200 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ pid: 41, tabIds: [hidden] }];
  await burn(start, 2);
  const warning = globalThis.busyTest.toasts[0];
  setQuitting(true);
  try {
    warning.secondary.run();
    await settle();
    assert.deepEqual(S().settings.keepActiveSites, []);
    assert.equal(globalThis.busyTest.toasts.length, 1, "no confirmation either");
  } finally {
    setQuitting(false);
  }
  let answer;
  globalThis.busyTest.validate = () => new Promise((resolve) => (answer = resolve));
  try {
    const pending = keepSiteActive("late.example");
    await settle();
    setQuitting(true);
    answer(true);
    await pending;
    assert.deepEqual(S().settings.keepActiveSites, [], "a validation that finishes after the quit flush doesn't write");
  } finally {
    setQuitting(false);
    globalThis.busyTest.validate = null;
  }
  webviews.clear();
});

test("Sleep confirms only the tabs that really slept, and never covers a newer toast", async () => {
  const start = Date.now() + 5400 * MINUTE;
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/" });
  const a = S().newTab(w, { url: "https://miner.example/a", background: true });
  const b = S().newTab(w, { url: "https://miner.example/b", background: true });
  S().updateTab(a, { title: "Alpha", lastActiveAt: start - 10 * MINUTE });
  S().updateTab(b, { title: "Beta", lastActiveAt: start - 10 * MINUTE });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, { sleepIfHidden: async () => (id === b ? [26] : []), discard: async () => "discarded" });
  reset();
  globalThis.busyTest.tasks = [{ pid: 41, tabIds: [a, b] }];
  await burn(start, 2);
  assert.equal(globalThis.busyTest.toasts[0].title, "2 miner.example tabs are using a lot of power");
  globalThis.busyTest.toasts[0].action.run();
  await settle();
  await settle();
  assert.equal(globalThis.busyTest.toasts[1].title, "“Alpha” is asleep", "one slept and one was kept for its typed input: name the one that slept");
  reset();
  globalThis.busyTest.trackSlots = true;
  const c = S().newTab(w, { url: "https://other.example/c", background: true });
  S().updateTab(c, { title: "Gamma", lastActiveAt: start });
  webviews.set(c, { sleepIfHidden: async () => [], discard: async () => "discarded" });
  globalThis.busyTest.tasks = [{ pid: 42, tabIds: [c] }];
  await burn(start + 10 * MINUTE, 3, { 42: 1 });
  const warning = globalThis.busyTest.toasts.at(-1);
  assert.equal(warning.title, "“Gamma” is using a lot of power");
  globalThis.busyTest.slots[w] = { id: 999, title: "Undo", key: "undo" };
  warning.action.run();
  await settle();
  await settle();
  assert.equal(globalThis.busyTest.toasts.at(-1), warning, "a newer toast in the window stays; the confirmation is dropped");
  webviews.clear();
});

test("the watch has no timer while no loaded tab is hidden, wakes when a webview registers, and stops when the app quits", () => {
  const timers = slowTimersForTests(() => Date.now());
  timers.clear();
  S().hydrate({});
  const w = S().createWindow({ url: "https://front.example/" });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, {});
  startBusyTabWatch();
  assert.equal(timers.pending(), null, "only the tab in front is loaded");
  const hidden = S().newTab(w, { url: "https://other.example/", background: true });
  S().updateTab(hidden, { title: "Other" });
  assert.equal(timers.pending(), null, "a background tab with no page loaded yet doesn't count");
  const ref = webviewRef(hidden);
  ref({});
  assert.notEqual(timers.pending(), null, "its webview registering arms the watch with no store change");
  setQuitting(true);
  assert.equal(timers.pending(), null, "quitting disarms it");
  setQuitting(false);
  assert.notEqual(timers.pending(), null);
  ref(null);
  assert.equal(timers.pending(), null, "and the webview going away disarms it again");
  webviews.clear();
});

test("Warn about busy background tabs: off stops the watch and its reads, on arms it again; it persists, is counted, and is macOS only", async () => {
  assert.equal(parseSettings({}).busyTabWarnings, true, "on by default");
  assert.equal(parseSettings({ busyTabWarnings: false }).busyTabWarnings, false, "a saved off is kept");
  assert.equal(parseSettings({ busyTabWarnings: "no" }).busyTabWarnings, true, "a bad value falls back");
  const timers = slowTimersForTests(() => Date.now());
  const start = Date.now() + 6000 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  startBusyTabWatch();
  S().updateTab(hidden, { title: "Busy Loop Page, now hidden" });
  assert.notEqual(timers.pending(), null, "armed: a loaded tab is hidden");
  S().updateSettings({ busyTabWarnings: false });
  assert.equal(timers.pending(), null, "off: no timer at all");
  assert.deepEqual(globalThis.busyTest.hidden.at(-1), [S().tabs[hidden].windowId, "busyTab"], "a warning on screen goes away");
  let reads = 0;
  await watchBusyTabs(start, async () => (reads++, []));
  assert.equal(reads, 0, "and a tick that was already due reads nothing");
  S().updateSettings({ busyTabWarnings: true });
  assert.notEqual(timers.pending(), null, "on again: armed again while a tab is hidden");
  const counts = takeBusyTabCounts();
  assert.equal(counts.busy_tab_warnings_turned_off, 1);
  assert.equal(counts.busy_tab_warnings_turned_on, 1);
  timers.clear();
  webviews.clear();
  const read = (name) => readFileSync(new URL(`../../lib/${name}`, import.meta.url), "utf8");
  for (const name of ["platformFeatures.linux.ts", "platformFeatures.windows.ts"]) assert.match(read(name), /busyTabWatch: false/, name);
  assert.match(read("platformFeatures.ts"), /busyTabWatch: true/);
  const env = { top: false, glass: true, syncOn: false, calendarAccess: false, officialPlugins: [] };
  assert.ok(!unshownSettings(parseSettings({}), env).split("\n").includes("advanced.busyTabWarnings"), "shown on macOS");
  PLATFORM_FEATURES.busyTabWatch = false;
  try {
    assert.ok(unshownSettings(parseSettings({}), env).split("\n").includes("advanced.busyTabWarnings"), "hidden where the platform has no watch");
  } finally {
    PLATFORM_FEATURES.busyTabWatch = true;
  }
});

test("turning warnings off while Sleep waits on Chrome stops it before the next native call: no discard, no confirmation", async () => {
  const start = Date.now() + 7000 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  let answer;
  const calls = [];
  webviews.set(hidden, { sleepIfHidden: () => (calls.push("sleepIfHidden"), new Promise((resolve) => (answer = resolve))), discard: async () => (calls.push("discard"), "discarded") });
  reset();
  globalThis.busyTest.tasks = [{ pid: 61, tabIds: [hidden] }];
  await burn(start, 2, { 61: 1 });
  const warning = globalThis.busyTest.toasts[0];
  warning.action.run();
  await settle();
  assert.deepEqual(calls, ["sleepIfHidden"]);
  S().updateSettings({ busyTabWarnings: false });
  answer([25]);
  await settle();
  S().updateSettings({ busyTabWarnings: true });
  assert.deepEqual(calls, ["sleepIfHidden"], "Chrome kept it only from automatic sleep, but warnings went off, so it isn't discarded past that");
  assert.equal(globalThis.busyTest.toasts.length, 1);
  webviews.clear();
});

test("a CPU read that fails after warnings went off and on again doesn't stop the new watch", async () => {
  const start = Date.now() + 7200 * MINUTE;
  windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  let fail;
  const pending = watchBusyTabs(start, () => new Promise((_, reject) => (fail = reject)));
  await settle();
  S().updateSettings({ busyTabWarnings: false });
  S().updateSettings({ busyTabWarnings: true });
  fail(new Error("engine.childProcessCpu isn't there"));
  await pending;
  let reads = 0;
  await watchBusyTabs(start + 10 * SECOND, async () => (reads++, []));
  assert.equal(reads, 1, "the next tick still reads");
  webviews.clear();
});

test("a Keep Running whose site check is still pending when warnings go off saves nothing", async () => {
  const start = Date.now() + 7400 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ pid: 62, tabIds: [hidden] }];
  await burn(start, 2, { 62: 1 });
  let answer;
  globalThis.busyTest.validate = () => new Promise((resolve) => (answer = resolve));
  try {
    globalThis.busyTest.toasts[0].secondary.run();
    await settle();
    S().updateSettings({ busyTabWarnings: false });
    answer(true);
    await settle();
    assert.deepEqual(S().settings.keepActiveSites, []);
  } finally {
    globalThis.busyTest.validate = null;
    S().updateSettings({ busyTabWarnings: true });
  }
  webviews.clear();
});

test("the CPU read needs native API 94, so an older build refuses this JavaScript instead of showing a setting it can't serve", () => {
  const js = readFileSync(new URL("../../platform/nativeApi.ts", import.meta.url), "utf8");
  const swift = readFileSync(new URL("../../../../../packages/shell/ios/AppModule.swift", import.meta.url), "utf8");
  const version = Number(/export const NATIVE_API_VERSION = (\d+);/.exec(js)?.[1]);
  assert.ok(version >= 94, `NATIVE_API_VERSION is ${version}`);
  assert.equal(Number(/Constant\("apiVersion"\) \{ \(\) -> Int in (\d+) \}/.exec(swift)?.[1]), version);
  assert.match(readFileSync(new URL("../../../../../packages/ardiacore/ios/EngineModule.swift", import.meta.url), "utf8"), /"childProcessCpu":/);
});

test("the busy average covers exactly the last two minutes: never before two minutes of readings, never counting CPU from before them", () => {
  const run = (times, coresBetween) => {
    let heat = new Map();
    let used = 0;
    times.forEach((at, i) => {
      if (i) used += coresBetween(times[i - 1], at) * (at - times[i - 1]) * 1000;
      heat = readHeat(heat, [{ pid: 1, started: 1, cpuMs: used }], at * 1000);
    });
    return heat;
  };
  const steady = [0, 5, ...Array.from({ length: 11 }, (_, i) => 15 + i * 10)];
  assert.deepEqual(sustainedBusy(run(steady, () => 1)), [], "115 s of readings at a full core isn't two minutes yet");
  assert.deepEqual(sustainedBusy(run([...steady, 125], () => 1)), [1], "125 s is");
  const burstBefore = [0, 24, ...Array.from({ length: 12 }, (_, i) => 34 + i * 10), 150];
  assert.deepEqual(sustainedBusy(run(burstBefore, (a) => (a === 24 ? 4 : a < 24 ? 0 : 0.55))), [], "a burst that mostly fell before the two minutes doesn't count; the window starts at the cutoff, interpolated");
});

test("Keep Running relies on the saved site exception: removing it brings warnings back, and a refused save confirms nothing", async () => {
  const start = Date.now() + 8000 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ pid: 71, tabIds: [hidden] }];
  await burn(start, 2, { 71: 1 });
  globalThis.busyTest.toasts[0].secondary.run();
  await settle();
  assert.deepEqual(S().settings.keepActiveSites, ["miner.example"]);
  assert.equal(globalThis.busyTest.toasts[1].title, "miner.example will keep running", "confirmed after the save");
  stopKeepingSiteActive("miner.example");
  await burn(start + 200 * MINUTE, 3, { 71: 1 });
  assert.equal(globalThis.busyTest.toasts.length, 3, "the exception is gone, so the busy tab is warned about again");
  reset();
  globalThis.busyTest.validate = () => Promise.resolve(false);
  try {
    await burn(start + 400 * MINUTE, 3, { 71: 1 });
    globalThis.busyTest.toasts[0].secondary.run();
    await settle();
    assert.deepEqual(S().settings.keepActiveSites, []);
    assert.equal(globalThis.busyTest.toasts.length, 1, "Chrome refused the site, nothing was saved, so nothing is confirmed");
  } finally {
    globalThis.busyTest.validate = null;
  }
  webviews.clear();
});

test("the kept-site header, its Add Site button and the list show in Settings whenever Memory Saver or busy-tab warnings read them", () => {
  const env = { top: false, glass: true, syncOn: false, calendarAccess: false, officialPlugins: [] };
  const headerShown = (settings) => !unshownSettings(parseSettings(settings), env).split("\n").includes("advanced.keepActiveSites");
  assert.equal(keptSitesListed({ memorySaver: true, busyTabWarnings: false }), true);
  assert.equal(keptSitesListed({ memorySaver: false, busyTabWarnings: true }), true, "Memory Saver off, warnings on: Keep Running's sites stay visible, removable and addable");
  assert.equal(keptSitesListed({ memorySaver: false, busyTabWarnings: false }), false);
  assert.equal(headerShown({ memorySaver: true, busyTabWarnings: false }), true);
  assert.equal(headerShown({ memorySaver: false, busyTabWarnings: true }), true, "the header with Add Site shows over the list, never headless rows");
  assert.equal(headerShown({ memorySaver: false, busyTabWarnings: false }), false);
  PLATFORM_FEATURES.busyTabWatch = false;
  try {
    assert.equal(keptSitesListed({ memorySaver: false, busyTabWarnings: true }), false, "where the platform has no watch, only Memory Saver counts");
    assert.equal(headerShown({ memorySaver: false, busyTabWarnings: true }), false);
  } finally {
    PLATFORM_FEATURES.busyTabWatch = true;
  }
  const pane = readFileSync(new URL("../../components/settings/panes/Advanced.tsx", import.meta.url), "utf8");
  assert.match(pane, /const sitesListed = useSettings\(keptSitesListed\);/);
  assert.match(pane, /\{sitesListed &&\s+\[\.\.\.keepActiveSites\]/, "the list follows the same rule as its header");
});

test("a saved site keeps its host and subdomains active; rules with a path, query, port or wildcard never silence a warning", () => {
  assert.ok(keptActive("https://music.youtube.com/watch?v=1", ["youtube.com"]), "a host keeps its subdomains");
  assert.ok(keptActive("https://youtube.com/", ["https://youtube.com/"]), "a scheme or a trailing slash is the same host");
  assert.ok(!keptActive("https://notyoutube.com/", ["youtube.com"]));
  assert.ok(keptActive("https://example.com/", [".example.com"]) && !keptActive("https://www.example.com/", [".example.com"]), "a leading dot keeps that host only");
  for (const rule of ["example.com/docs", "example.com/?q=work*", "example.com:8080", "*", "*.example.com", "[*.]example.com"]) assert.ok(!keptActive("https://example.com/docs?q=workday", [rule]), `${rule} doesn't count: one extra warning, and Keep Running is right there`);
  assert.ok(!keptActive("file:///tmp/x.html", ["tmp"]));
  assert.equal(siteToKeepActive("https://www.figma.com/file/1"), "figma.com");
  assert.equal(siteToKeepActive("about:blank"), null);
});

test("the site comes from the address's own host on the Mac's URL too: a query holding an @ doesn't move it", async () => {
  const real = globalThis.URL;
  globalThis.URL = class {
    constructor(url) {
      this._url = url;
    }
    get protocol() {
      return /^([a-z][a-z0-9+.-]*:)/i.exec(this._url)?.[1] ?? "";
    }
    get hostname() {
      const hostnameMatch = this._url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
      return hostnameMatch ? hostnameMatch[1] : "";
    }
  };
  try {
    const address = "https://miner.example/?user=alice@other.example";
    assert.equal(new URL(address).hostname, "other.example", "React Native's URL (Libraries/Blob/URL.js) reads the wrong host here");
    assert.equal(siteToKeepActive(address), "miner.example");
    assert.ok(keptActive(address, ["miner.example"]), "an existing exception for the tab's real site is found");
    assert.ok(!keptActive(address, ["other.example"]));
  } finally {
    globalThis.URL = real;
  }
  const start = Date.now() + 9000 * MINUTE;
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/" });
  const tab = S().newTab(w, { url: "https://miner.example/?user=alice@other.example", background: true });
  S().updateTab(tab, { title: "Miner", lastActiveAt: start - 10 * MINUTE });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, { sleepIfHidden: async () => [], discard: async () => "discarded" });
  reset();
  globalThis.busyTest.tasks = [{ pid: 81, tabIds: [tab] }];
  await burn(start, 2, { 81: 1 });
  globalThis.busyTest.toasts[0].secondary.run();
  await settle();
  assert.deepEqual(S().settings.keepActiveSites, ["miner.example"], "Keep Running saves the tab's real site");
  webviews.clear();
});

test("a tab counts as hidden from the first tick that saw it hidden, so it never warns before two full minutes out of sight", async () => {
  const start = Date.now() + 9500 * MINUTE;
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/" });
  const front = Object.keys(S().tabs)[0];
  const busy = S().newTab(w, { url: "https://miner.example/page", background: true });
  S().updateTab(busy, { title: "Busy Loop Page", lastActiveAt: start - 10 * MINUTE });
  webviews.clear();
  for (const id of [front, busy]) webviews.set(id, { sleepIfHidden: async () => [], discard: async () => "discarded" });
  S().activate(busy);
  reset();
  globalThis.busyTest.tasks = [{ pid: 91, tabIds: [busy] }];
  let used = 0;
  const tick = (t) => watchBusyTabs(start + t * SECOND, async () => [{ pid: 91, started: 3, cpuMs: (used = t * 1000) }]);
  await tick(0);
  S().activate(front);
  S().updateTab(busy, { lastActiveAt: start - 10 * MINUTE });
  for (let t = 10; t <= 120; t += 10) await tick(t);
  assert.equal(globalThis.busyTest.toasts.length, 0, "hidden 5 s after the tick that last saw it: at 120 s it has been out of sight for only 115 s");
  await tick(130);
  assert.equal(globalThis.busyTest.toasts.length, 1, "warned once two full minutes from the first tick that saw it hidden have passed");
  webviews.clear();
});

test("a site kept active while Sleep waits on Chrome stops the fallback discard", async () => {
  const start = Date.now() + 10000 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  let answer;
  const calls = [];
  webviews.set(hidden, { sleepIfHidden: () => (calls.push("sleepIfHidden"), new Promise((resolve) => (answer = resolve))), discard: async () => (calls.push("discard"), "discarded") });
  reset();
  globalThis.busyTest.tasks = [{ pid: 101, tabIds: [hidden] }];
  await burn(start, 2, { 101: 1 });
  globalThis.busyTest.toasts[0].action.run();
  await settle();
  assert.deepEqual(calls, ["sleepIfHidden"]);
  S().updateSettings({ keepActiveSites: ["miner.example"] });
  answer([25]);
  await settle();
  assert.deepEqual(calls, ["sleepIfHidden"], "the user protected the site meanwhile, so it isn't discarded past Chrome's automatic protection");
  webviews.clear();
});

test("Keep Running does nothing once the warned tab has gone to another site", async () => {
  const start = Date.now() + 10500 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ pid: 102, tabIds: [hidden] }];
  await burn(start, 2, { 102: 1 });
  const warning = globalThis.busyTest.toasts[0];
  S().updateTab(hidden, { url: "https://elsewhere.example/" });
  warning.secondary.run();
  await settle();
  assert.deepEqual(S().settings.keepActiveSites, [], "neither the old site, which the tab left, nor the new one is saved");
  assert.equal(globalThis.busyTest.toasts.length, 1, "and nothing is confirmed");
  webviews.clear();
});

const steadyTicks = (pid, start, started = 5) => (t) => watchBusyTabs(start + t * SECOND, async () => [{ pid, started, cpuMs: t * 1000 }]);

test("a task lookup that fails isn't remembered as a process holding no tabs: the next tick asks again", async () => {
  const start = Date.now() + 11000 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ pid: 111, tabIds: [hidden] }];
  globalThis.busyTest.failLookups = 1;
  const tick = steadyTicks(111, start);
  for (let t = 0; t <= 120; t += 10) await tick(t);
  assert.equal(globalThis.busyTest.toasts.length, 0, "the lookup at 120 s failed");
  await tick(130);
  assert.equal(globalThis.busyTest.toasts.length, 1, "and the next tick looked again and warned");
  webviews.clear();
});

test("a warning and its Keep Running cover the same host when one process holds tabs on several", async () => {
  const start = Date.now() + 11500 * MINUTE;
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/" });
  const a = S().newTab(w, { url: "https://a.example/x", background: true });
  const b = S().newTab(w, { url: "https://b.example/y", background: true });
  S().updateTab(a, { title: "Alpha", lastActiveAt: start - 10 * MINUTE });
  S().updateTab(b, { title: "Beta", lastActiveAt: start - 10 * MINUTE });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, { sleepIfHidden: async () => [], discard: async () => "discarded" });
  reset();
  globalThis.busyTest.tasks = [{ pid: 112, tabIds: [a, b] }];
  await burn(start, 2, { 112: 1 });
  assert.equal(globalThis.busyTest.toasts[0].title, "“Alpha” is using a lot of power", "it names only the tabs on the host it would keep");
  globalThis.busyTest.toasts[0].secondary.run();
  await settle();
  assert.deepEqual(S().settings.keepActiveSites, ["a.example"]);
  assert.equal(globalThis.busyTest.toasts[1].title, "a.example will keep running");
  webviews.clear();
});

test("closing a tab the busy process held drops the cached owners, so the tab left behind is warned about without waiting out the cache", async () => {
  const start = Date.now() + 12000 * MINUTE;
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/" });
  const hidden = S().newTab(w, { url: "https://miner.example/page", background: true });
  const shown = S().newTab(w, { url: "https://miner.example/other", background: true });
  S().updateTab(hidden, { title: "Busy Loop Page", lastActiveAt: start - 10 * MINUTE });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, { sleepIfHidden: async () => [], discard: async () => "discarded" });
  S().activate(shown);
  reset();
  globalThis.busyTest.tasks = [{ pid: 113, tabIds: [hidden, shown] }];
  const tick = steadyTicks(113, start);
  for (let t = 0; t <= 120; t += 10) await tick(t);
  assert.equal(globalThis.busyTest.toasts.length, 0, "the process also draws the tab in front");
  S().closeTabs([shown]);
  webviews.delete(shown);
  globalThis.busyTest.tasks = [{ pid: 113, tabIds: [hidden] }];
  assert.ok(!shownTabIds(S()).has(hidden));
  await tick(130);
  assert.equal(globalThis.busyTest.toasts.length, 1, "the next tick looks again instead of trusting owners cached a few seconds before");
  webviews.clear();
});

test("a tab that leaves the warned site while Keep Running's site check is pending saves nothing", async () => {
  const start = Date.now() + 12500 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  reset();
  globalThis.busyTest.tasks = [{ pid: 121, tabIds: [hidden] }];
  await burn(start, 2, { 121: 1 });
  let answer;
  globalThis.busyTest.validate = () => new Promise((resolve) => (answer = resolve));
  try {
    globalThis.busyTest.toasts[0].secondary.run();
    await settle();
    S().updateTab(hidden, { url: "https://elsewhere.example/" });
    answer(true);
    await settle();
    assert.deepEqual(S().settings.keepActiveSites, [], "the tab went to another site while the check ran, so the old one isn't saved");
    assert.equal(globalThis.busyTest.toasts.length, 1, "and nothing is confirmed");
  } finally {
    globalThis.busyTest.validate = null;
  }
  webviews.clear();
});

function windowWithTwoHosts(start, pid) {
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/" });
  const a = S().newTab(w, { url: "https://a.example/x", background: true });
  const b = S().newTab(w, { url: "https://b.example/y", background: true });
  S().updateTab(a, { title: "Alpha", lastActiveAt: start - 10 * MINUTE });
  S().updateTab(b, { title: "Beta", lastActiveAt: start - 10 * MINUTE });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, { sleepIfHidden: async () => [], discard: async () => "discarded" });
  reset();
  globalThis.busyTest.tasks = [{ pid, tabIds: [a, b] }];
  return { w, a, b };
}

test("R5-S1: a warning and a Keep Running for one host neither quiet nor keep the other host the same process holds", async () => {
  const start = Date.now() + 13000 * MINUTE;
  windowWithTwoHosts(start, 131);
  const tick = steadyTicks(131, start);
  for (let t = 0; t <= 120; t += 10) await tick(t);
  assert.equal(globalThis.busyTest.toasts[0].title, "“Alpha” is using a lot of power");
  globalThis.busyTest.toasts[0].secondary.run();
  await settle();
  assert.deepEqual(S().settings.keepActiveSites, ["a.example"]);
  await tick(130);
  assert.equal(globalThis.busyTest.toasts.at(-1).title, "“Beta” is using a lot of power", "b.example was never named, so it is neither quiet nor kept");
  webviews.clear();
});

test("R5-S2: Sleep never discards a page the tab moved to while Chrome was answering", async () => {
  const start = Date.now() + 13500 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  let answer;
  const calls = [];
  webviews.set(hidden, { sleepIfHidden: () => (calls.push("sleepIfHidden"), new Promise((resolve) => (answer = resolve))), discard: async () => (calls.push("discard"), "discarded") });
  reset();
  globalThis.busyTest.tasks = [{ pid: 132, tabIds: [hidden] }];
  await burn(start, 2, { 132: 1 });
  globalThis.busyTest.toasts[0].action.run();
  await settle();
  assert.deepEqual(calls, ["sleepIfHidden"]);
  S().updateTab(hidden, { url: "https://miner.example/next" });
  globalThis.busyTest.tasks = [{ pid: 133, tabIds: [hidden] }];
  answer([25]);
  await settle();
  assert.deepEqual(calls, ["sleepIfHidden"], "the tab navigated to another page in another process, so the fallback discard isn't sent");
  webviews.clear();
});

test("R5-S3: owners looked up while one of their tabs navigated aren't cached, so the hidden tab left behind is warned about next tick", async () => {
  const start = Date.now() + 14000 * MINUTE;
  S().hydrate({});
  S().updateSettings({ keepActiveSites: [] });
  const w = S().createWindow({ url: "https://front.example/" });
  const a = S().newTab(w, { url: "https://miner.example/a", background: true });
  const b = S().newTab(w, { url: "https://miner.example/b", background: true });
  S().updateTab(a, { title: "Alpha", lastActiveAt: start - 10 * MINUTE });
  S().updateTab(b, { title: "Beta", lastActiveAt: start - 10 * MINUTE });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, { sleepIfHidden: async () => [], discard: async () => "discarded" });
  reset();
  globalThis.busyTest.tasks = [{ pid: 134, tabIds: [a, b] }];
  let first = true;
  globalThis.busyTest.onLookup = () => {
    if (!first) return;
    first = false;
    S().updateTab(b, { url: "https://other.example/" });
    S().activate(b);
    globalThis.busyTest.tasks = [{ pid: 134, tabIds: [a] }];
  };
  const tick = steadyTicks(134, start);
  for (let t = 0; t <= 120; t += 10) await tick(t);
  assert.equal(globalThis.busyTest.toasts.length, 0, "the lookup at 120 s raced Beta's navigation");
  await tick(130);
  assert.equal(globalThis.busyTest.toasts.length, 1, "the stale pairing wasn't cached, so the next tick looks again and warns about Alpha");
  assert.equal(globalThis.busyTest.toasts[0].title, "“Alpha” is using a lot of power");
  webviews.clear();
});

test("R5-S4: a saved scheme must match the page's", () => {
  assert.ok(keptActive("https://example.com/", ["https://example.com"]));
  assert.ok(!keptActive("http://example.com/", ["https://example.com"]), "Chromium applies an https:// exception to HTTPS only");
  assert.ok(keptActive("http://example.com/", ["example.com"]) && keptActive("https://example.com/", ["example.com"]), "a rule without a scheme covers both");
});

test("R5-S5: a saved IPv6 literal keeps that address", () => {
  assert.equal(siteToKeepActive("http://[::1]:8080/"), "[::1]");
  assert.ok(keptActive("http://[::1]:8080/", ["[::1]"]), "what Keep Running saves for an IPv6 page is recognised");
  assert.ok(!keptActive("http://[::2]/", ["[::1]"]));
  assert.ok(!keptActive("http://[::1]/", ["[0:0::1]"]), "only the canonical literal counts");
});

test("R5-S6: with warnings off, store updates don't recompute which tabs are shown", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://front.example/" });
  const tab = S().newTab(w, { url: "https://other.example/", background: true });
  startBusyTabWatch();
  S().updateSettings({ busyTabWarnings: false });
  try {
    const before = globalThis.busyTest.shownCalls ?? 0;
    for (let i = 0; i < 5; i++) S().updateTab(tab, { title: `Title ${i}` });
    assert.equal(globalThis.busyTest.shownCalls ?? 0, before);
  } finally {
    S().updateSettings({ busyTabWarnings: true });
  }
});
