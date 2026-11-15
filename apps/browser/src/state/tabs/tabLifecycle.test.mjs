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
  assert.deepEqual(minutes(loadedTabBudget(on("balanced"), sys(64))), { tabs: 64, minutes: 60 });
  assert.deepEqual(minutes(loadedTabBudget(on("moderate"), sys(16))), { tabs: 32, minutes: 120 });
  assert.deepEqual(minutes(loadedTabBudget(on("maximum"), sys(16))), { tabs: 8, minutes: 30 });
  assert.deepEqual(minutes(loadedTabBudget(on("maximum"), sys(8))), { tabs: 5, minutes: 30 });
  assert.deepEqual(minutes(loadedTabBudget(on("balanced"), sys(32, "warning"))), { tabs: 10, minutes: 10 }, "under pressure the floor, and ten minutes hidden");
  assert.deepEqual(minutes(loadedTabBudget(on("moderate"), sys(32, "critical"))), { tabs: 20, minutes: 10 });
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
  const { sleepTabsOverBudget } = await import("./loadedTabBudget.ts");
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
  assert.deepEqual(asked.map(([id]) => id), [ids[5], ids[4], ids[1], ids[3]], "ten minutes later Chrome is asked again, the tab it had seen on screen as the most recent");
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget, 2);
  lifecycle.noteReady(ids[2]);
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget_reopened, 1, "a slept tab opened again within half an hour is counted: the sign the budget is too tight");
  lifecycle.noteReady(ids[2]);
  lifecycle.noteGone(ids[0]);
  assert.equal(takeTabSleepCounts().tabs_slept_over_budget_reopened, 0);
  webviews.clear();
});
