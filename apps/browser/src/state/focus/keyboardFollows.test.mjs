import assert from "node:assert/strict";
import { test } from "node:test";
const { followHandedBack, startKeyboardFollows } = await import("./keyboardFollows.ts");

const windowOf = (profileId, active) => ({ profileId, activeTabIds: { [profileId]: active } });

function fakeStore(windows, peeks = {}, tabs = {}) {
  let state = { windows, peeks, tabs };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    set(windows, peeks = state.peeks, tabs = state.tabs) {
      const prev = state;
      state = { windows, peeks, tabs };
      for (const listener of listeners) listener(state, prev);
    },
  };
}

test("the keyboard is asked to follow a window's shown tab only when that tab changes", () => {
  const followed = [];
  const store = fakeStore({ w1: windowOf("p", "a"), w2: windowOf("p", "x") });
  const stop = startKeyboardFollows((tabId) => followed.push(tabId), store);
  store.set({ w1: windowOf("p", "b"), w2: windowOf("p", "x") });
  store.set({ w1: windowOf("p", "b"), w2: windowOf("p", "x") });
  store.set({ w1: windowOf("q", "b"), w2: windowOf("p", "x") });
  store.set({ w1: windowOf("p", "b"), w2: windowOf("p", "x"), w3: windowOf("p", "n") });
  assert.deepEqual(followed, ["b", "n"], "a tab switch and a new window's tab; not an unchanged store, nor a profile switch landing on the same tab");
  stop();
});

test("on a platform without the follow call nothing subscribes", () => {
  const store = fakeStore({});
  let subscribed = false;
  store.subscribe = () => ((subscribed = true), () => {});
  startKeyboardFollows(null, store)();
  assert.equal(subscribed, false);
});

test("the keyboard is asked to follow a Peek's page when the user opens one, as the Mac's Peek focuses its page", () => {
  const followed = [];
  const windows = { w1: windowOf("p", "a") };
  const tabs = { a: { id: "a", url: "https://a.example/", windowId: "w1" }, peek1: { id: "peek1", url: "https://one.example/", windowId: "w1" }, peek2: { id: "peek2", url: "https://two.example/", windowId: "w1" } };
  const store = fakeStore(windows, {}, tabs);
  const stop = startKeyboardFollows((tabId) => followed.push(tabId), store);
  store.set(windows, { a: { tabId: "peek1", sourceId: "a" } });
  store.set(windows, { a: { tabId: "peek1", sourceId: "a" } });
  store.set(windows, {});
  store.set(windows, { a: { tabId: "peek2", sourceId: "a" } });
  assert.deepEqual(followed, ["peek1", "peek2"], "each new Peek once; closing it asks nothing here (the source page refocuses on close)");
  stop();
});

test("a Peek belongs to its tab: leaving the tab follows the next tab, and coming back follows the Peek again", () => {
  const followed = [];
  const tabs = { a: { id: "a", url: "https://a.example/", windowId: "w1" }, b: { id: "b", url: "https://b.example/", windowId: "w1" }, peek1: { id: "peek1", url: "https://one.example/", windowId: "w1" }, x: { id: "x", url: "https://x.example/", windowId: "w2" } };
  const peeks = { a: { tabId: "peek1", sourceId: "a" } };
  const store = fakeStore({ w1: windowOf("p", "a"), w2: windowOf("p", "x") }, peeks, tabs);
  const stop = startKeyboardFollows((tabId, windowId) => followed.push(`${tabId} in ${windowId}`), store);
  store.set({ w1: windowOf("p", "b"), w2: windowOf("p", "x") });
  assert.deepEqual(followed, ["b in w1"], "the Peek hidden with its tab asks for nothing");
  store.set({ w1: windowOf("p", "a"), w2: windowOf("p", "x") });
  assert.deepEqual(followed.slice(1), ["a in w1", "peek1 in w1"], "back on its tab, the Peek's page is asked last, so it keeps the keyboard");
  store.set({ w1: windowOf("p", "a"), w2: windowOf("p", "x") }, { a: { tabId: "peek1", sourceId: "a" }, x: { tabId: "peek1", sourceId: "x" } });
  assert.equal(followed.length, 3, "a Peek whose page is in another window is not that window's");
  stop();
});

test("a shown tab that gets its first page asks again, as Enter in a New Tab page's search box or the command bar over an empty tab does", () => {
  const followed = [];
  const windows = { w1: windowOf("p", "ntp") };
  const store = fakeStore(windows, {}, { ntp: { id: "ntp", url: "" } });
  const stop = startKeyboardFollows((tabId) => followed.push(tabId), store);
  store.set(windows, {}, { ntp: { id: "ntp", url: "", title: "New Tab" } });
  store.set(windows, {}, { ntp: { id: "ntp", url: "https://typed.example/" } });
  store.set(windows, {}, { ntp: { id: "ntp", url: "https://typed.example/next" } });
  assert.deepEqual(followed, ["ntp"], "once, when the empty tab takes its address; not for other tab changes, nor a later navigation");
  stop();
});

test("a snap key handed back from the app window follows the window's Peek when one shows, else its shown tab", () => {
  const followed = [];
  const follow = (tabId, windowId) => followed.push(`${tabId} in ${windowId}`);
  const tabs = { a: { id: "a", url: "https://a.example/", windowId: "w1" }, peek1: { id: "peek1", url: "https://one.example/", windowId: "w1" }, x: { id: "x", url: "https://x.example/", windowId: "w2" } };
  const store = fakeStore({ w1: windowOf("p", "a"), w2: windowOf("p", "x") }, { a: { tabId: "peek1", sourceId: "a" } }, tabs);
  followHandedBack("w1", follow, store);
  followHandedBack("w2", follow, store);
  followHandedBack("gone", follow, store);
  followHandedBack("w1", null, store);
  assert.deepEqual(followed, ["peek1 in w1", "x in w2"]);
});
