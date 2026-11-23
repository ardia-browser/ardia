import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { armLoadRecord, useHeroBarFocusWhenShownAgain, useNewTabKeptForPage, watchPageDrawn } = await import("./newTabKeep.ts");
const { registerHeroBar } = await import("../omnibox/barState.ts");
const { navigationOf } = await import("./pageSession.ts");
const seqOf = (tab) => navigationOf(S().tabs[tab])?.seq;

const S = () => useBrowser.getState();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function aTab() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  return S().windows[w].tabIds[0];
}

test("a kept New Tab page goes once its page has loaded, a moment after the load ends", async () => {
  const tab = aTab();
  const calls = [];
  watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 1000, 20);
  S().updateLive(tab, { isLoading: true });
  await wait(30);
  assert.deepEqual(calls, [], "nothing while the page loads");
  S().updateLive(tab, { isLoading: false });
  assert.deepEqual(calls, [], "not at the very moment the load ends");
  await wait(40);
  assert.deepEqual(calls, [false]);
});

test("a load that starts again before the pause ends keeps the page until that load ends too", async () => {
  const tab = aTab();
  const calls = [];
  watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 1000, 30);
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  await wait(10);
  S().updateLive(tab, { isLoading: true });
  await wait(50);
  assert.deepEqual(calls, []);
  S().updateLive(tab, { isLoading: false });
  await wait(50);
  assert.deepEqual(calls, [false]);
});

test("a page that never reports a load lets the New Tab page go at the deadline, once", async () => {
  const tab = aTab();
  const calls = [];
  watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 40, 10);
  S().updateLive(tab, { canGoBack: true });
  await wait(80);
  assert.deepEqual(calls, [true]);
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  await wait(30);
  assert.deepEqual(calls, [true], "nothing after it went");
});

test("a stopped watch never calls back", async () => {
  const tab = aTab();
  const calls = [];
  const stop = watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 30, 10);
  S().updateLive(tab, { isLoading: true });
  stop();
  S().updateLive(tab, { isLoading: false });
  await wait(60);
  assert.deepEqual(calls, []);
});

test("the New Tab page is kept only when its own tab goes on to a page, and shown again it is no longer kept", () => {
  const tab = aTab();
  const pane = mount(({ shown, page, app = false }) => useNewTabKeptForPage(tab, shown, page, app), { props: { shown: true, page: false } });
  assert.equal(pane.value, false);
  assert.equal(pane.rerender({ shown: false, page: true }), true, "Enter gave the tab an address");
  assert.equal(pane.rerender({ shown: true, page: false }), false, "back to the New Tab page");
  assert.equal(pane.rerender({ shown: false, page: false }), false, "switched to another tab: nothing to wait for");
  assert.equal(pane.rerender({ shown: true, page: false }), false);
  assert.equal(pane.rerender({ shown: false, page: true, app: true }), false, "straight to an app page: nothing loads, nothing is held");
  pane.unmount();
});

test("a kept New Tab page goes when its page's load ends", async () => {
  const tab = aTab();
  const pane = mount(({ shown, page, app = false }) => useNewTabKeptForPage(tab, shown, page, app), { props: { shown: true, page: false } });
  assert.equal(pane.rerender({ shown: false, page: true }), true);
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  await wait(250);
  assert.equal(pane.value, false);
  pane.unmount();
});

test("a hold ends at once when its tab goes on to an app page, and switching away keeps it", () => {
  const tab = aTab();
  const pane = mount(({ shown, page, app = false }) => useNewTabKeptForPage(tab, shown, page, app), { props: { shown: true, page: false } });
  assert.equal(pane.rerender({ shown: false, page: true }), true, "Enter on a web address");
  assert.equal(pane.rerender({ shown: false, page: false }), true, "switched to another tab while the page loads: still held");
  assert.equal(pane.rerender({ shown: false, page: true, app: true }), false, "the tab then opened an app page");
  pane.unmount();
});

test("a load that started and ended before the watch began lets the page go at once, not at the cap", async () => {
  const tab = aTab();
  const disarm = armLoadRecord(tab);
  S().navigate(tab, "https://b.com");
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  const calls = [];
  watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 1000, 20);
  await wait(60);
  assert.deepEqual(calls, [false]);
  disarm();
});

test("a load that ended for an earlier navigation doesn't end the watch for a newer one", async () => {
  const tab = aTab();
  const disarm = armLoadRecord(tab);
  S().navigate(tab, "https://b.com");
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  S().navigate(tab, "https://c.com");
  const calls = [];
  watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 120, 20);
  await wait(60);
  assert.deepEqual(calls, [], "nothing yet for c.com");
  await wait(120);
  assert.deepEqual(calls, [true]);
  disarm();
});

test("an earlier navigation's load ending after the watch began doesn't release a newer navigation's hold", async () => {
  const tab = aTab();
  const disarm = armLoadRecord(tab);
  S().navigate(tab, "https://a2.com");
  S().updateLive(tab, { isLoading: true });
  S().navigate(tab, "https://b.com");
  const calls = [];
  watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 1000, 20);
  S().updateLive(tab, { isLoading: false });
  await wait(60);
  assert.deepEqual(calls, [], "a2.com's load ending says nothing about b.com");
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  await wait(60);
  assert.deepEqual(calls, [false], "b.com's own start and end release it");
  disarm();
});

test("a New Tab page shown again after a hold refocuses its bar keeping the field's selection", () => {
  const tab = aTab();
  const w = S().tabs[tab].windowId;
  const modes = [];
  const unregister = registerHeroBar(w, tab, (mode) => modes.push(mode));
  const page = mount(({ kept }) => useHeroBarFocusWhenShownAgain(w, tab, kept), { props: { kept: false } });
  page.rerender({ kept: true });
  assert.deepEqual(modes, [], "nothing while it is held");
  page.rerender({ kept: false });
  assert.deepEqual(modes, ["restore"]);
  page.unmount();
  unregister();
});

test("an earlier navigation's start and end that arrive only after a newer one was issued are taken as the newer one's, so its hold ends early, never late", async () => {
  const tab = aTab();
  const disarm = armLoadRecord(tab);
  S().navigate(tab, "https://a3.com");
  S().navigate(tab, "https://b3.com");
  const calls = [];
  watchPageDrawn(tab, seqOf(tab), (timedOut) => calls.push(timedOut), 1000, 20);
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  await wait(60);
  assert.deepEqual(calls, [false], "load events carry no navigation identity: a3.com's late start and end release b3.com's hold, as main's teardown would");
  disarm();
});
