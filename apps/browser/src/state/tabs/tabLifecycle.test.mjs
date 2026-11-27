import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;

const performance = import.meta.resolve("../../platform/performance.ts");
const profiles = import.meta.resolve("../../platform/profiles.ts");
globalThis.engineCalls = [];
const stubs = {
  "../../platform/performance": `export * from ${JSON.stringify(performance)};
    export const onSystemState = () => ({ remove() {} });
    export const systemState = async () => null;
    export const setBatterySaver = async (mode) => (globalThis.engineCalls.push(["batterySaver", mode]), { state: 0, active: false });
    export const setMemorySaver = async (request) => (globalThis.engineCalls.push(["memorySaver", request]), { ...request, active: request.state === "on", invalid: [] });`,
  "../../platform/profiles": `export * from ${JSON.stringify(profiles)};
    export const releaseProfile = async () => {};`,
  "../app/toasts": "export const showToast = () => {};",
  "../settings/settingsWindows": "export const openSettings = () => {};",
  "../pages/urls": "export const isInternalTab = (t) => !/^https?:/.test(t.url ?? '');",
};
registerHooks({
  resolve(specifier, context, next) {
    if (!/\/state\/tabs\/(?:tabLifecycle|memorySaver|shownTabs|recentTabWarmup)\.ts$/.test(context.parentURL ?? "") || !(specifier in stubs)) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../browser/store.ts");
const lifecycle = await import("./tabLifecycle.ts");
const { keepActiveSiteOf, memorySaverRequest } = await import("./memorySaver.ts");
const { reloadRecentTabs } = await import("./recentTabWarmup.ts");
const { loadSession: loadSavedSession } = await import("../session/persist.ts");
const { docs: savedDocs } = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "tab-lifecycle-test");

const S = () => useBrowser.getState();
const memorySaverCalls = () => globalThis.engineCalls.filter(([name]) => name === "memorySaver").map(([, request]) => request);

test("the app's Memory Saver settings reach the engine at launch and on every change", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  S().hydrate({ settings: { memorySaver: false, memorySaverMode: "maximum", keepActiveSites: ["music.youtube.com"] } });
  globalThis.engineCalls.length = 0;
  lifecycle.startTabLifecycle();
  assert.deepEqual(memorySaverCalls(), [{ state: "off", aggressiveness: "maximum", sites: ["music.youtube.com"] }]);
  S().updateSettings({ memorySaver: true });
  S().updateSettings({ memorySaverMode: "moderate" });
  S().updateSettings({ keepActiveSites: ["music.youtube.com", "figma.com"] });
  S().updateSettings({ showFullUrl: !S().settings.showFullUrl });
  assert.deepEqual(memorySaverCalls().slice(1), [
    { state: "on", aggressiveness: "maximum", sites: ["music.youtube.com"] },
    { state: "on", aggressiveness: "moderate", sites: ["music.youtube.com"] },
    { state: "on", aggressiveness: "moderate", sites: ["music.youtube.com", "figma.com"] },
  ]);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(globalThis.engineCalls.filter(([name]) => name === "batterySaver").map(([, mode]) => mode), ["off"], "Battery Saver is always Chrome's: on or off, never left to Chrome's default");
});

test("a saved Memory Saver mode or site list the engine wouldn't take falls back instead of reaching it", () => {
  assert.deepEqual(memorySaverRequest({ memorySaver: true, memorySaverMode: "turbo", keepActiveSites: ["a.com", 3] }), { state: "on", aggressiveness: "balanced", sites: ["a.com"] });
  assert.deepEqual(memorySaverRequest({ memorySaver: undefined, memorySaverMode: undefined, keepActiveSites: undefined }), { state: "on", aggressiveness: "balanced", sites: [] });
});

test("a kept-active site lowercases only its scheme and host, since Chrome matches the path and query as typed", () => {
  assert.equal(keepActiveSiteOf("  HTTPS://Example.COM/Editor?Doc=AbC "), "https://example.com/Editor?Doc=AbC");
  assert.equal(keepActiveSiteOf("Docs.Google.com/Document/D/XyZ"), "docs.google.com/Document/D/XyZ");
  assert.equal(keepActiveSiteOf("[*.]YouTube.com"), "[*.]youtube.com");
  assert.equal(keepActiveSiteOf("https://Figma.com/"), "https://figma.com", "a bare trailing slash goes, as before");
  assert.equal(keepActiveSiteOf("music.youtube.com"), "music.youtube.com");
});

test("a synced list saved with lowercased entries reaches the engine unchanged", () => {
  assert.deepEqual(memorySaverRequest({ memorySaver: true, memorySaverMode: "balanced", keepActiveSites: ["https://example.com/editor"] }).sites, ["https://example.com/editor"]);
});

test("a tab Chrome discarded shows as sleeping until it's ready again or gone", () => {
  S().hydrate({});
  lifecycle.noteDiscarded("t1");
  lifecycle.noteDiscarded("t2");
  assert.deepEqual(lifecycle.useLifecycle.getState().discarded, { t1: true, t2: true });
  lifecycle.noteReady("t1");
  lifecycle.noteGone("t2");
  assert.deepEqual(lifecycle.useLifecycle.getState().discarded, {});
});

test("a pinned tab Memory Saver's timer put to sleep is counted; a tab put to sleep by hand, under memory pressure or unpinned is not", async () => {
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  const takePinnedTabsSleptByMemorySaver = () => takeTabSleepCounts().pinned_tabs_slept_by_memory_saver;
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const tile = S().newTab(w, { url: "https://tile.com/", background: true });
  const row = S().newTab(w, { url: "https://row.com/", background: true });
  const plain = S().newTab(w, { url: "https://plain.com/", background: true });
  S().updateTab(tile, { pin: { as: "tile" } });
  S().updateTab(row, { pin: { as: "row" } });
  takePinnedTabsSleptByMemorySaver();
  lifecycle.noteDiscarded(tile, "proactive");
  lifecycle.noteDiscarded(row, "proactive");
  lifecycle.noteDiscarded(plain, "proactive");
  assert.equal(takePinnedTabsSleptByMemorySaver(), 2);
  assert.equal(lifecycle.useLifecycle.getState().discarded[tile], true);
  lifecycle.noteDiscarded(tile, "external");
  lifecycle.noteDiscarded(tile, "urgent");
  lifecycle.noteDiscarded(tile, null);
  lifecycle.noteDiscarded(tile);
  assert.equal(takePinnedTabsSleptByMemorySaver(), 0);
  for (const id of [tile, row, plain]) lifecycle.noteGone(id);
});

test("Battery Saver turns on at 20% battery or lower, in Low Power Mode, or whenever unplugged when asked to", () => {
  const sys = (onBattery, batteryLevel, lowPowerMode = false) => ({ onBattery, batteryLevel, lowPowerMode, memoryPressure: "normal", physicalMemory: 16 * 2 ** 30 });
  const wanted = (when, state) => lifecycle.batterySaverWanted(when, state).on;
  assert.equal(wanted("lowBattery", sys(true, 0.8)), false, "on battery with charge left");
  assert.equal(wanted("lowBattery", sys(true, 0.2)), true);
  assert.equal(wanted("lowBattery", sys(true, 0.204)), true, "shows as 20%");
  assert.equal(wanted("lowBattery", sys(true, 0.21)), false);
  assert.equal(wanted("lowBattery", sys(false, 0.1)), false, "plugged in");
  assert.equal(wanted("lowBattery", sys(false, 0.9, true)), true, "Low Power Mode");
  assert.equal(wanted("lowBattery", sys(true, null)), false, "no battery level");
  assert.equal(wanted("unplugged", sys(true, 0.9)), true);
  assert.equal(wanted("unplugged", sys(false, 0.9)), false);
  assert.equal(wanted("never", sys(true, 0.05, true)), false);
  assert.equal(wanted("lowBattery", null), false);
});

test("Battery Saver turned on by low battery stays on through 20%/21% readings until the Mac is plugged in", () => {
  const sys = (onBattery, batteryLevel) => ({ onBattery, batteryLevel, lowPowerMode: false, memoryPressure: "normal", physicalMemory: 16 * 2 ** 30 });
  let held = false;
  const step = (when, state) => {
    const next = lifecycle.batterySaverWanted(when, state, held);
    held = next.lowBatteryHeld;
    return next.on;
  };
  assert.deepEqual([0.21, 0.2, 0.21, 0.2, 0.21, 0.5].map((level) => step("lowBattery", sys(true, level))), [false, true, true, true, true, true]);
  assert.equal(step("lowBattery", sys(false, 0.21)), false, "plugged in");
  assert.equal(step("lowBattery", sys(true, 0.21)), false, "unplugged again above 20%");
  assert.equal(step("lowBattery", sys(true, 0.2)), true);
  assert.equal(step("never", sys(true, 0.2)), false);
  assert.equal(step("lowBattery", sys(true, 0.21)), false, "a changed setting starts over");
});

test("Battery Saver's old switch: a choice and any off are kept, the old default moves to When battery is low", () => {
  const hydrated = (settings) => {
    savedDocs.set("session.json", JSON.stringify({ version: 7, profiles: S().profiles, profileOrder: S().profileOrder, settings, windows: [], windowOrder: [], tabs: [], groups: [], splits: [] }));
    S().hydrate(loadSavedSession());
    return { ...S().settings, chosen: S().settingsMeta.chosen };
  };
  const untouched = hydrated({ batterySaver: true, showFullUrl: true, chosen: ["showFullUrl"], inferred: [] });
  assert.equal(untouched.batterySaverWhen, "lowBattery");
  assert.equal("batterySaver" in untouched, false);
  assert.deepEqual(untouched.chosen, ["showFullUrl"]);
  const off = hydrated({ batterySaver: false, chosen: ["batterySaver"], inferred: [] });
  assert.equal(off.batterySaverWhen, "never");
  assert.deepEqual(off.chosen, ["batterySaverWhen"]);
  assert.equal(hydrated({ batterySaver: true, chosen: ["batterySaver"], inferred: [] }).batterySaverWhen, "unplugged");
  assert.equal(hydrated({ batterySaver: false, chosen: ["batterySaver"], inferred: ["batterySaver"] }).batterySaverWhen, "never", "off was never the default, so it was chosen");
  assert.equal(hydrated({ batterySaver: false }).batterySaverWhen, "never", "legacy save turned off");
  assert.equal(hydrated({ batterySaver: true, chosen: ["batterySaver"], inferred: ["batterySaver"] }).batterySaverWhen, "lowBattery", "on, saved before choices were tracked");
  assert.equal(hydrated({ batterySaver: true }).batterySaverWhen, "lowBattery", "legacy save left on");
  assert.equal(hydrated({ batterySaverWhen: "never", chosen: ["batterySaverWhen"] }).batterySaverWhen, "never");
});

test("a recent pin queued for warming at launch stays closed when the user closes it before its turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const pin = S().newTab(w, { url: "https://p.com", background: true, pinned: true });
  const warm = S().newTab(w, { url: "https://q.com", background: true, pinned: true });
  const cold = (id) => ({ ...S().tabs[id], page: { kind: "idle" }, lastActiveAt: Date.now() });
  useBrowser.setState({ tabs: { ...S().tabs, [pin]: cold(pin), [warm]: cold(warm) } });
  const sys = { physicalMemory: 32 * 2 ** 30, onBattery: false, lowPowerMode: false, memoryPressure: "normal" };

  const queued = reloadRecentTabs(sys);
  assert.ok(queued.includes(pin) && queued.includes(warm));
  S().activate(pin);
  S().closeTab(pin);
  assert.equal(S().tabs[pin].page.kind, "asleep");
  t.mock.timers.tick(2000 * queued.length);

  assert.equal(S().tabs[pin].page.kind, "asleep", "the closed pin stays closed");
  assert.equal(S().tabs[pin].page.nav, undefined);
  assert.ok(S().tabs[warm].page.nav, "a pin left alone still warms up");
  assert.notEqual(S().tabs[warm].page.kind, "asleep");
});

test("the loaded tab budget grows with the Mac's memory, and shrinks to the mode's floor under memory pressure", async () => {
  const { loadedTabBudget } = await import("./loadedTabBudget.ts");
  const sys = (gib, memoryPressure = "normal") => ({ onBattery: false, batteryLevel: null, lowPowerMode: false, memoryPressure, physicalMemory: gib * 2 ** 30 });
  const on = (memorySaverMode) => ({ memorySaver: true, memorySaverMode });
  const minutes = (budget) => budget && { tabs: budget.tabs, minutes: budget.hiddenMs / 60_000 };
  assert.deepEqual(minutes(loadedTabBudget(on("balanced"), sys(8))), { tabs: 10, minutes: 60 }, "an 8 GB Mac keeps Dia's ten");
  assert.deepEqual(minutes(loadedTabBudget(on("balanced"), sys(16))), { tabs: 16, minutes: 60 });
  assert.deepEqual(minutes(loadedTabBudget(on("balanced"), sys(24))), { tabs: 24, minutes: 60 });
  assert.deepEqual(minutes(loadedTabBudget(on("balanced"), sys(64))), { tabs: 24, minutes: 60 }, "a big Mac stops at the mode's ceiling instead of keeping one tab per gigabyte");
  assert.deepEqual(minutes(loadedTabBudget(on("moderate"), sys(64))), { tabs: 48, minutes: 120 });
  assert.deepEqual(minutes(loadedTabBudget(on("maximum"), sys(64))), { tabs: 12, minutes: 30 });
  assert.deepEqual(minutes(loadedTabBudget(on("moderate"), sys(16))), { tabs: 32, minutes: 120 });
  assert.deepEqual(minutes(loadedTabBudget(on("maximum"), sys(16))), { tabs: 8, minutes: 30 });
  assert.deepEqual(minutes(loadedTabBudget(on("maximum"), sys(8))), { tabs: 5, minutes: 30 });
  assert.deepEqual(minutes(loadedTabBudget(on("balanced"), sys(32, "warning"))), { tabs: 10, minutes: 5 }, "under a memory warning the floor, and five minutes hidden");
  assert.deepEqual(minutes(loadedTabBudget(on("moderate"), sys(32, "critical"))), { tabs: 20, minutes: 2 }, "under critical pressure two minutes");
  assert.deepEqual(minutes(loadedTabBudget(on("turbo"), sys(8))), { tabs: 10, minutes: 60 }, "an unknown mode is Balanced");
  assert.equal(loadedTabBudget({ memorySaver: false, memorySaverMode: "maximum" }, sys(8)), null, "Memory Saver off keeps every tab loaded");
  assert.equal(loadedTabBudget(on("balanced"), null), null, "nothing sleeps before the Mac's memory is known");
});

const minute = 60_000;

function windowOfHiddenTabs(count, now) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://active.com/" });
  const ids = Array.from({ length: count }, (_, i) => S().newTab(w, { url: `https://site${i}.com/`, background: true }));
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (i + 1) * 10 * minute }));
  const active = Object.keys(S().tabs).find((id) => !ids.includes(id));
  return { ids, active };
}

test("past the budget only tabs hidden long enough sleep, oldest first; the most recently used, shown, playing and just-refused tabs stay", async () => {
  const { tabsOverBudget } = await import("./loadedTabBudget.ts");
  const now = Date.now() + 24 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(14, now);
  const loaded = [active, ...ids];
  const budget = { tabs: 10, hiddenMs: 30 * minute };
  const over = (b = budget, seen, refused) => tabsOverBudget(S(), loaded, b, now, seen, refused);
  assert.deepEqual(over(), [ids[13], ids[12], ids[11], ids[10], ids[9]], "the shown tab and the 9 most recently used stay; the rest go oldest first");
  assert.deepEqual(over({ tabs: 15, hiddenMs: 0 }), [], "at or under the budget nothing sleeps");
  assert.deepEqual(over({ tabs: 10, hiddenMs: 125 * minute }), [ids[13], ids[12]], "a tab over the budget stays until it has been hidden long enough");
  assert.deepEqual(over({ tabs: 2, hiddenMs: 30 * minute }), ids.slice(2).reverse(), "a tab used in the last half hour stays whatever the budget");
  assert.deepEqual(over(budget, new Map([[ids[13], now - minute]])), [ids[12], ids[11], ids[10], ids[9], ids[8]], "a tab on screen until a minute ago counts as just used, so the next one goes");
  assert.deepEqual(over(budget, undefined, new Map([[ids[13], now + minute]])), [ids[12], ids[11], ids[10], ids[9]], "a tab Chrome just kept isn't asked again yet, and nobody sleeps in its place");
  assert.deepEqual(over(budget, undefined, new Map([[ids[13], now - minute]])), [ids[13], ids[12], ids[11], ids[10], ids[9]]);
  S().updateLive(ids[12], { playingAudio: true });
  assert.deepEqual(over(), [ids[13], ids[11], ids[10], ids[9]], "a playing tab stays, and no more recent tab sleeps in its place");
  S().updateLive(ids[12], { playingAudio: false });
  S().updateTab(ids[11], { url: "ardia://settings" });
  assert.deepEqual(over(), [ids[13], ids[12], ids[10], ids[9]], "only web pages sleep");
  lifecycle.noteDiscarded(ids[13]);
  assert.deepEqual(over(), [ids[12], ids[10], ids[9]], "a sleeping tab doesn't count as loaded");
  lifecycle.noteReady(ids[13]);
  S().activate(ids[13]);
  assert.ok(!over().includes(ids[13]), "the tab on screen never sleeps");
});

test("Chrome decides each sleep: a tab it keeps, or whose answer doesn't come in time, stays loaded and isn't asked again for ten minutes", async (t) => {
  const { sleepTabsOverBudget, noteTabOpened } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 48 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(6, now);
  const asked = [];
  const answers = { [ids[5]]: async () => [26], [ids[4]]: () => new Promise(() => {}), [ids[3]]: async () => [7], [ids[1]]: async () => { throw new Error("view gone"); } };
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: (seconds) => (asked.push([id, seconds]), answers[id]?.() ?? Promise.resolve([])) });
  takeTabSleepCounts();
  const budget = { tabs: 1, hiddenMs: 10 * minute };
  const sweep = async (at) => {
    const done = sleepTabsOverBudget(budget, at);
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1500);
    }
    return done;
  };
  assert.deepEqual(await sweep(now), [ids[2]], "four tabs are asked per sweep, oldest first: form input keeps one, one never answers, one was on screen too recently, one sleeps");
  assert.deepEqual(asked, [[ids[5], 600], [ids[4], 600], [ids[3], 600], [ids[2], 600]]);
  lifecycle.noteDiscarded(ids[2]);
  asked.length = 0;
  assert.deepEqual(await sweep(now + minute), [ids[0]], "the next sweep leaves the kept tabs alone and goes on to the next oldest; a view that fails keeps its tab too");
  assert.deepEqual(asked.map(([id]) => id), [ids[1], ids[0]]);
  lifecycle.noteDiscarded(ids[0]);
  asked.length = 0;
  assert.deepEqual(await sweep(now + 12 * minute), []);
  assert.deepEqual(asked.map(([id]) => id), [ids[3], ids[5], ids[4], ids[1]], "ten minutes later Chrome is asked again: first the tab it had only seen on screen, then the tabs it kept");
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget, 2);
  lifecycle.noteReady(ids[2]);
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget_reopened, 0, "a page that loads again in the background isn't a reopen");
  noteTabOpened(ids[2], now + minute);
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget_reopened, 1, "a slept tab opened again within half an hour is counted: the sign the budget is too tight");
  noteTabOpened(ids[2], now + minute);
  lifecycle.noteGone(ids[0]);
  noteTabOpened(ids[0], now + minute);
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget_reopened, 0);
  webviews.clear();
});

test("a page the budget sees that isn't a tab, such as a pop-up window's page on Windows, is never asked to sleep", async () => {
  const { tabsOverBudget } = await import("./loadedTabBudget.ts");
  const now = Date.now() + 72 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(3, now);
  const popupPage = "popup:w-1:page";
  const over = tabsOverBudget(S(), [popupPage, active, ...ids], { tabs: 1, hiddenMs: 0 }, now);
  assert.ok(!over.includes(popupPage), "the pop-up's page is never a candidate");
  assert.deepEqual(over, [ids[2], ids[1], ids[0]], "the hidden tabs still are");
});

test("Memory Saver keeps a Peek shown over its tab awake, and treats a Peek hidden with its tab like a hidden tab", async () => {
  const { tabsOverBudget } = await import("./loadedTabBudget.ts");
  const now = Date.now() + 96 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(2, now);
  const peek = S().openPeek(active, "https://peeked.example/");
  assert.ok(peek, "the Peek opens over the shown tab");
  const over = () => tabsOverBudget(S(), [active, peek, ...ids], { tabs: 1, hiddenMs: 0 }, now);
  assert.ok(!over().includes(peek), "the Peek over the shown tab is never a candidate");
  S().activate(ids[0]);
  assert.ok(over().includes(peek), "hidden with its tab, the Peek's page can sleep like a hidden tab");
});

test("a hidden tab that is still loading is never asked to sleep, so a navigation in flight isn't lost", async () => {
  const { tabsOverBudget } = await import("./loadedTabBudget.ts");
  const now = Date.now() + 120 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(3, now);
  S().updateLive(ids[2], { isLoading: true });
  const skipped = [];
  const over = tabsOverBudget(S(), [active, ...ids], { tabs: 1, hiddenMs: 0 }, now, new Map(), new Map(), skipped);
  assert.deepEqual(over, [ids[1], ids[0]], "the loading tab is left out; the others are still asked, oldest first");
  assert.deepEqual(skipped, [ids[2]], "and it is counted as skipped while loading");
  S().updateLive(ids[2], { isLoading: false });
  assert.deepEqual(tabsOverBudget(S(), [active, ...ids], { tabs: 1, hiddenMs: 0 }, now), [ids[2], ids[1], ids[0]], "once its load ends it is a candidate again");
});

test("tabs the engine kept give their asks to tabs not kept yet, so a sweep where old kept tabs come due still sleeps a younger idle tab", async (t) => {
  const { sleepTabsOverBudget } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 240 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(8, now);
  const alwaysKept = new Set(ids.slice(4));
  const asked = [];
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => (asked.push(id), Promise.resolve(alwaysKept.has(id) ? [104] : [])) });
  takeTabSleepCounts();
  const budget = { tabs: 1, hiddenMs: 45 * minute };
  const sweep = async (at) => {
    const done = sleepTabsOverBudget(budget, at);
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1500);
    }
    return done;
  };
  assert.deepEqual(await sweep(now), [], "the four oldest tabs are the only ones hidden long enough, and the engine keeps all four");
  assert.deepEqual(asked, [ids[7], ids[6], ids[5], ids[4]]);
  asked.length = 0;
  const later = now + 10 * minute;
  assert.deepEqual(await sweep(later), [ids[3]], "ten minutes later the kept tabs are due again, and the younger tab now past the wait is asked first and sleeps");
  assert.deepEqual(asked, [ids[3], ids[7], ids[6], ids[5]], "the kept tabs fill the asks that are left");
  assert.equal(takeTabSleepCounts().tabs_over_budget_asks_passed_on, 1, "one ask went from a kept tab to a tab not kept yet");
  webviews.clear();
});

test("a tab switched to 15 times stays loaded, and each kind of protection that kept a tab is counted once per tab", async (t) => {
  const { sleepTabsOverBudget, tabsOverBudget } = await import("./loadedTabBudget.ts");
  const { switchesOf, clearSwitches } = await import("./tabSwitches.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 480 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(4, now);
  lifecycle.startTabLifecycle();
  clearSwitches();
  for (let i = 0; i < 15; i++) {
    S().activate(ids[3]);
    S().activate(active);
  }
  assert.equal(switchesOf(ids[3]), 15, "each switch to the tab counts once");
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (60 + i * 60) * minute }));
  const budget = { tabs: 1, hiddenMs: 30 * minute };
  assert.ok(!tabsOverBudget(S(), [active, ...ids], budget, now).includes(ids[3]), "the oldest tab is kept because it is used all the time");
  webviews.clear();
  const answers = { [ids[2]]: [100], [ids[1]]: [101, 26] };
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => Promise.resolve(answers[id] ?? []) });
  takeTabSleepCounts();
  const sweep = async (at) => {
    const done = sleepTabsOverBudget(budget, at);
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1500);
    }
    return done;
  };
  assert.deepEqual(await sweep(now), [ids[0]], "the page left by a form post and the one with an unload prompt stay; the idle one sleeps");
  lifecycle.noteDiscarded(ids[0]);
  await sweep(now + minute);
  const counts = takeTabSleepCounts();
  assert.equal(counts.sleep_kept_frequently_used, 1, "counted once, not once per sweep");
  assert.equal(counts.sleep_kept_posted_document, 1);
  assert.equal(counts.sleep_kept_before_unload, 1, "an unload prompt outranks typed input");
  assert.equal(counts.sleep_kept_typed_input, 0);
  assert.equal(counts.tabs_slept_over_budget, 1);
  webviews.clear();
  clearSwitches();
});

test("a candidate that starts playing sound while an earlier tab's answer is awaited isn't asked, and each tab is counted once per reason", async (t) => {
  const { sleepTabsOverBudget } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 900 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(3, now);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (60 + i * 60) * minute }));
  const asked = [];
  let answers = {
    [ids[2]]: () => {
      S().updateLive(ids[1], { playingAudio: true });
      return Promise.resolve([26]);
    },
  };
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => (asked.push(id), answers[id]?.() ?? Promise.resolve([])) });
  takeTabSleepCounts();
  const sweep = async (at) => {
    const done = sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, at);
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1500);
    }
    return done;
  };
  assert.deepEqual(await sweep(now), [ids[0]]);
  assert.deepEqual(asked, [ids[2], ids[0]], "the tab that began playing mid-sweep is skipped, not sent to Chromium");
  answers = { [ids[2]]: () => Promise.resolve([26]) };
  await sweep(now + 11 * minute);
  const counts = takeTabSleepCounts();
  assert.equal(counts.sleep_kept_typed_input, 1, "typed input kept the tab twice, counted once");
  assert.equal(counts.sleep_kept_audible, 1);
  S().updateLive(ids[1], { playingAudio: false });
  webviews.clear();
});

test("a protection seen while sharing is off is still counted the first time it is seen after sharing turns on", async (t) => {
  const { sleepTabsOverBudget } = await import("./loadedTabBudget.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 1200 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(2, now);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (60 + i * 60) * minute }));
  S().updateLive(ids[1], { playingAudio: true });
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => Promise.resolve([7]) });
  takeTabSleepCounts();
  setConsentPeriod(false, null);
  await sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, now);
  setConsentPeriod(true, "tab-lifecycle-test-2");
  await sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, now + minute);
  await sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, now + 2 * minute);
  assert.equal(takeTabSleepCounts().sleep_kept_audible, 1, "counted once in the period sharing was on, though first seen before it");
  setConsentPeriod(true, "tab-lifecycle-test");
  S().updateLive(ids[1], { playingAudio: false });
  webviews.clear();
});

test("memory pressure tightens the sweep at once, a few tabs a tick, counts each level reached", async (t) => {
  const { sleepTabsOverBudget, loadedTabBudget } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts, noteMemoryPressure } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 720 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(12, now);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (6 + i) * minute }));
  webviews.clear();
  const asked = [];
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: (seconds) => (asked.push([id, seconds]), Promise.resolve([])) });
  takeTabSleepCounts();
  const sys = (memoryPressure) => ({ onBattery: false, batteryLevel: null, lowPowerMode: false, memoryPressure, physicalMemory: 8 * 2 ** 30 });
  const settings = { memorySaver: true, memorySaverMode: "maximum" };
  const sweep = async (budget, at) => {
    const done = sleepTabsOverBudget(budget, at);
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1500);
    }
    return done;
  };
  assert.deepEqual(await sweep(loadedTabBudget(settings, sys("normal")), now), [], "at normal pressure nothing hidden under half an hour sleeps");
  const warning = loadedTabBudget(settings, sys("warning"));
  assert.equal(warning.everyMs, 15_000);
  const slept = await sweep(warning, now);
  assert.equal(slept.length, 4, "a warning sleeps at most four tabs in one tick");
  assert.deepEqual(asked.map(([, seconds]) => seconds), [300, 300, 300, 300], "each asked with the five minute wait");
  slept.forEach((id) => lifecycle.noteDiscarded(id));
  const critical = loadedTabBudget(settings, sys("critical"));
  assert.equal((await sweep(critical, now + 10_000)).length, 4);
  noteMemoryPressure("warning");
  noteMemoryPressure("critical");
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_under_memory_warning, 4);
  assert.equal(counts.tabs_slept_under_memory_critical, 4);
  assert.equal(counts.tabs_slept_over_budget, 8);
  assert.equal(counts.memory_pressure_warnings, 1);
  assert.equal(counts.memory_pressure_criticals, 1);
  webviews.clear();
});

test("pressure sweeps wait for launch to settle, share one rate limit through a warning, normal, warning flap, and stop when the level changes mid-sweep", async (t) => {
  const { pressureChanged, armPressureSweeps, sweepIfDue, loadedTabBudget } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 1500 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(12, now);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (60 + i) * minute }));
  const sys = (memoryPressure) => ({ onBattery: false, batteryLevel: null, lowPowerMode: false, memoryPressure, physicalMemory: 8 * 2 ** 30 });
  const settings = { memorySaver: true, memorySaverMode: "maximum" };
  const warning = loadedTabBudget(settings, sys("warning"));
  const normal = loadedTabBudget(settings, sys("normal"));
  const asked = [];
  let hold = null;
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => (asked.push(id), hold ? hold : Promise.resolve([7])) });
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1500);
    }
  };
  pressureChanged(null, warning, now);
  await settle();
  assert.deepEqual(asked, [], "a warning read at launch asks nothing until launch has settled");
  armPressureSweeps();
  pressureChanged(null, warning, now);
  await settle();
  pressureChanged(null, normal, now + 100);
  pressureChanged(null, warning, now + 200);
  await settle();
  assert.equal(asked.length, 4, "the flap's second warning is inside the 15 s limit the first sweep started");
  assert.deepEqual(await sweepIfDue(normal, null, now + 30_000), [], "the minute job shares the limit too: 30 s after a sweep is too soon for it");
  asked.length = 0;
  let release;
  hold = new Promise((resolve) => (release = resolve));
  const sweep = sweepIfDue(warning, null, now + 120_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 1, "the sweep is waiting on its first ask");
  pressureChanged(null, normal, now + 120_100);
  release([7]);
  hold = null;
  await settle();
  await sweep;
  assert.equal(asked.length, 1, "after the Mac returns to normal the sweep sends no more asks under the warning's rules");
  webviews.clear();
});

test("crossing the budget while a warning is already on wakes the sweep jobs, once per crossing", async () => {
  const { watchOverBudget } = await import("./loadedTabBudget.ts");
  const { webviews, webviewRef } = await import("../../platform/webviews.ts");
  const now = Date.now() + 2000 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(3, now);
  webviews.clear();
  const refs = Object.fromEntries([active, ...ids].map((id) => [id, webviewRef(id)]));
  refs[active]({ sleepIfHidden: async () => [] });
  refs[ids[0]]({ sleepIfHidden: async () => [] });
  let woken = 0;
  const stop = watchOverBudget(() => ({ tabs: 2, hiddenMs: 5 * minute, pressure: "warning", everyMs: 15_000 }), () => woken++);
  refs[ids[1]]({ sleepIfHidden: async () => [] });
  assert.equal(woken, 1, "a third loaded tab puts the window over a budget of two");
  refs[ids[2]]({ sleepIfHidden: async () => [] });
  assert.equal(woken, 1, "staying over budget isn't a new crossing");
  lifecycle.noteDiscarded(ids[1]);
  lifecycle.noteDiscarded(ids[2]);
  assert.equal(woken, 2, "falling back under it is");
  stop();
  lifecycle.noteReady(ids[1]);
  lifecycle.noteReady(ids[2]);
  webviews.clear();
});

test("under memory pressure a tab an ardia command session holds is never asked, including a hold taken while an earlier ask is awaited", async (t) => {
  const { sleepTabsOverBudget, loadedTabBudget } = await import("./loadedTabBudget.ts");
  const { holdForCli, releaseAllCliHolds } = await import("./cliHolds.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 2400 * 60 * minute;
  const { ids, active } = windowOfHiddenTabs(4, now);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (60 + i * 60) * minute }));
  const sys = { onBattery: false, batteryLevel: null, lowPowerMode: false, memoryPressure: "warning", physicalMemory: 8 * 2 ** 30 };
  const warning = { ...loadedTabBudget({ memorySaver: true, memorySaverMode: "maximum" }, sys), tabs: 1 };
  releaseAllCliHolds();
  holdForCli("s1", [ids[3]]);
  const asked = [];
  webviews.clear();
  const answers = { [ids[2]]: () => (holdForCli("s2", [ids[1]]), Promise.resolve([26])) };
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => (asked.push(id), answers[id]?.() ?? Promise.resolve([])) });
  const done = sleepTabsOverBudget(warning, now);
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1500);
  }
  assert.deepEqual(await done, [ids[0]]);
  assert.deepEqual(asked, [ids[2], ids[0]], "the held tab is left out of the warning sweep, and a hold taken mid-sweep stops its ask");
  releaseAllCliHolds();
  webviews.clear();
});

async function settleSweep(t, done, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1500);
  }
  return done;
}

function unusedWorld(count, now) {
  const { ids, active } = windowOfHiddenTabs(count, now);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (i + 1) * 60 * minute }));
  return { ids, active };
}

test("Sleep tabs unused for asks the engine to check and sleep each tab in one call, oldest first and pinned too, and never forces a sleep itself", async (t) => {
  const { sleepUnusedTabs } = await import("./loadedTabBudget.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 960 * 60 * minute;
  const { ids, active } = unusedWorld(5, now);
  S().updateTab(ids[4], { pin: { as: "tile" } });
  const answers = { [ids[4]]: [200], [ids[3]]: [25, 26], [ids[2]]: [] };
  const asked = [];
  const discards = [];
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfUnused: (seconds) => (asked.push([id, seconds]), Promise.resolve(answers[id] ?? [])), sleepIfHidden: () => Promise.resolve([-1]), discard: async () => (discards.push(id), "discarded") });
  takeTabSleepCounts();
  const after = (ms) => () => ms;
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(after(null), consentToken(), now)), [], "Never asks nothing");
  assert.deepEqual(asked, []);
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(after(150 * minute), consentToken(), now)), [ids[4], ids[2]], "the engine slept the pinned tab past its soft keeps and an idle one; typed input kept the third");
  assert.deepEqual(asked, [[ids[4], 9000], [ids[3], 9000], [ids[2], 9000]], "oldest first, and the engine checks the same wait");
  assert.deepEqual(discards, [], "the app never discards past a keep by itself");
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_unused, 2);
  assert.equal(counts.pinned_tabs_slept_unused, 1);
  assert.equal(counts.tabs_slept_unused_past_soft_keeps, 1);
  lifecycle.noteDiscarded(ids[4]);
  lifecycle.noteDiscarded(ids[2]);
  asked.length = 0;
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(after(150 * minute), consentToken(), now + minute)), [], "the tab with typed input isn't asked again for ten minutes");
  assert.deepEqual(asked, []);
  webviews.clear();
});

test("an unused sweep stops at once when the setting goes to Never mid-sweep, and skips a candidate that starts playing, is shown, held or just seen while it waits", async (t) => {
  const { sleepUnusedTabs } = await import("./loadedTabBudget.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { holdForCli, releaseAllCliHolds } = await import("./cliHolds.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 1500 * 60 * minute;
  const { ids, active } = unusedWorld(4, now);
  let afterMs = 150 * minute;
  const asked = [];
  let onAsk = () => {};
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfUnused: () => (asked.push(id), onAsk(id), Promise.resolve([])) });
  onAsk = () => void (afterMs = null);
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(() => afterMs, consentToken(), now)), [ids[3]], "the first ask was already sent");
  assert.deepEqual(asked, [ids[3]], "no tab is asked after Never");
  lifecycle.noteDiscarded(ids[3]);
  afterMs = 150 * minute;
  asked.length = 0;
  onAsk = (id) => id === ids[2] && S().updateLive(ids[1], { playingAudio: true });
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(() => afterMs, consentToken(), now)), [ids[2]]);
  assert.deepEqual(asked, [ids[2]], "the tab that started playing while the first ask was out isn't asked");
  S().updateLive(ids[1], { playingAudio: false });
  lifecycle.noteDiscarded(ids[2]);
  asked.length = 0;
  onAsk = () => {};
  const { ids: more, active: front } = unusedWorld(3, now);
  webviews.clear();
  for (const id of [front, ...more]) webviews.set(id, { sleepIfUnused: () => (asked.push(id), id === more[2] && (S().activate(more[1]), S().activate(front), holdForCli("s-unused", [more[0]])), Promise.resolve([])) });
  const slept = await settleSweep(t, sleepUnusedTabs(() => afterMs, consentToken(), now));
  assert.deepEqual(slept, [more[2]]);
  assert.deepEqual(asked, [more[2]], "a tab shown for a moment while the ask was out counts as just used, and one a command session took isn't asked");
  releaseAllCliHolds();
  webviews.clear();
});

test("a budget refusal for soft keeps doesn't hold back Sleep tabs unused for", async (t) => {
  const { sleepTabsOverBudget, sleepUnusedTabs } = await import("./loadedTabBudget.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 2000 * 60 * minute;
  const { ids, active } = unusedWorld(2, now);
  const unusedAsks = [];
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => Promise.resolve([13, 25]), sleepIfUnused: () => (unusedAsks.push(id), Promise.resolve([200])) });
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, now)), [], "the budget keeps both for their soft keeps");
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(() => 60 * minute, consentToken(), now + 5 * minute)), [ids[1], ids[0]], "the unused rule still asks them five minutes later");
  assert.deepEqual(unusedAsks, [ids[1], ids[0]]);
  webviews.clear();
});

test("reopen protection and its count come only from opening the tab, paired with the consent the sleep was counted under", async (t) => {
  const { sleepTabsOverBudget, noteTabGone, noteTabOpened } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  const { setConsentPeriod: setPeriod } = await import("../telemetry/consentPeriod.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 2400 * 60 * minute;
  const { ids, active } = unusedWorld(2, now);
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (i + 2) * 60 * minute }));
  const asked = [];
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => (asked.push(id), Promise.resolve([])) });
  takeTabSleepCounts();
  const budget = { tabs: 1, hiddenMs: 30 * minute };
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget(budget, now)), [ids[1], ids[0]]);
  lifecycle.noteDiscarded(ids[1]);
  lifecycle.noteDiscarded(ids[0]);
  lifecycle.noteReady(ids[0]);
  asked.length = 0;
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget(budget, now + 2 * minute)), [ids[0]], "a page that only loaded again in the background, as a hover wake does, gets no protection");
  lifecycle.noteDiscarded(ids[0]);
  lifecycle.noteReady(ids[1]);
  noteTabOpened(ids[1], now + 3 * minute);
  asked.length = 0;
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget(budget, now + 4 * minute)), [], "the opened tab is kept and nobody sleeps in its place");
  let counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_over_budget_reopened, 1);
  assert.equal(counts.sleep_kept_reopened_soon, 1);
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget({ tabs: 1, hiddenMs: 0, pressure: "warning" }, now + 6 * minute)), [ids[1]], "memory pressure overrides it");
  noteTabGone(ids[1]);
  lifecycle.noteDiscarded(ids[1]);
  lifecycle.noteReady(ids[0]);
  takeTabSleepCounts();
  setPeriod(false, "tab-lifecycle-test-off");
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget(budget, now + 60 * minute)), [ids[0]], "slept while sharing is off");
  setPeriod(true, "tab-lifecycle-test-on");
  noteTabOpened(ids[0], now + 61 * minute);
  counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_over_budget, 0);
  assert.equal(counts.tabs_slept_over_budget_reopened, 0, "a reopen is never counted without the sleep it pairs with");
  webviews.clear();
});

test("a split's second pane that just left the screen counts as just used, ahead of older ordinary tabs", async () => {
  const { tabsOverBudget } = await import("./loadedTabBudget.ts");
  const { shownTabIds } = await import("./shownTabs.ts");
  lifecycle.startTabLifecycle();
  const now = Date.now();
  const { ids, active } = unusedWorld(4, now);
  ids.forEach((id) => S().updateTab(id, { lastActiveAt: now - 300 * minute }));
  S().activate(ids[3]);
  S().createSplit([ids[3], ids[0]]);
  assert.ok(shownTabIds(S()).has(ids[0]), "the second pane is on screen");
  S().updateTab(ids[0], { lastActiveAt: now - 300 * minute });
  S().activate(active);
  assert.ok(!shownTabIds(S()).has(ids[0]));
  const over = tabsOverBudget(S(), [active, ...ids], { tabs: 3, hiddenMs: 30 * minute }, now + 5 * minute);
  assert.deepEqual([...over].sort(), [ids[1], ids[2]].sort(), "the second pane left the screen a moment ago and stays; older ordinary tabs go first");
});

test("reopen protection taken while sharing was off still keeps the tab, but its veto isn't counted after sharing turns on", async (t) => {
  const { sleepTabsOverBudget, noteTabOpened, noteTabGone } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  const { setConsentPeriod: setPeriod } = await import("../telemetry/consentPeriod.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 3200 * 60 * minute;
  const { ids, active } = unusedWorld(1, now);
  const asked = [];
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => (asked.push(id), Promise.resolve([])) });
  const budget = { tabs: 1, hiddenMs: 30 * minute };
  setPeriod(false, "reopen-veto-off");
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget(budget, now)), [ids[0]]);
  lifecycle.noteReady(ids[0]);
  noteTabOpened(ids[0], now + minute);
  setPeriod(true, "reopen-veto-on");
  takeTabSleepCounts();
  asked.length = 0;
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget(budget, now + 2 * minute)), [], "still kept");
  assert.deepEqual(asked, []);
  assert.equal(takeTabSleepCounts().sleep_kept_reopened_soon, 0, "no veto counted for a reopen that wasn't");
  noteTabGone(ids[0]);
  webviews.clear();
});

test("a tab asked to sleep by one sweep isn't asked by another until the answer comes, and a slept tab is counted once", async (t) => {
  const { sleepTabsOverBudget, sleepUnusedTabs } = await import("./loadedTabBudget.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 3600 * 60 * minute;
  const { ids, active } = unusedWorld(1, now);
  let answer;
  const asked = [];
  webviews.clear();
  webviews.set(active, { sleepIfHidden: () => Promise.resolve([4]) });
  webviews.set(ids[0], {
    sleepIfHidden: () => (asked.push("budget"), new Promise((resolve) => (answer = resolve))),
    sleepIfUnused: () => (asked.push("unused"), Promise.resolve([])),
  });
  takeTabSleepCounts();
  const budgetSweep = sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await sleepUnusedTabs(() => 60 * minute, consentToken(), now), [], "the unused sweep skips the tab whose ask is out");
  answer([]);
  assert.deepEqual(await budgetSweep, [ids[0]]);
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(() => 60 * minute, consentToken(), now)), [], "the tab the budget just slept is already asleep, before the engine's event arrives");
  assert.deepEqual(asked, ["budget"]);
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_over_budget + counts.tabs_slept_unused, 1);
  webviews.clear();
});

test("an engine that doesn't know the unused-tab call is asked the plain sleep instead", async (t) => {
  const { sleepUnusedTabs } = await import("./loadedTabBudget.ts");
  const { askUnusedSleep } = await import("./sleepAsks.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const plain = [];
  const older = { sleepIfUnused: () => Promise.reject(new Error("unknown command sleepIfUnused")), sleepIfHidden: (seconds) => (plain.push(seconds), Promise.resolve([13])) };
  assert.deepEqual(await askUnusedSleep(older, 60), [13], "an older host's refusal leaves the soft keeps in place");
  assert.deepEqual(await askUnusedSleep({ sleepIfHidden: () => Promise.resolve([]) }, 60), []);
  assert.deepEqual(await askUnusedSleep({ sleepIfUnused: () => { throw new Error("sync"); }, sleepIfHidden: () => Promise.resolve([7]) }, 60), [7]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 4000 * 60 * minute;
  const { ids, active } = unusedWorld(1, now);
  webviews.clear();
  webviews.set(active, { sleepIfHidden: () => Promise.resolve([4]) });
  webviews.set(ids[0], { sleepIfUnused: () => Promise.reject(new Error("unknown command")), sleepIfHidden: (seconds) => (plain.push(seconds), Promise.resolve([])) });
  assert.deepEqual(await settleSweep(t, sleepUnusedTabs(() => 60 * minute, consentToken(), now)), [ids[0]]);
  assert.deepEqual(plain, [60, 3600]);
  webviews.clear();
});

test("a slept tab shown in a Peek or a split pane counts as opened", async (t) => {
  const { sleepTabsOverBudget, noteShownTabs, noteTabGone } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 4400 * 60 * minute;
  const { ids, active } = unusedWorld(1, now);
  webviews.clear();
  for (const id of [active, ...ids]) webviews.set(id, { sleepIfHidden: () => Promise.resolve(id === active ? [4] : []) });
  takeTabSleepCounts();
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, now)), [ids[0]]);
  noteShownTabs(new Set([active]), now);
  noteShownTabs(new Set([active, ids[0]]), now + minute);
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget_reopened, 1);
  noteShownTabs(new Set([active]), now + 2 * minute);
  noteTabGone(ids[0]);
  webviews.clear();
});

test("the other sweep never slips in between a sleep's answer and the tab being marked asleep", async (t) => {
  const { sleepTabsOverBudget, sleepUnusedTabs } = await import("./loadedTabBudget.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 4800 * 60 * minute;
  const { ids, active } = unusedWorld(1, now);
  let answer;
  const unusedAsks = [];
  webviews.clear();
  webviews.set(active, { sleepIfHidden: () => Promise.resolve([4]) });
  webviews.set(ids[0], { sleepIfHidden: () => new Promise((resolve) => (answer = resolve)), sleepIfUnused: () => (unusedAsks.push(1), Promise.resolve([])) });
  takeTabSleepCounts();
  const budgetSweep = sleepTabsOverBudget({ tabs: 1, hiddenMs: 30 * minute }, now);
  await new Promise((resolve) => setImmediate(resolve));
  answer([]);
  const unusedSweeps = [];
  for (let depth = 0; depth < 12; depth++) {
    unusedSweeps.push(sleepUnusedTabs(() => 60 * minute, consentToken(), now));
    await Promise.resolve();
  }
  await budgetSweep;
  await Promise.all(unusedSweeps);
  assert.deepEqual(unusedAsks, [], "at every step after the answer the tab is either still being asked or already asleep");
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_over_budget, 1);
  assert.equal(counts.tabs_slept_unused, 0);
  webviews.clear();
});

test("a sleep answer that comes after the tab was opened and loaded again leaves it awake and counts the reopen", async (t) => {
  const { sleepTabsOverBudget, noteShownTabs, noteTabGone } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  const { isSleeping } = await import("./sleepingTabs.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 5200 * 60 * minute;
  const { ids, active } = unusedWorld(1, now);
  let answer;
  const asked = [];
  webviews.clear();
  webviews.set(active, { sleepIfHidden: () => Promise.resolve([4]) });
  webviews.set(ids[0], { sleepIfHidden: () => (asked.push(1), asked.length === 1 ? new Promise((resolve) => (answer = resolve)) : Promise.resolve([])) });
  takeTabSleepCounts();
  const budget = { tabs: 1, hiddenMs: 30 * minute };
  noteShownTabs(new Set([active]), now);
  const sweep = sleepTabsOverBudget(budget, now);
  await new Promise((resolve) => setImmediate(resolve));
  lifecycle.noteDiscarded(ids[0]);
  noteShownTabs(new Set([ids[0]]), now);
  lifecycle.noteReady(ids[0]);
  noteShownTabs(new Set([active]), now);
  answer([]);
  assert.deepEqual(await sweep, [ids[0]]);
  assert.equal(isSleeping(ids[0]), false, "the late answer doesn't mark the awake tab asleep");
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_over_budget, 1);
  assert.equal(counts.tabs_slept_over_budget_reopened, 1, "the open in between is the reopen of that sleep");
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget(budget, now + minute)), [], "and it is kept as a reopened tab");
  assert.equal(asked.length, 1);
  noteTabGone(ids[0]);
  webviews.clear();
});

test("a sleep answer for a tab that closed while the ask was out leaves nothing behind for the tab that takes its id", async (t) => {
  const { sleepTabsOverBudget, noteShownTabs, noteTabGone } = await import("./loadedTabBudget.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
  const { isSleeping } = await import("./sleepingTabs.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now() + 5600 * 60 * minute;
  const { ids, active } = unusedWorld(1, now);
  let answer;
  const asked = [];
  webviews.clear();
  webviews.set(active, { sleepIfHidden: () => Promise.resolve([4]) });
  webviews.set(ids[0], { sleepIfHidden: () => (asked.push(1), asked.length === 1 ? new Promise((resolve) => (answer = resolve)) : Promise.resolve([])) });
  takeTabSleepCounts();
  const budget = { tabs: 1, hiddenMs: 30 * minute };
  noteShownTabs(new Set([active]), now);
  const sweep = sleepTabsOverBudget(budget, now);
  await new Promise((resolve) => setImmediate(resolve));
  noteTabGone(ids[0]);
  answer([]);
  assert.deepEqual(await sweep, [], "the old view's answer is dropped");
  assert.equal(isSleeping(ids[0]), false);
  noteShownTabs(new Set([active, ids[0]]), now + minute);
  noteShownTabs(new Set([active]), now + minute);
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_slept_over_budget, 0);
  assert.equal(counts.tabs_slept_over_budget_reopened, 0, "showing the replacement isn't a reopen");
  assert.equal(counts.sleep_kept_reopened_soon, 0);
  assert.deepEqual(await settleSweep(t, sleepTabsOverBudget({ tabs: 1, hiddenMs: 0 }, now + 40 * minute)), [ids[0]], "no reopen protection keeps the replacement from sleeping later");
  noteTabGone(ids[0]);
  webviews.clear();
});
