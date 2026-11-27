import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { markTabReady, usePages } = await import("../tabs/pageState.ts");
const rows = await import("./launchRows.ts");

const S = () => useBrowser.getState();
const profiles = { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 }, work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 } };
const tab = (w, i, url = `https://example.com/${w}${i}`) => ({
  id: `${w}t${i}`, windowId: w, profileId: "default", url, title: `Tab ${i}`, favicon: null, pinned: false,
  muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, page: { kind: "idle" }, openerId: null, createdAt: i, lastActiveAt: i,
});

function hydrate({ urls = { a: undefined }, kinds = {} } = {}) {
  const ids = Object.keys(urls);
  const tabs = ids.flatMap((w) => [tab(w, 0, urls[w]), tab(w, 1), tab(w, 2)]);
  S().hydrate({
    profiles,
    profileOrder: ["default", "work"],
    windows: Object.fromEntries(ids.map((w) => [w, { id: w, profileId: "default", kind: kinds[w] ?? "main", tabIds: tabs.filter((t) => t.windowId === w).map((t) => t.id), activeTabIds: { default: `${w}t0` }, sidebarOpen: true, frame: [0, 0, 1200, 800], createdAt: 0 }])),
    windowOrder: ids,
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    groups: {},
  });
}

let clock = 0;
beforeEach(() => {
  rows.resetLaunchRowsForTests();
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  clock = Date.now();
  rows.resetLaunchRowsForTests(() => clock);
  usePages.setState({ ready: {} });
});

const advance = (ms) => {
  clock += ms;
  mock.timers.tick(ms);
};

test("rows grow freely until the first content is on screen; then only the restored windows hold", () => {
  hydrate({ urls: { a: undefined } });
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsStarted(), false);
  rows.startLaunchRows();
  assert.equal(rows.launchRowsStarted(), true);
  assert.equal(rows.launchRowsHolding("a"), true);
  assert.equal(rows.launchRowsHolding("later"), false, "a window opened during the hold doesn't join it");
});

test("rows past the first screen wait for the restored page's load, then all mount", () => {
  hydrate();
  rows.startLaunchRows();
  rows.noteLaunchRowsDeferred(180);
  advance(200);
  S().updateLive("at0", { isLoading: true });
  assert.equal(rows.launchRowsHolding("a"), true, "a page still loading keeps them out");
  advance(150);
  S().updateLive("at0", { isLoading: false });
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsSettled(), false, "settled only once the rows held out have all mounted");
  advance(300);
  rows.noteLaunchRowsMounted();
  assert.equal(rows.launchRowsSettled(), true);
  assert.deepEqual(rows.launchRowsReport(), { later: 180, ms: 650, release: "loaded" });
});

test("a page already loading when the hold starts is waited on, not left to the deadline", () => {
  hydrate();
  S().updateLive("at0", { isLoading: true });
  rows.startLaunchRows();
  S().updateLive("at0", { isLoading: false });
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsReport().release, "loaded");
});

test("a page still loading lets the rows in at the deadline", () => {
  hydrate();
  rows.startLaunchRows();
  rows.noteLaunchRowsDeferred(40);
  rows.noteLaunchRowsDeferred(60);
  S().updateLive("at0", { isLoading: true });
  advance(rows.HOLD_MS - 1);
  assert.equal(rows.launchRowsHolding("a"), true);
  advance(1);
  assert.equal(rows.launchRowsHolding("a"), false);
  rows.noteLaunchRowsMounted();
  assert.equal(rows.launchRowsSettled(), false, "one page is still growing");
  advance(50);
  rows.noteLaunchRowsMounted();
  assert.deepEqual(rows.launchRowsReport(), { later: 100, ms: rows.HOLD_MS + 50, release: "deadline" });
});

test("an internal page (History) or a blank tab waits only for the first frames, as its own reason", () => {
  hydrate({ urls: { a: "ardia://history" } });
  rows.startLaunchRows();
  advance(rows.HOLD_WITHOUT_PAGE_MS - 1);
  assert.equal(rows.launchRowsHolding("a"), true);
  advance(1);
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsReport().release, "nopage");
});

test("a scroll, drag or reveal in one window lets only that window's rows in", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  rows.releaseLaunchRows("a", "scroll");
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsHolding("b"), true);
  S().updateLive("at0", { isLoading: true });
  S().updateLive("at0", { isLoading: false });
  assert.equal(rows.launchRowsHolding("b"), true, "another window's page doesn't count");
  rows.releaseLaunchRows("b", "reveal");
  assert.equal(rows.launchRowsReport().release, "scroll", "the first reason is kept");
});

test("switching the window's profile lets its rows in at once", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  S().switchProfile("a", "work");
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsHolding("b"), true);
  assert.equal(rows.launchRowsReport().release, "profile");
});

test("small windows never hold", () => {
  hydrate({ urls: { a: undefined, s: undefined }, kinds: { s: "small" } });
  rows.startLaunchRows();
  assert.equal(rows.launchRowsHolding("s"), false);
});

test("a page whose rows never finish (its window closed) leaves no completion time", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  rows.noteLaunchRowsDeferred(50);
  rows.noteLaunchRowsDeferred(70);
  rows.releaseLaunchRows("a", "scroll");
  rows.releaseLaunchRows("b", "scroll");
  rows.noteLaunchRowsMounted();
  rows.noteLaunchRowsCancelled();
  assert.equal(rows.launchRowsSettled(), true);
  assert.deepEqual(rows.launchRowsReport(), { later: 120, ms: null, release: "scroll" });
});

test("a window closed during the hold leaves without a release reason", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  S().closeWindow("b");
  assert.equal(rows.launchRowsHolding("b"), false);
  assert.equal(rows.launchRowsReport().release, null);
});

test("a sidebar first shown long after launch never holds its rows", () => {
  hydrate();
  clock += rows.LATE_MS + 1000;
  rows.startLaunchRows();
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsReport().release, "late");
});

test("with no sidebar shown at launch nothing is waited on", () => {
  assert.equal(rows.launchRowsSettled(), true);
});

test("scrolling one window's sidebar lets only that window's rows in", async () => {
  const { noteRowsScrolled } = await import("./hover.ts");
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  noteRowsScrolled("b", "default", 0);
  assert.equal(rows.launchRowsHolding("a"), true);
  assert.equal(rows.launchRowsHolding("b"), false);
  assert.equal(rows.launchRowsReport().release, "scroll");
});

test("a restored tab whose view is attached but hasn't reported a load still holds, until its load or the deadline", () => {
  hydrate();
  markTabReady("at0");
  rows.startLaunchRows();
  assert.equal(rows.launchRowsHolding("a"), true);
  S().updateLive("at0", { isLoading: true });
  S().updateLive("at0", { isLoading: false });
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsReport().release, "loaded");
});

test("closing a window whose page is still loading isn't counted as that page loading", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  S().updateLive("bt0", { isLoading: true });
  S().closeWindow("b");
  assert.equal(rows.launchRowsHolding("b"), false);
  assert.equal(rows.launchRowsReport().release, null);
});

test("a restored window's list that mounts after the hold started still joins it; a new window or a released one doesn't", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  assert.equal(rows.joinsLaunchRows("a"), true, "before the first content every first list joins");
  rows.startLaunchRows();
  assert.equal(rows.joinsLaunchRows("b"), true);
  assert.equal(rows.joinsLaunchRows("new"), false);
  rows.releaseLaunchRows("b", "scroll");
  assert.equal(rows.joinsLaunchRows("b"), false);
});

test("closing the watched tab while its window stays open lets the rows in at once, with no reason, even with no live change", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  S().closeTab("at0");
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsHolding("b"), true);
  advance(rows.HOLD_MS);
  assert.equal(rows.launchRowsReport().release, "deadline", "only the other window waited for the deadline");
});

test("the watched tab moving to another window lets its old window's rows in, with no reason", () => {
  hydrate({ urls: { a: undefined, b: undefined } });
  rows.startLaunchRows();
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, at0: { ...s.tabs.at0, windowId: "b" } } }));
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsReport().release, null);
});

test("only the windows the session restored can hold, even one created before the hold starts", () => {
  hydrate({ urls: { a: undefined } });
  rows.noteRestoredWindows(S().windowOrder);
  const late = S().createWindow({ url: "https://late.example/" });
  rows.startLaunchRows();
  assert.equal(rows.launchRowsHolding("a"), true);
  assert.equal(rows.launchRowsHolding(late), false);
  assert.equal(rows.joinsLaunchRows(late), false);
});

test("a window whose selected pin is a frozen copy (its page is in another window) has no load to wait for: the no-page path", () => {
  S().hydrate({});
  const a = S().createWindow({ url: "https://mail.com" });
  const [mail] = S().windows[a].tabIds;
  S().pinTabs([mail], true);
  S().activate(mail);
  const b = S().createWindow({ url: "https://b.com" });
  const copy = S().windows[b].tabIds.find((id) => S().tabs[id].pinnedUrl === "https://mail.com");
  S().activate(copy);
  const frozenIn = S().tabs[mail].windowId === b ? a : b;
  const selected = S().windows[frozenIn].activeTabIds[S().windows[frozenIn].profileId];
  assert.equal(S().tabs[selected].page.kind, "frozen");
  rows.noteRestoredWindows(S().windowOrder);
  rows.startLaunchRows();
  advance(rows.HOLD_WITHOUT_PAGE_MS);
  assert.equal(rows.launchRowsHolding(frozenIn), false);
  assert.equal(rows.launchRowsReport().release, "nopage");
});

test("a new window with no restored session (an empty restored set) holds nothing", () => {
  hydrate({ urls: { a: undefined } });
  rows.noteRestoredWindows([]);
  rows.startLaunchRows();
  assert.equal(rows.launchRowsHolding("a"), false);
  assert.equal(rows.launchRowsSettled(), true);
});
