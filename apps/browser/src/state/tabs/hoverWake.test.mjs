import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { useLifecycle, noteSleptByHand, forgetSleptByHand } = await import("./sleepingTabs.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { HOVER_WAKE_KEPT_MS, HOVER_WAKE_MS, HOVER_WAKE_OPENED_WITHIN_MS, armHoverWake, cancelHoverWake, forgetHoverWakes, hoverWakeOf, noteHoverWakeOpened, putBackHoverWake, wakeOnHover } = await import("./hoverWake.ts");
afterEach(() => forgetHoverWakes());
setConsentPeriod(true, "hover-wake-test");

const S = () => useBrowser.getState();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const facts = (extra = {}) => ({
  exists: true,
  shown: false,
  memorySaver: true,
  discarded: false,
  sleptByHand: false,
  hasView: false,
  restoredLazily: false,
  webPage: true,
  chromium: true,
  privateProfile: false,
  held: false,
  pressure: "normal",
  batterySaver: false,
  ...extra,
});

test("only a hidden Chromium tab that slept on its own or was restored without its page wakes on hover", () => {
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true })), "discarded");
  assert.equal(hoverWakeOf(facts({ restoredLazily: true })), "unloaded");
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true, sleptByHand: true })), null, "a tab you put to sleep yourself stays asleep");
  assert.equal(hoverWakeOf(facts()), null, "a loaded tab, or a pinned tab you closed (asleep, not restored lazily), needs nothing");
  assert.equal(hoverWakeOf(facts({ restoredLazily: true, privateProfile: true })), null, "a private tab is never loaded speculatively");
  assert.equal(hoverWakeOf(facts({ restoredLazily: true, chromium: false })), null, "a WebKit tab, which no sweep can put back, is never loaded speculatively");
  assert.equal(hoverWakeOf(facts({ restoredLazily: true, memorySaver: false })), null, "nothing wakes speculatively with Memory Saver off");
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: false })), null, "nothing to wake without its page view");
  assert.equal(hoverWakeOf(facts({ restoredLazily: true, webPage: false })), null, "Ardia's own pages load instantly");
  assert.equal(hoverWakeOf(facts({ restoredLazily: true, held: true })), null, "a page another window holds stays there");
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true, shown: true })), null, "a shown tab wakes by itself");
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true, exists: false })), null);
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true, pressure: "warning" })), null);
  assert.equal(hoverWakeOf(facts({ restoredLazily: true, batterySaver: true })), null);
});

function windowWithHiddenTab() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://active.com/" });
  const hidden = S().newTab(w, { url: "https://hidden.com/", background: true });
  const active = Object.keys(S().tabs).find((id) => id !== hidden);
  useLifecycle.setState({ discarded: {}, memoryPressure: "normal", batterySaver: false });
  return { w, hidden, active };
}

function sleepingTab(wakeIfSleeping) {
  const world = windowWithHiddenTab();
  webviews.clear();
  const asked = [];
  webviews.set(world.hidden, { wakeIfSleeping: () => wakeIfSleeping(), sleepIfHidden: (seconds) => (asked.push(seconds), Promise.resolve([])) });
  useLifecycle.setState({ discarded: { [world.hidden]: true } });
  return { ...world, asked };
}

test("a pinned tab you closed and a tab you slept by hand never wake on hover", async () => {
  const { hidden } = windowWithHiddenTab();
  S().updateTab(hidden, { page: { kind: "asleep" } });
  assert.equal(await wakeOnHover(hidden, consentToken()), null);
  assert.equal(S().tabs[hidden].page.kind, "asleep");
  const woke = [];
  const slept = sleepingTab(async () => (woke.push(1), true));
  noteSleptByHand(slept.hidden);
  assert.equal(await wakeOnHover(slept.hidden, consentToken()), null);
  assert.deepEqual(woke, []);
  forgetSleptByHand(slept.hidden);
  webviews.clear();
});

test("a WebKit tab restored without its page is never given one on hover", async () => {
  const { hidden } = windowWithHiddenTab();
  S().updateSettings({ engineMode: "webkit", pageEngine: "webkit" });
  S().updateTab(hidden, { page: { kind: "idle" } });
  assert.equal(await wakeOnHover(hidden, consentToken()), null);
  assert.equal(S().tabs[hidden].page.kind, "idle");
  S().updateSettings({ engineMode: "automatic", pageEngine: "chromium" });
});

test("a hover wake is counted once with its open, and an open after ten seconds isn't the hover's doing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hidden } = sleepingTab(async () => true);
  takeTabSleepCounts();
  const now = 1_000_000;
  assert.equal(await wakeOnHover(hidden, consentToken(), now), "discarded");
  assert.equal(noteHoverWakeOpened(hidden, now + HOVER_WAKE_OPENED_WITHIN_MS), true);
  assert.equal(noteHoverWakeOpened(hidden, now + HOVER_WAKE_OPENED_WITHIN_MS), false, "counted once");
  useLifecycle.setState({ discarded: { [hidden]: true } });
  await wakeOnHover(hidden, consentToken(), now);
  assert.equal(noteHoverWakeOpened(hidden, now + HOVER_WAKE_OPENED_WITHIN_MS + 1), false);
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_woken_on_hover, 2);
  assert.equal(counts.hover_woken_tabs_opened, 1);
  webviews.clear();
});

test("a click that lands while the engine is still waking the tab pairs with that wake, and a wake the engine didn't do counts neither", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const { hidden } = sleepingTab(() => new Promise((resolve) => (finish = resolve)));
  takeTabSleepCounts();
  const waking = wakeOnHover(hidden, consentToken(), 1_000_000);
  assert.equal(noteHoverWakeOpened(hidden, 1_000_050), true, "the click is held for the wake");
  finish(true);
  assert.equal(await waking, "discarded");
  let counts = takeTabSleepCounts();
  assert.equal(counts.tabs_woken_on_hover, 1);
  assert.equal(counts.hover_woken_tabs_opened, 1);
  useLifecycle.setState({ discarded: { [hidden]: true } });
  const refused = wakeOnHover(hidden, consentToken(), 2_000_000);
  noteHoverWakeOpened(hidden, 2_000_050);
  finish(false);
  assert.equal(await refused, null);
  counts = takeTabSleepCounts();
  assert.equal(counts.tabs_woken_on_hover, 0);
  assert.equal(counts.hover_woken_tabs_opened, 0);
  webviews.clear();
});

test("a wake counted while sharing was off isn't paired with an open counted after it turned on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hidden } = sleepingTab(async () => true);
  setConsentPeriod(false, "hover-wake-off");
  const offConsent = consentToken();
  takeTabSleepCounts();
  await wakeOnHover(hidden, offConsent, 1_000_000);
  setConsentPeriod(true, "hover-wake-on");
  noteHoverWakeOpened(hidden, 1_000_100);
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_woken_on_hover, 0);
  assert.equal(counts.hover_woken_tabs_opened, 0);
  webviews.clear();
});

test("a speculative wake nobody opened is put back after two minutes, only when the engine confirms it slept", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hidden, asked } = sleepingTab(async () => true);
  takeTabSleepCounts();
  await wakeOnHover(hidden, consentToken(), 1_000_000);
  useLifecycle.setState({ discarded: {} });
  t.mock.timers.tick(HOVER_WAKE_KEPT_MS - 1);
  assert.deepEqual(asked, []);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(asked, [0], "the engine is asked to sleep it again, with every protection it applies");
  assert.equal(useLifecycle.getState().discarded[hidden], true);
  assert.equal(takeTabSleepCounts().hover_wakes_put_back, 1);
  const opened = windowWithHiddenTab();
  S().updateTab(opened.hidden, { page: { kind: "idle" } });
  await wakeOnHover(opened.hidden, consentToken());
  noteHoverWakeOpened(opened.hidden);
  t.mock.timers.tick(HOVER_WAKE_KEPT_MS);
  assert.equal(S().tabs[opened.hidden].page.kind, "loaded", "an opened tab is left alone");
  webviews.clear();
});

test("a put-back the engine refuses, or one the page is busy for, isn't counted and never unloads the page itself", async () => {
  const { hidden } = windowWithHiddenTab();
  const consent = consentToken();
  takeTabSleepCounts();
  S().updateTab(hidden, { page: { kind: "idle" } });
  await wakeOnHover(hidden, consent);
  assert.equal(S().tabs[hidden].page.kind, "loaded");
  assert.equal(await putBackHoverWake(hidden, { consent }), false, "no page view: nothing to ask");
  const asked = [];
  webviews.set(hidden, { sleepIfHidden: (seconds) => (asked.push(seconds), Promise.resolve([102])) });
  assert.equal(await putBackHoverWake(hidden, { consent }), false, "a running download keeps it");
  webviews.set(hidden, { sleepIfHidden: () => Promise.reject(new Error("gone")) });
  assert.equal(await putBackHoverWake(hidden, { consent }), false);
  webviews.set(hidden, { sleepIfHidden: (seconds) => (asked.push(seconds), Promise.resolve([])) });
  S().updateLive(hidden, { playingAudio: true });
  assert.equal(await putBackHoverWake(hidden, { consent }), false, "playing: the engine isn't even asked");
  S().updateLive(hidden, { playingAudio: false });
  const { holdForCli, releaseAllCliHolds } = await import("./cliHolds.ts");
  holdForCli("hover-test", [hidden]);
  assert.equal(await putBackHoverWake(hidden, { consent }), false, "held by an ardia command session");
  releaseAllCliHolds();
  assert.deepEqual(asked, [0]);
  assert.equal(S().tabs[hidden].page.kind, "loaded", "the page is never torn down by the app");
  assert.equal(takeTabSleepCounts().hover_wakes_put_back, 0);
  assert.equal(await putBackHoverWake(hidden, { consent }), true);
  assert.equal(takeTabSleepCounts().hover_wakes_put_back, 1);
  useLifecycle.setState({ discarded: {} });
  webviews.clear();
});

test("an open during a wake still on its way counts only within ten seconds of the hover", async () => {
  let finish;
  const { hidden } = sleepingTab(() => new Promise((resolve) => (finish = resolve)));
  takeTabSleepCounts();
  const waking = wakeOnHover(hidden, consentToken(), 1_000_000);
  noteHoverWakeOpened(hidden, 1_000_000 + HOVER_WAKE_OPENED_WITHIN_MS + 1);
  finish(true);
  await waking;
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_woken_on_hover, 1);
  assert.equal(counts.hover_woken_tabs_opened, 0);
  webviews.clear();
});

test("the wake waits for the pointer to rest, and leaving or moving on first cancels it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const woke = [];
  const { hidden } = sleepingTab(async () => (woke.push(1), true));
  armHoverWake(hidden);
  t.mock.timers.tick(HOVER_WAKE_MS - 1);
  cancelHoverWake("other");
  cancelHoverWake(hidden);
  t.mock.timers.tick(HOVER_WAKE_MS);
  await settle();
  assert.deepEqual(woke, [], "passing over a row wakes nothing");
  armHoverWake(hidden);
  armHoverWake(hidden);
  t.mock.timers.tick(HOVER_WAKE_MS);
  await settle();
  assert.deepEqual(woke, [1], "resting on it wakes it once");
  t.mock.timers.tick(HOVER_WAKE_KEPT_MS);
  webviews.clear();
});

test("a hover-woken tab shown in a split pane it doesn't focus counts as opened and isn't put back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hidden, active, asked } = sleepingTab(async () => true);
  takeTabSleepCounts();
  await wakeOnHover(hidden, consentToken());
  S().createSplit([active, hidden]);
  assert.equal(takeTabSleepCounts().hover_woken_tabs_opened, 1);
  t.mock.timers.tick(HOVER_WAKE_KEPT_MS);
  await settle();
  assert.deepEqual(asked, [], "no put-back for a tab on screen");
  webviews.clear();
});

test("a put-back answer that comes after the tab loaded again leaves it awake", async () => {
  const { hidden } = windowWithHiddenTab();
  const consent = consentToken();
  S().updateTab(hidden, { page: { kind: "idle" } });
  await wakeOnHover(hidden, consent);
  let answer;
  webviews.set(hidden, { sleepIfHidden: () => new Promise((resolve) => (answer = resolve)) });
  takeTabSleepCounts();
  const putting = putBackHoverWake(hidden, { consent });
  await settle();
  useLifecycle.setState({ discarded: { [hidden]: true } });
  const { noteTabReady } = await import("./sleepAsks.ts");
  noteTabReady(hidden);
  useLifecycle.setState({ discarded: {} });
  answer([]);
  assert.equal(await putting, true, "the engine did put it back");
  assert.equal(useLifecycle.getState().discarded[hidden], undefined, "but the page running again isn't marked asleep");
  assert.equal(takeTabSleepCounts().hover_wakes_put_back, 1);
  webviews.clear();
});

test("a second hover while the first wake is still on its way keeps the first wake and its put-back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let wakes = 0;
  const { hidden, asked } = sleepingTab(() => (wakes++, new Promise((resolve) => (finish = resolve))));
  takeTabSleepCounts();
  const first = wakeOnHover(hidden, consentToken(), 1_000_000);
  assert.equal(await wakeOnHover(hidden, consentToken(), 1_000_050), null, "no second wake");
  assert.equal(wakes, 1);
  finish(true);
  assert.equal(await first, "discarded");
  useLifecycle.setState({ discarded: {} });
  t.mock.timers.tick(HOVER_WAKE_KEPT_MS);
  await settle();
  assert.deepEqual(asked, [0], "the first wake's put-back still runs");
  assert.equal(takeTabSleepCounts().tabs_woken_on_hover, 1);
  webviews.clear();
});
