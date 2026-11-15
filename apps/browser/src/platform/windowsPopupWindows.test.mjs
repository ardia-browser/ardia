import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceEventEmitter, turboModules } from "../test-native/reactNative.ts";

const calls = [];
const opened = [];
const closed = [];
const closeRequests = [];
const openIds = new Set();
let refuseWindows = false;
let closeWhileOpening = false;
const shownPages = new Set(["opener-page"]);

turboModules.ArdiaEngineHost = {
  available: () => true,
  hostCall: async (verb, argsJson, windowId) => {
    calls.push({ verb, args: JSON.parse(argsJson), windowId });
    if (verb === "tabs.list") return JSON.stringify({ tabs: [...shownPages].map((key) => ({ key, shown: true, windowVisible: true })) });
    return JSON.stringify(verb === "tab.create" ? { tab: calls.length } : { ok: true });
  },
  engineCall: async () => "{}",
};

turboModules.ArdiaAppWindows = {
  openWindow: async (id, options) => {
    opened.push({ id, options });
    if (!refuseWindows) openIds.add(id);
    if (closeWhileOpening) {
      openIds.delete(id);
      DeviceEventEmitter.emit("ArdiaAppWindows:onWindowEvent", { type: "close", id });
    }
  },
  closeWindow: async (id) => {
    closed.push(id);
    openIds.delete(id);
    DeviceEventEmitter.emit("ArdiaAppWindows:onWindowEvent", { type: "close", id });
  },
  windowFrame: async (id) => (id === "main" ? [100, 50, 1200, 800] : null),
  windowIds: async () => [...openIds],
  requestClose: async (id) => void closeRequests.push(id),
  setWindowTitle: async () => {},
};

const { mountPage } = await import("../../../../packages/expo-windows/src/engine/pages.ts");
const { popupWindowInfo, isPopupWindowId } = await import("../../../../packages/expo-windows/src/engine/popupWindows.ts");
const { privateWindowShown, releaseProfile } = await import("../../../../packages/expo-windows/src/engine/privateWindows.ts");
const { hostCall } = await import("../../../../packages/expo-windows/src/engine/host.ts");

const emitTopic = (topic, payload) => DeviceEventEmitter.emit("ArdiaEngineHost:event", { topic, json: JSON.stringify(payload) });
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const popupOpened = (adopt, popup, opener = "opener-page") =>
  emitTopic("tab.opened", { adopt, url: "https://auth.example/login", foreground: true, window: true, opener, profile: "p-work", parent: "", fromClick: false, popup });

test("a page's window.open with features opens a pop-up window placed on its opener, and no tab", async () => {
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  popupOpened("ardiacore:1", { width: 400, height: 300 });
  await settle();
  assert.equal(events.filter(([name]) => name === "openWindow").length, 0, "the pop-up never reaches the browser window as a tab");
  const made = opened.at(-1);
  assert.ok(isPopupWindowId(made.id), `the window id ${made.id} is a pop-up id`);
  assert.equal(made.options.kind, "popup");
  assert.deepEqual(made.options.frame, [500, 110, 400, 360]);
  const info = popupWindowInfo(made.id);
  assert.equal(info.adopt, "ardiacore:1");
  assert.equal(info.profile, "p-work");
  assert.equal(info.openerKey, "opener-page");
  assert.equal(info.pageKey, `${made.id}:page`);
  unmount();
});

test("closing a pop-up window closes its tab, and one never mounted gives its offered tab back", async () => {
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, () => {});
  await settle();
  popupOpened("ardiacore:2", {});
  await settle();
  const made = opened.at(-1);
  assert.equal(made.options.frame.join(","), "450,110,500,660");
  const info = popupWindowInfo(made.id);
  const closeShown = mountPage(info.pageKey, { url: "", profile: info.profile, adopt: info.adopt, windowId: made.id }, () => {});
  await settle();
  assert.ok(calls.some((call) => call.verb === "tab.create" && call.args.adopt === "ardiacore:2" && call.windowId === made.id), "the pop-up adopts the engine's tab in its own window");
  turboModules.ArdiaAppWindows.closeWindow(made.id);
  await settle();
  assert.ok(calls.some((call) => call.verb === "tab.close" && call.args.key === info.pageKey), "the tab closes with its window");
  assert.equal(popupWindowInfo(made.id), null);
  closeShown();

  popupOpened("ardiacore:3", {});
  await settle();
  turboModules.ArdiaAppWindows.closeWindow(opened.at(-1).id);
  await settle();
  assert.ok(calls.some((call) => call.verb === "tab.discard" && call.args.adopt === "ardiacore:3"), "an offered tab nobody adopted is discarded");
  unmount();
});

test("a pop-up whose window cannot open goes to its opener as a foreground tab", async () => {
  const warn = console.warn;
  console.warn = () => {};
  refuseWindows = true;
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  popupOpened("ardiacore:4", { x: 10, y: 20 });
  await settle();
  const asked = events.filter(([name]) => name === "openWindow").map(([, data]) => data);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].adoptId, "ardiacore:4");
  assert.equal(asked[0].disposition, "foreground");
  refuseWindows = false;
  console.warn = warn;
  unmount();
});

test("a tab a pop-up opens goes to the pop-up's opener, never into the pop-up", async () => {
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  popupOpened("ardiacore:5", {});
  await settle();
  const made = opened.at(-1);
  const info = popupWindowInfo(made.id);
  const inPopup = [];
  const closeShown = mountPage(info.pageKey, { url: "", profile: info.profile, adopt: info.adopt, windowId: made.id }, (name, data) => inPopup.push([name, data]));
  await settle();
  emitTopic("tab.opened", { adopt: "ardiacore:6", url: "https://help.example/", foreground: true, window: false, opener: info.pageKey, profile: "p-work", fromClick: true, point: { x: 1, y: 2 } });
  await settle();
  assert.equal(inPopup.filter(([name]) => name === "openWindow").length, 0);
  const asked = events.filter(([name]) => name === "openWindow").map(([, data]) => data);
  assert.equal(asked.at(-1).adoptId, "ardiacore:6");
  assert.equal(asked.at(-1).point, undefined, "a click point in the pop-up means nothing in the opener's window");
  closeShown();
  unmount();
});

test("a tab.opened with no popup field still goes to the page as before", async () => {
  const before = opened.length;
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  emitTopic("tab.opened", { adopt: "ardiacore:7", url: "https://x.example/", foreground: true, window: true, opener: "opener-page", profile: "p-work", fromClick: false });
  await settle();
  assert.equal(opened.length, before);
  assert.equal(events.filter(([name]) => name === "openWindow").at(-1)[1].disposition, "window");
  unmount();
});

test("a private pop-up keeps its private session while it is open, after its opener's window closes", async () => {
  const profile = "p-work@private-1";
  const unmount = mountPage("private-opener", { url: "https://app.example/", profile, windowId: "main" }, () => {});
  const openerWindowGone = privateWindowShown(profile, (run) => run());
  await settle();
  emitTopic("tab.opened", { adopt: "ardiacore:20", url: "https://auth.example/login", foreground: true, window: true, opener: "private-opener", profile, parent: "", fromClick: false, popup: {} });
  await settle();
  const made = opened.at(-1);
  assert.equal(popupWindowInfo(made.id)?.profile, profile);
  const released = () => calls.filter((call) => call.verb === "profile.release" && call.args.profile === profile).length;
  await releaseProfile(profile, (name) => hostCall("profile.release", { profile: name }));
  openerWindowGone();
  unmount();
  await settle();
  assert.equal(released(), 0, "the window sync's release of the closed opener window waits while its pop-up is open");
  turboModules.ArdiaAppWindows.closeWindow(made.id);
  await settle();
  assert.equal(released(), 1, "the private session ends when its pop-up closes");
});

test("a pop-up leaves the focus decision to the moment it opens: its opener's window in front and the opener page holding the keyboard", async () => {
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, () => {});
  await settle();
  popupOpened("ardiacore:30", {});
  await settle();
  const made = opened.at(-1);
  assert.equal(made.options.focus, true);
  assert.equal(made.options.focusWhenFront, "main", "the native side activates it only if the opener's window is in front then");
  assert.equal(made.options.focusWhenPage, "opener-page", "and only if the opener page holds the keyboard then");
  assert.equal(calls.filter((call) => call.verb === "tabs.list").length, 0, "nothing is decided ahead of time from a list that can go stale");
  turboModules.ArdiaAppWindows.closeWindow(made.id);
  await settle();
  unmount();
});

test("a pop-up whose opener page is unknown never takes focus", async () => {
  popupOpened("ardiacore:31", {}, "nobody-knows-this-page");
  await settle();
  const made = opened.at(-1);
  assert.equal(made.options.focus, false);
  assert.equal(popupWindowInfo(made.id)?.focused, false, "its page does not take the keyboard either");
  turboModules.ArdiaAppWindows.closeWindow(made.id);
  await settle();
});

test("a pop-up opened from a pop-up is placed and focused by the pop-up that opened it, while its tabs and prompts still go to the main page", async () => {
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, () => {});
  await settle();
  popupOpened("ardiacore:32", {});
  await settle();
  const first = opened.at(-1);
  const firstInfo = popupWindowInfo(first.id);
  const firstShown = mountPage(firstInfo.pageKey, { url: "", profile: firstInfo.profile, adopt: firstInfo.adopt, windowId: first.id }, () => {});
  await settle();
  popupOpened("ardiacore:33", {}, firstInfo.pageKey);
  await settle();
  const second = opened.at(-1);
  assert.notEqual(second.id, first.id);
  assert.equal(second.options.focusWhenFront, first.id, "focus follows the pop-up that opened it");
  assert.equal(second.options.focusWhenPage, firstInfo.pageKey);
  assert.equal(popupWindowInfo(second.id)?.openerKey, "opener-page", "its tabs and prompts still go to the main page");
  turboModules.ArdiaAppWindows.closeWindow(second.id);
  turboModules.ArdiaAppWindows.closeWindow(first.id);
  await settle();
  firstShown();
  unmount();
});

test("a link a pop-up page opens in a new window (shift-click) goes to the pop-up's opener, without the pop-up's click point", async () => {
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  popupOpened("ardiacore:21", {});
  await settle();
  const made = opened.at(-1);
  const info = popupWindowInfo(made.id);
  const closeShown = mountPage(info.pageKey, { url: "", profile: info.profile, adopt: info.adopt, windowId: made.id }, () => {});
  await settle();
  emitTopic("tab", { key: info.pageKey, name: "openWindow", data: { url: "https://auth.example/help", disposition: "window", userGesture: true, point: { x: 10, y: 20 } } });
  await settle();
  const asked = events.filter(([name]) => name === "openWindow").map(([, data]) => data);
  assert.equal(asked.length, 1, "the opener's page gets the pop-up's link");
  assert.equal(asked[0].url, "https://auth.example/help");
  assert.equal(asked[0].disposition, "window");
  assert.equal(asked[0].point, undefined);
  turboModules.ArdiaAppWindows.closeWindow(made.id);
  await settle();
  closeShown();
  unmount();
});

test("a pop-up window closed while it was opening is not opened again as a tab", async () => {
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  closeWhileOpening = true;
  popupOpened("ardiacore:22", {});
  await settle();
  closeWhileOpening = false;
  assert.equal(events.filter(([name]) => name === "openWindow").length, 0, "the closed pop-up does not come back as a tab");
  assert.ok(calls.some((call) => call.verb === "tab.discard" && call.args.adopt === "ardiacore:22"), "its offered tab is given back");
  unmount();
});

test("a pop-up whose page closed itself closes its window at once, without the close request the user can cancel", async () => {
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, () => {});
  await settle();
  popupOpened("ardiacore:50", {});
  await settle();
  const made = opened.at(-1);
  const info = popupWindowInfo(made.id);
  const shown = mountPage(info.pageKey, { url: "", profile: info.profile, adopt: info.adopt, windowId: made.id }, () => {});
  await settle();
  const requestsBefore = closeRequests.length;
  emitTopic("tab", { key: info.pageKey, name: "windowClose", data: {} });
  await settle();
  assert.ok(closed.includes(made.id), "the window whose page is gone closes");
  assert.equal(closeRequests.length, requestsBefore, "no request that a Cancel could keep open");
  shown();
  unmount();
});
