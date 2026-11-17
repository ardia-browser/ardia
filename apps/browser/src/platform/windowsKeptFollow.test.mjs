import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DeviceEventEmitter, turboModules } from "../test-native/reactNative.ts";

const calls = [];
const opening = new Map();
turboModules.ArdiaEngineHost = {
  available: () => true,
  hostCall: async (verb, argsJson, windowId) => {
    const args = JSON.parse(argsJson);
    calls.push({ verb, args, windowId });
    if (verb === "tab.create" && opening.has(args.key)) await opening.get(args.key).promise;
    return JSON.stringify(verb === "tab.create" ? { tab: calls.length } : { ok: true });
  },
  engineCall: async () => "{}",
};

const { mountPage, showPage, followPage } = await import("../../../../packages/expo-windows/src/engine/pages.ts");
const { takeKeptFollows } = await import("../../../../packages/expo-windows/src/engine/keptFollow.ts");
const { noteFieldAsked, readFocusedFieldWith } = await import("../../../../packages/expo-windows/src/appKeyboard.ts");
const { startKeyboardFollows } = await import("../state/focus/keyboardFollows.ts");

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const shape = { x: 0, y: 0, width: 200, height: 100, radius: 0, holes: [] };
const followed = (key) => calls.filter((call) => call.verb === "tab.call" && call.args.key === key && call.args.method === "focus").map((call) => call.args);
const FOLLOWED = [{ follow: true, key: "", method: "focus", deferred: true }];
const followedOnce = (key) => [{ ...FOLLOWED[0], key }];
const emitTopic = (topic, payload) => DeviceEventEmitter.emit("ArdiaEngineHost:event", { topic, json: JSON.stringify(payload) });
let focused = null;
readFocusedFieldWith(() => focused);
const mounted = [];
const mount = (key, windowId = "w") => mounted.push(mountPage(key, { url: `https://${key}.example/`, windowId }, () => {}));
const unmountAll = async () => {
  for (const unmount of mounted.splice(0)) unmount();
  focused = null;
  await settle();
  takeKeptFollows();
};
const realNow = Date.now;
let later = 0;
Date.now = () => realNow() + later;
const slowOpen = (key) => {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  opening.set(key, { promise });
  return () => release();
};

test("the issue's case: a follow asked before its tab's page exists goes once that page mounts and shows", async () => {
  followPage("kf-woken");
  await settle();
  assert.deepEqual(followed("kf-woken"), [], "no page yet");
  mount("kf-woken");
  await settle();
  assert.deepEqual(followed("kf-woken"), [], "mounted but not shown");
  showPage("kf-woken", true, shape);
  await settle();
  assert.deepEqual(followed("kf-woken"), followedOnce("kf-woken"));
  await unmountAll();
});

test("the case seen on Windows: the ask outlasts a page that takes longer than the show wait to open, as a new tab with an address does", async () => {
  const opened = slowOpen("kf-slow");
  followPage("kf-slow");
  mount("kf-slow");
  showPage("kf-slow", true, shape);
  await settle();
  later += 5000;
  opened();
  await settle();
  assert.deepEqual(followed("kf-slow"), followedOnce("kf-slow"), "the page opened 5 s after it mounted and still gets the keyboard");
  later = 0;
  await unmountAll();
});

test("dropped when the user goes on to another tab, with or without a page", async () => {
  followPage("kf-left");
  followPage("kf-next");
  mount("kf-left");
  showPage("kf-left", true, shape);
  await settle();
  assert.deepEqual(followed("kf-left"), [], "another tab without a page was switched to");

  mount("kf-shown");
  await settle();
  showPage("kf-shown", true, shape);
  await settle();
  followPage("kf-later");
  followPage("kf-shown");
  mount("kf-later");
  showPage("kf-later", true, shape);
  await settle();
  assert.deepEqual(followed("kf-later"), [], "another tab with a page was switched to");
  await unmountAll();
});

test("dropped when the user presses another page", async () => {
  mount("kf-pressed");
  await settle();
  showPage("kf-pressed", true, shape);
  await settle();
  followPage("kf-unpressed");
  emitTopic("tab", { key: "kf-pressed", name: "pagePress", data: {} });
  mount("kf-unpressed");
  showPage("kf-unpressed", true, shape);
  await settle();
  assert.deepEqual(followed("kf-unpressed"), []);
  await unmountAll();
});

test("dropped when a text field of the app takes the keyboard, even after it lets go again", async () => {
  followPage("kf-field");
  focused = { field: { id: "address" }, windowId: "w" };
  noteFieldAsked("w");
  focused = null;
  mount("kf-field");
  showPage("kf-field", true, shape);
  await settle();
  assert.deepEqual(followed("kf-field"), [], "the address field took the keyboard after the switch");
  await unmountAll();
});

test("a field in another tab's content area of the same window doesn't drop it: an empty split pane's search field stays mounted", async () => {
  const splitSearch = { field: { id: "split-search" }, windowId: "w", contentAreaOf: "kf-empty-pane" };
  focused = splitSearch;
  followPage("kf-other-pane");
  noteFieldAsked("w");
  mount("kf-other-pane");
  showPage("kf-other-pane", true, shape);
  await settle();
  assert.deepEqual(followed("kf-other-pane"), followedOnce("kf-other-pane"), "the pane's search field still reads as focused, and the page gets the keyboard");
  await unmountAll();
});

test("the New Tab page search box of the tab being left doesn't drop it, asked again or still focused when the page shows", async () => {
  followPage("kf-from-ntp");
  focused = { field: { id: "hero" }, windowId: "w", contentAreaOf: "kf-left-ntp" };
  noteFieldAsked("w");
  mount("kf-from-ntp");
  showPage("kf-from-ntp", true, shape);
  await settle();
  assert.deepEqual(followed("kf-from-ntp"), followedOnce("kf-from-ntp"));
  await unmountAll();
});

test("a field in the showing page's own content area, or the window's own chrome, still keeps the keyboard, as fieldFocusedIn decided before", async () => {
  followPage("kf-own-area");
  focused = { field: { id: "own-hero" }, windowId: "w", contentAreaOf: "kf-own-area" };
  mount("kf-own-area");
  showPage("kf-own-area", true, shape);
  await settle();
  assert.deepEqual(followed("kf-own-area"), [], "its own content area's field");
  followPage("kf-chrome");
  focused = { field: { id: "sidebar-address" }, windowId: "w" };
  mount("kf-chrome");
  showPage("kf-chrome", true, shape);
  await settle();
  assert.deepEqual(followed("kf-chrome"), [], "the window's address field");
  await unmountAll();
});

function ctrlT() {
  let state = { windows: { w: { profileId: "p", activeTabIds: { p: "kf-before" } } }, peeks: {}, tabs: { "kf-before": { url: "https://before.example/" } } };
  const listeners = new Set();
  const store = {
    getState: () => state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    set(patch) {
      const prev = state;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, prev);
    },
  };
  const stop = startKeyboardFollows(followPage, store);
  const shows = (tabId, url) => ({ windows: { w: { profileId: "p", activeTabIds: { p: tabId } } }, tabs: { ...state.tabs, [tabId]: { url } } });
  return { store, stop, shows };
}

test("Ctrl+T with a New Tab page, an address in its search box, Enter: the box takes the keyboard, then the page gets it when it shows", async () => {
  const { store, stop, shows } = ctrlT();
  store.set(shows("kf-ntp", ""));
  const hero = { field: { id: "ntp-hero" }, windowId: "w", contentAreaOf: "kf-ntp" };
  focused = hero;
  noteFieldAsked("w");
  store.set(shows("kf-ntp", "https://typed.example/"));
  focused = null;
  mount("kf-ntp");
  showPage("kf-ntp", true, shape);
  await settle();
  assert.deepEqual(followed("kf-ntp"), followedOnce("kf-ntp"), "Enter navigates the same tab, which asks again; the New Tab page and its box unmount in that render, so no field reads as focused at the show");
  stop();
  await unmountAll();
});

test("Ctrl+T with the command bar, an address, Enter: the bar's field is focused when the new tab is shown, gone when its page shows", async () => {
  const { store, stop, shows } = ctrlT();
  focused = { field: { id: "command-bar" }, windowId: "w" };
  store.set(shows("kf-bar-tab", "https://typed.example/"));
  focused = null;
  mount("kf-bar-tab");
  showPage("kf-bar-tab", true, shape);
  await settle();
  assert.deepEqual(followed("kf-bar-tab"), followedOnce("kf-bar-tab"), "the closing bar's field doesn't drop the ask; it only blocks while it still holds the keyboard");
  stop();
  await unmountAll();
});

test("prewarm: Enter in a New Tab page whose hidden page already exists keeps the ask through a slow open, as the page is being opened", async () => {
  const opened = slowOpen("kf-prewarmed");
  const { store, stop, shows } = ctrlT();
  store.set(shows("kf-prewarmed", ""));
  mount("kf-prewarmed");
  showPage("kf-prewarmed", false, null);
  await settle();
  store.set(shows("kf-prewarmed", "https://typed.example/"));
  showPage("kf-prewarmed", true, shape);
  await settle();
  assert.deepEqual(followed("kf-prewarmed"), [], "nothing before the page has opened");
  later += 5000;
  opened();
  await settle();
  assert.deepEqual(followed("kf-prewarmed"), followedOnce("kf-prewarmed"), "the page opened 5 s after Enter and still gets the keyboard");
  later = 0;
  stop();
  await unmountAll();
});

test("switching to a loaded tab whose page is hidden keeps the ask until it shows, however late", async () => {
  mount("kf-loaded");
  await settle();
  showPage("kf-loaded", true, shape);
  await settle();
  showPage("kf-loaded", false, null);
  await settle();
  followPage("kf-loaded", "w");
  later += 5000;
  await settle();
  showPage("kf-loaded", true, { ...shape, width: 230 });
  await settle();
  assert.deepEqual(followed("kf-loaded"), followedOnce("kf-loaded"), "shown 5 s after the switch");
  later = 0;
  await unmountAll();
});

test("Split View: focusing a pane whose page is already showing in that window gets the call at once, not a kept ask", async () => {
  mount("kf-pane-a");
  mount("kf-pane-b");
  await settle();
  showPage("kf-pane-a", true, shape);
  showPage("kf-pane-b", true, { ...shape, x: 200 });
  await settle();
  takeKeptFollows();
  followPage("kf-pane-b", "w");
  await settle();
  assert.deepEqual(followed("kf-pane-b"), [{ key: "kf-pane-b", method: "focus", follow: true }], "sent at once, not deferred to a show");
  assert.deepEqual(takeKeptFollows(), { kept: 0, used: 0, dropped: 0 }, "nothing was kept");
  await unmountAll();
});

test("Peek: opening one asks its page, kept until the Peek's page shows", async () => {
  const { store, stop } = ctrlT();
  store.set({ peeks: { "kf-before": { tabId: "kf-peek", sourceId: "kf-before" } }, tabs: { ...store.getState().tabs, "kf-peek": { url: "https://peeked.example/", windowId: "w" } } });
  mount("kf-peek");
  later += 5000;
  showPage("kf-peek", true, shape);
  await settle();
  assert.deepEqual(followed("kf-peek"), followedOnce("kf-peek"));
  later = 0;
  stop();
  await unmountAll();
});

test("a pop-up that opens focused follows its page through the same rule: kept until its page shows in the pop-up window", async () => {
  const popupWindow = "popup:kf";
  mount("kf-popup-page", popupWindow);
  await settle();
  followPage("kf-popup-page", popupWindow);
  later += 5000;
  showPage("kf-popup-page", true, shape);
  await settle();
  assert.deepEqual(followed("kf-popup-page"), followedOnce("kf-popup-page"));
  later = 0;
  const popup = readFileSync(new URL("../../../../packages/expo-windows/src/engine/PopupWindow.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(popup, /return void \(popup\.focused \? followPage\(pageKey, windowId\) : undefined\);/, "the pop-up asks through followPage, not a timed focus call");
  await unmountAll();
});

test("a tab moved to another window: its page still showing in the old window doesn't count, and the ask waits for the show in the new one", async () => {
  mount("kf-moved", "w1");
  await settle();
  showPage("kf-moved", true, shape);
  await settle();
  followPage("kf-moved", "w2");
  await settle();
  assert.deepEqual(followed("kf-moved"), [], "not sent to the page while it still shows in w1");
  mount("kf-moved", "w2");
  await settle();
  showPage("kf-moved", true, { ...shape, width: 240 });
  await settle();
  assert.deepEqual(followed("kf-moved"), followedOnce("kf-moved"), "given once it shows in w2");
  await unmountAll();
});

test("no follow waits on the show timer: followPage either calls a page showing in that window, or keeps the ask", () => {
  const pages = readFileSync(new URL("../../../../packages/expo-windows/src/engine/pages.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(pages, /if \(page && !page\.closed && page\.show\?\.visible && page\.show === page\.showSent && \(!windowId \|\| page\.windowId === windowId\)\) return void callPage\(key, "focus", \{ follow: true \}\);\n  keepFollow\(key\);/);
  assert.match(pages, /function followNow\(page: Page\) \{\n  lastAskedToFocus = page;\n  page\.focusArgs = \{ follow: true \};\n\}/, "a spent kept ask sets no show-wait time");
  const follows = readFileSync(new URL("../state/focus/keyboardFollows.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(follows, /follow\(shown, windowId\)/);
  assert.match(follows, /follow\(peek, windowId\)/);
});

test("never pulls the keyboard out of a field in another window, such as Settings, when the page shows", async () => {
  followPage("kf-settings");
  mount("kf-settings");
  focused = { field: { id: "settings-search" }, windowId: "settings" };
  showPage("kf-settings", true, shape);
  await settle();
  assert.deepEqual(followed("kf-settings"), [], "a Settings field has the keyboard");
  focused = null;
  showPage("kf-settings", false, null);
  showPage("kf-settings", true, { ...shape, width: 210 });
  await settle();
  assert.deepEqual(followed("kf-settings"), [], "and the dropped ask doesn't come back on the next show");
  await unmountAll();
});

test("a kept ask is used once", async () => {
  followPage("kf-once");
  mount("kf-once");
  showPage("kf-once", true, shape);
  await settle();
  showPage("kf-once", false, null);
  showPage("kf-once", true, { ...shape, width: 220 });
  await settle();
  assert.deepEqual(followed("kf-once"), followedOnce("kf-once"));
  await unmountAll();
});

test("each kept ask is counted once as kept, then as used or dropped", async () => {
  takeKeptFollows();
  followPage("kf-count-a");
  followPage("kf-count-a");
  mount("kf-count-a");
  showPage("kf-count-a", true, shape);
  await settle();
  followPage("kf-count-b");
  followPage("kf-count-c");
  focused = { field: { id: "settings-search" }, windowId: "settings" };
  mount("kf-count-c");
  showPage("kf-count-c", true, shape);
  await settle();
  assert.deepEqual(takeKeptFollows(), { kept: 3, used: 1, dropped: 2 });
  assert.deepEqual(takeKeptFollows(), { kept: 0, used: 0, dropped: 0 }, "taking them starts the next hour from zero");
  await unmountAll();
});

test("the counts reach the hourly usage event, and What's Sent names them", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(source("../../../../packages/expo-windows/src/engine/modules.ts"), /takeKeptFollows: \(\) => takeKeptFollows\(\),/);
  assert.match(source("../state/telemetry/keyboardFollowCounts.ts"), /keyboard_follows_kept: kept, keyboard_follows_used: used, keyboard_follows_dropped: dropped/);
  assert.match(source("../state/telemetry/hourlyExtras.ts"), /\.\.\.takeKeyboardFollowCounts\(\)/);
  assert.match(source("../state/telemetry/copy.ts"), /On Windows, how many times a tab you switched to had no page yet/);
});
