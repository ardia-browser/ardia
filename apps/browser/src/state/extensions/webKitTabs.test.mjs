import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeEvents } from "../../test-native/events.ts";

const sent = [];
globalThis.acTestNativeModules = {
  ...globalThis.acTestNativeModules,
  ArdiaWebKit: {
    call: (verb, _profile, json) => {
      sent.push({ verb, ...JSON.parse(json) });
      return Promise.resolve("null");
    },
    addListener: nativeEvents().addListener,
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { useExtensions } = await import("./store.ts");
const { answerWebKitTabs, webKitTabLayout } = await import("./webKitTabs.ts");

const S = () => useBrowser.getState();
const ask = (op, extra) => {
  sent.length = 0;
  answerWebKitTabs({ action: "webKit", request: `r-${op}`, profile: "", private: false, op, ...extra });
  return sent.find((x) => x.verb === "extensionTabsDone")?.reply;
};

function windowOf(urls) {
  S().hydrate({});
  useExtensions.setState({ lists: { "": [{ id: "abc", name: "Probe", enabled: true }] } });
  const w = S().createWindow({ url: urls[0] });
  for (const url of urls.slice(1)) S().newTab(w, { url, background: true });
  const tabs = S().windows[w].tabIds;
  for (const id of tabs) S().updateTab(id, { engine: "webkit" });
  return { w, tabs };
}

const order = (s, w) => webKitTabLayout(s).windows.find((x) => x.id === w);

test("the layout lists each window's tabs pinned first, with their openers and the focus order", () => {
  const { w, tabs } = windowOf(["https://a.test/", "https://b.test/", "https://c.test/"]);
  S().pinTabs([tabs[2]], true);
  S().updateTab(tabs[1], { openerId: tabs[0] });
  const layout = webKitTabLayout(S());
  const shown = order(S(), w);
  assert.equal(shown.tabs[0], tabs[2]);
  assert.deepEqual(shown.pinned, [tabs[2]]);
  assert.deepEqual([...shown.tabs].sort(), [...tabs].sort());
  assert.equal(layout.openers[tabs[1]], tabs[0]);
  assert.deepEqual(layout.focus, S().ui.focusOrder.filter((id) => S().windows[id]));
});

test("pinning through arrange pins the tab and puts it at the end of the pinned tabs, as Chrome's strip does", () => {
  const { w } = windowOf(["https://a.test/", "https://b.test/", "https://c.test/"]);
  const before = order(S(), w).tabs.map((key) => ({ key, pinned: false }));
  const moving = before[2].key;
  const after = [{ key: moving, pinned: true }, ...before.filter((t) => t.key !== moving)];
  assert.deepEqual(ask("arrange", { windowId: w, before, after }), {});
  assert.ok(S().tabs[moving].pin);
  assert.equal(order(S(), w).tabs[0], moving);
});

test("a reply goes out after the layout it changed, so the next WebKit read sees it", () => {
  const { w } = windowOf(["https://a.test/", "https://b.test/"]);
  const before = order(S(), w).tabs.map((key) => ({ key, pinned: false }));
  const after = [{ ...before[1], pinned: true }, before[0]];
  ask("arrange", { windowId: w, before, after });
  const verbs = sent.map((x) => x.verb);
  assert.ok(verbs.indexOf("extensionTabLayout") >= 0 && verbs.indexOf("extensionTabLayout") < verbs.indexOf("extensionTabsDone"), verbs.join(","));
  const layout = sent.find((x) => x.verb === "extensionTabLayout").layout;
  assert.deepEqual(layout.windows.find((x) => x.id === w).pinned, [before[1].key]);
});

test("create opens the adopted page before the tab it's asked to go in front of, in the background when it isn't active", () => {
  const { w } = windowOf(["https://a.test/", "https://b.test/"]);
  const keys = S().windows[w].tabIds;
  const active = S().windows[w].activeTabIds[S().windows[w].profileId];
  const reply = ask("create", { url: "https://new.test/", adoptId: "webkit:7", active: false, pinned: false, windowId: w, beforeId: keys[1], nearTabId: keys[0] });
  assert.equal(reply.windowId, w);
  assert.equal(S().windows[w].tabIds.indexOf(reply.tabId), 1);
  assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], active);
});

test("close, activate and duplicate act on the app's tabs, and an unknown tab is an error", () => {
  const { w, tabs } = windowOf(["https://a.test/", "https://b.test/"]);
  const profile = S().windows[w].profileId;
  const other = tabs.find((id) => S().windows[w].activeTabIds[profile] !== id);
  assert.deepEqual(ask("activate", { tabId: other }), {});
  assert.equal(S().windows[w].activeTabIds[profile], other);
  const copy = ask("duplicate", { tabId: other, active: true }).tabId;
  assert.equal(S().tabs[copy].url, S().tabs[other].url);
  assert.equal(S().windows[w].tabIds.indexOf(copy), S().windows[w].tabIds.indexOf(other) + 1);
  ask("close", { tabIds: [copy] });
  assert.equal(S().tabs[copy], undefined);
  assert.match(ask("activate", { tabId: "nope" }).error, /No tab with id: nope/);
});

test("the tab, window and popup counts the native side sends reach the hourly engine counts under their own names", async () => {
  const { noteWebKitCount, takeEngineSwitchCounts } = await import("../telemetry/engineSwitchCounts.ts");
  const client = await import("../telemetry/client.ts");
  client.loadChoice();
  client.setSharing(true, "settings");
  const consent = client.consentToken();
  takeEngineSwitchCounts();
  noteWebKitCount("extensionTabPin", consent);
  noteWebKitCount("extensionTabPin", consent);
  noteWebKitCount("extensionWindowCreate", consent);
  noteWebKitCount("extensionAction", consent);
  const counts = takeEngineSwitchCounts();
  client.setSharing(false, "settings");
  assert.equal(counts.webkit_extension_tab_pins, 2);
  assert.equal(counts.webkit_extension_window_creates, 1);
  assert.equal(counts.webkit_extension_popups, 0);
  assert.equal(takeEngineSwitchCounts().webkit_extension_tab_pins, 0);
});

test("an extension in a private window opens its tabs and windows in private windows, never a regular one", () => {
  const { w } = windowOf(["https://a.test/"]);
  const priv = S().createWindow({ kind: "private", url: "https://secret.test/" });
  const privAsk = (op, extra) => {
    sent.length = 0;
    answerWebKitTabs({ action: "webKit", request: `p-${op}`, profile: "", private: true, op, ...extra });
    return sent.find((x) => x.verb === "extensionTabsDone")?.reply;
  };
  const made = privAsk("create", { url: "https://next.test/", active: true, pinned: false });
  assert.equal(made.windowId, priv);
  const opened = privAsk("createWindow", { focused: true, tabIds: [], urls: ["https://other.test/"], adoptIds: [] });
  assert.notEqual(opened.windowId, w);
  assert.equal(S().windows[opened.windowId].kind, "private");
});
