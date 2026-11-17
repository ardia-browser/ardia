import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { DeviceEventEmitter, turboModules } from "../test-native/reactNative.ts";

const calls = [];
const opened = [];
const closed = [];
const closeRequests = [];
const openIds = new Set();
let refuseWindows = false;
let closeWhileOpening = false;
let refuseCreates = false;
const shownPages = new Set(["opener-page"]);

turboModules.ArdiaEngineHost = {
  available: () => true,
  hostCall: async (verb, argsJson, windowId) => {
    calls.push({ verb, args: JSON.parse(argsJson), windowId });
    if (verb === "tab.create" && refuseCreates) throw new Error("no window");
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

const { answerExternalAppsWith } = await import("../../../../packages/expo-windows/src/engine/pages.ts");
const { addNativeListener } = await import("../../../../packages/expo-windows/src/events.ts");
const windowRequests = [];
addNativeListener("ArdiaTabs", "tabs", (event) => event?.name === "tabs.windowRequest" && windowRequests.push(event.data));
const discarded = (adopt) => calls.some((call) => call.verb === "tab.discard" && call.args.adopt === adopt);

async function lonePopup(adopt, profile = "p-work") {
  const unmountOpener = mountPage(`opener-${adopt}`, { url: "https://app.example/", profile, windowId: "main" }, () => {});
  await settle();
  emitTopic("tab.opened", { adopt, url: "https://auth.example/login", foreground: true, window: true, opener: `opener-${adopt}`, profile, parent: "", fromClick: false, popup: {} });
  await settle();
  const made = opened.at(-1);
  const info = popupWindowInfo(made.id);
  const inPopup = [];
  const unmountPopupPage = mountPage(info.pageKey, { url: "", profile, adopt: info.adopt, windowId: made.id }, (name, data) => inPopup.push([name, data]));
  await settle();
  unmountOpener();
  await settle();
  return { made, info, inPopup, done: async () => { unmountPopupPage(); turboModules.ArdiaAppWindows.closeWindow(made.id); await settle(); } };
}

test("an app-link ask from a pop-up left without its opener's window, with no browser page of its profile, is forgotten instead of waiting forever", async () => {
  const forgotten = [];
  answerExternalAppsWith({ ask: async () => ({ id: "lone-ask", url: "ardiatest:hello" }), forget: (id) => forgotten.push(id), forgetPage: () => {} });
  const popup = await lonePopup("ardiacore:70");
  emitTopic("tab", { key: popup.info.pageKey, name: "externalApp", data: { id: "e1", url: "ardiatest:hello" } });
  await settle();
  assert.deepEqual(forgotten, ["lone-ask"], "nobody can show the prompt, so the ask is forgotten in the app and the engine");
  assert.equal(popup.inPopup.filter(([name]) => name === "externalApp").length, 0, "the pop-up's own window never gets it");
  await popup.done();
});

test("a tab a lone pop-up opens reaches the app whole, with its offered tab and profile, as a window request no link rule sees", async () => {
  const popup = await lonePopup("ardiacore:71");
  const before = windowRequests.length;
  emitTopic("tab.opened", { adopt: "ardiacore:72", url: "https://help.example/", foreground: true, window: false, opener: popup.info.pageKey, profile: "p-work", parent: "", fromClick: false });
  await settle();
  const sent = windowRequests.slice(before);
  assert.equal(sent.length, 1, "one window request reaches the app");
  assert.equal(sent[0].profile, "p-work");
  assert.equal(sent[0].request.adoptId, "ardiacore:72");
  assert.equal(sent[0].request.url, "https://help.example/");
  assert.equal(sent[0].request.disposition, "foreground");
  assert.equal(sent[0].fromWindow, popup.made.id, "the pop-up's own window comes along, so a window opened for a background tab can open behind it");
  const adopted = mountPage("command-bar-window-tab", { url: "https://help.example/", profile: "p-work", adopt: "ardiacore:72", windowId: "empty-window" }, () => {});
  await settle();
  assert.ok(!discarded("ardiacore:72"), "the adopted tab is kept");
  adopted();
  await popup.done();
});

test("a link a lone pop-up opens in a new window reaches the app whole, in the pop-up's profile and without the pop-up's click point", async () => {
  const popup = await lonePopup("ardiacore:73");
  const before = windowRequests.length;
  emitTopic("tab", { key: popup.info.pageKey, name: "openWindow", data: { url: "https://help.example/split", disposition: "window", userGesture: true, point: { x: 5, y: 5 } } });
  await settle();
  const sent = windowRequests.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].profile, "p-work");
  assert.equal(sent[0].request.url, "https://help.example/split");
  assert.equal(sent[0].request.disposition, "window");
  assert.equal(sent[0].request.point, undefined);
  await popup.done();
});

test("a tab a lone private pop-up opens is closed and forgotten at once: no window of its private session can take it", async () => {
  const popup = await lonePopup("ardiacore:74", "p-work@private-9");
  const before = windowRequests.length;
  emitTopic("tab.opened", { adopt: "ardiacore:75", url: "https://help.example/", foreground: true, window: false, opener: popup.info.pageKey, profile: "p-work@private-9", parent: "", fromClick: false });
  await settle();
  assert.equal(windowRequests.length, before, "nothing reaches the app");
  assert.ok(discarded("ardiacore:75"), "the private tab is closed at once, never put in a regular window");
  await popup.done();
});

test("a tab a lone pop-up opens is closed in the engine, not left hidden and running, when the app doesn't adopt it within the wait", async () => {
  const { BROWSER_WINDOW_WAIT_MS } = await import("../../../../packages/expo-windows/src/engine/requestHosts.ts");
  const popup = await lonePopup("ardiacore:76");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    emitTopic("tab.opened", { adopt: "ardiacore:77", url: "https://help.example/late", foreground: true, window: false, opener: popup.info.pageKey, profile: "p-work", parent: "", fromClick: false });
    mock.timers.tick(BROWSER_WINDOW_WAIT_MS - 1);
    assert.ok(!discarded("ardiacore:77"), "it still waits just before the deadline");
    mock.timers.tick(1);
  } finally {
    mock.timers.reset();
  }
  await settle();
  assert.ok(discarded("ardiacore:77"), "at the deadline the offered tab is closed in the engine");
  await popup.done();
});

test("a lone pop-up's tab whose adoption fails, because its window closed first, is closed in the engine at once", async () => {
  const popup = await lonePopup("ardiacore:78");
  emitTopic("tab.opened", { adopt: "ardiacore:79", url: "https://help.example/gone", foreground: true, window: false, opener: popup.info.pageKey, profile: "p-work", parent: "", fromClick: false });
  await settle();
  refuseCreates = true;
  try {
    const adopting = mountPage("closed-window-tab", { url: "https://help.example/gone", profile: "p-work", adopt: "ardiacore:79", windowId: "closed-window" }, () => {});
    await settle();
    assert.ok(discarded("ardiacore:79"), "the offer is closed, not left running with its deadline already cleared");
    adopting();
  } finally {
    refuseCreates = false;
  }
  await popup.done();
});

async function popupOfMovedOpener(adopt, from = "p-work", to = "p-home") {
  const key = `moved-${adopt}`;
  const unmountFirst = mountPage(key, { url: "https://app.example/", profile: from, windowId: "main" }, () => {});
  await settle();
  emitTopic("tab.opened", { adopt, url: "https://auth.example/login", foreground: true, window: true, opener: key, profile: from, parent: "", fromClick: false, popup: {} });
  await settle();
  const made = opened.at(-1);
  const info = popupWindowInfo(made.id);
  const unmountPopupPage = mountPage(info.pageKey, { url: "", profile: from, adopt: info.adopt, windowId: made.id }, () => {});
  await settle();
  unmountFirst();
  const inMoved = [];
  const unmountMoved = mountPage(key, { url: "https://app.example/", profile: to, windowId: "main" }, (name, data) => inMoved.push([name, data]));
  await settle();
  return {
    info,
    made,
    inMoved,
    done: async () => {
      unmountMoved();
      unmountPopupPage();
      turboModules.ArdiaAppWindows.closeWindow(made.id);
      await settle();
    },
  };
}

test("opener moved to another profile: a tab its pop-up opens, with the pop-up profile's offered tab, never reaches the opener's page in the new profile", async () => {
  const popup = await popupOfMovedOpener("ardiacore:80");
  const before = windowRequests.length;
  emitTopic("tab.opened", { adopt: "ardiacore:81", url: "https://help.example/", foreground: true, window: false, opener: popup.info.pageKey, profile: "p-work", parent: "", fromClick: false });
  await settle();
  assert.equal(popup.inMoved.filter(([name]) => name === "openWindow").length, 0, "the moved opener's page, now in another profile, gets nothing");
  const sent = windowRequests.slice(before);
  assert.equal(sent.length, 1, "it goes to a browser window of the pop-up's own profile instead");
  assert.equal(sent[0].profile, "p-work");
  assert.equal(sent[0].request.adoptId, "ardiacore:81");
  await popup.done();
});

test("opener moved to another profile: a tab its pop-up opens goes to a listening page of the pop-up's profile when one is showing", async () => {
  const popup = await popupOfMovedOpener("ardiacore:82");
  const inWork = [];
  const unmountWork = mountPage("work-page-82", { url: "https://work.example/", profile: "p-work", windowId: "work-window" }, (name, data) => inWork.push([name, data]));
  await settle();
  emitTopic("tab.opened", { adopt: "ardiacore:83", url: "https://help.example/", foreground: true, window: false, opener: popup.info.pageKey, profile: "p-work", parent: "", fromClick: false });
  await settle();
  assert.equal(popup.inMoved.filter(([name]) => name === "openWindow").length, 0);
  assert.equal(inWork.filter(([name]) => name === "openWindow").at(-1)?.[1].adoptId, "ardiacore:83");
  unmountWork();
  await popup.done();
});

test("opener moved to another profile: a link its pop-up opens in a new window goes to the pop-up's profile, not the opener's new one", async () => {
  const popup = await popupOfMovedOpener("ardiacore:84");
  const before = windowRequests.length;
  emitTopic("tab", { key: popup.info.pageKey, name: "openWindow", data: { url: "https://help.example/split", disposition: "window", userGesture: true } });
  await settle();
  assert.equal(popup.inMoved.filter(([name]) => name === "openWindow").length, 0);
  const sent = windowRequests.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].profile, "p-work");
  assert.equal(sent[0].request.url, "https://help.example/split");
  await popup.done();
});

test("opener moved to another profile: an app-link ask from its pop-up is never shown on the opener's page in the new profile", async () => {
  const forgotten = [];
  answerExternalAppsWith({ ask: async () => ({ id: "moved-ask", url: "ardiatest:hello" }), forget: (id) => forgotten.push(id), forgetPage: () => {} });
  const popup = await popupOfMovedOpener("ardiacore:85");
  emitTopic("tab", { key: popup.info.pageKey, name: "externalApp", data: { id: "e2", url: "ardiatest:hello" } });
  await settle();
  assert.equal(popup.inMoved.filter(([name]) => name === "externalApp").length, 0, "the other profile's page never shows it");
  assert.deepEqual(forgotten, ["moved-ask"], "with no page of the pop-up's profile, the ask is forgotten");
  await popup.done();
});

test("an offered tab whose profile isn't its opener page's, as when the tab moved profiles while the engine was opening it, never reaches that page", async () => {
  const warn = console.warn;
  console.warn = () => {};
  const inMoved = [];
  const unmount = mountPage("moved-direct", { url: "https://app.example/", profile: "p-home", windowId: "main" }, (name, data) => inMoved.push([name, data]));
  await settle();
  emitTopic("tab.opened", { adopt: "ardiacore:86", url: "https://help.example/", foreground: true, window: false, opener: "moved-direct", profile: "p-work", parent: "", fromClick: true });
  await settle();
  console.warn = warn;
  assert.equal(inMoved.filter(([name]) => name === "openWindow").length, 0);
  assert.ok(discarded("ardiacore:86"), "with no page of its profile, the offered tab is closed");
  unmount();
});

test("a private pop-up still reaches its opener: a tab it opens goes to the opener page of its private session", async () => {
  const profile = "p-work@private-4";
  const inOpener = [];
  const unmount = mountPage("private-opener-87", { url: "https://app.example/", profile, windowId: "main" }, (name, data) => inOpener.push([name, data]));
  await settle();
  emitTopic("tab.opened", { adopt: "ardiacore:87", url: "https://auth.example/login", foreground: true, window: true, opener: "private-opener-87", profile, parent: "", fromClick: false, popup: {} });
  await settle();
  const made = opened.at(-1);
  const info = popupWindowInfo(made.id);
  const unmountPopupPage = mountPage(info.pageKey, { url: "", profile, adopt: info.adopt, windowId: made.id }, () => {});
  await settle();
  emitTopic("tab.opened", { adopt: "ardiacore:88", url: "https://help.example/", foreground: true, window: false, opener: info.pageKey, profile, parent: "", fromClick: false });
  emitTopic("tab", { key: info.pageKey, name: "openWindow", data: { url: "https://help.example/new", disposition: "window", userGesture: true } });
  await settle();
  const asked = inOpener.filter(([name]) => name === "openWindow").map(([, data]) => data.adoptId ?? data.url);
  assert.deepEqual(asked, ["ardiacore:88", "https://help.example/new"]);
  unmountPopupPage();
  unmount();
  turboModules.ArdiaAppWindows.closeWindow(made.id);
  await settle();
});

const { domainCall } = await import("../../../../packages/expo-windows/src/engine/domains/tables.ts");
const { noteAppWindow } = await import("../../../../packages/expo-windows/src/engine/popupsAsTabs.ts");
const { readFileSync } = await import("node:fs");
const windowsSource = (path) => readFileSync(new URL(`../../../../packages/expo-windows/src/${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const forwardedRows = JSON.parse(windowsSource("engine/domains/forwarded.json"));
const settingEngine = { call: async () => "{}", emit: () => {}, missing: async () => "null", host: async () => ({}) };
const setPopupsAsTabs = async (enabled) => JSON.parse(await domainCall(forwardedRows, settingEngine, "webView")("setPopupsOpenAsTabs", "", JSON.stringify({ enabled })));
const openWindowAsks = (events) => events.filter(([name]) => name === "openWindow").map(([, data]) => data);

async function withPopupsAsTabs(run) {
  assert.equal(await setPopupsAsTabs(true), null);
  try {
    await run();
  } finally {
    await setPopupsAsTabs(false);
  }
}

test("Open pop-up windows as tabs is a setting Windows keeps itself, and it takes only a boolean", async () => {
  assert.ok(!forwardedRows.missing.webView.includes("setPopupsOpenAsTabs"));
  assert.equal(await setPopupsAsTabs(false), null);
  await assert.rejects(domainCall(forwardedRows, settingEngine, "webView")("setPopupsOpenAsTabs", "", JSON.stringify({ enabled: "yes" })), /enabled/);
});

test("with pop-ups as tabs on, a page's pop-up goes to it as the Mac's foreground pop-up tab, with its offered tab and profile, and no window opens", async () => {
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  const before = opened.length;
  await withPopupsAsTabs(async () => {
    popupOpened("ardiacore:100", { width: 400, height: 300 });
    await settle();
  });
  assert.equal(opened.length, before, "no pop-up window opens");
  assert.deepEqual(openWindowAsks(events), [{ url: "https://auth.example/login", disposition: "foreground", adoptId: "ardiacore:100", userGesture: true, profile: "p-work", fromClick: false, point: undefined, popup: true }]);
  popupOpened("ardiacore:101", {});
  await settle();
  assert.equal(opened.length, before + 1, "with the setting off again, the next pop-up is a window");
  assert.equal(openWindowAsks(events).length, 1);
  turboModules.ArdiaAppWindows.closeWindow(opened.at(-1).id);
  await settle();
  unmount();
});

test("with pop-ups as tabs on, a pop-up from a Peek goes to the Peek's page, which the app keeps as a tab", async () => {
  const inMain = [];
  const inPeek = [];
  const unmountMain = mountPage("peek-source", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => inMain.push([name, data]));
  const unmountPeek = mountPage("peek-page", { url: "https://signin.example/start", profile: "p-work", windowId: "main" }, (name, data) => inPeek.push([name, data]));
  await settle();
  const before = opened.length;
  await withPopupsAsTabs(async () => {
    popupOpened("ardiacore:102", {}, "peek-page");
    await settle();
  });
  assert.equal(opened.length, before);
  assert.equal(openWindowAsks(inMain).length, 0);
  assert.deepEqual(openWindowAsks(inPeek).map(({ adoptId, popup, disposition }) => ({ adoptId, popup, disposition })), [{ adoptId: "ardiacore:102", popup: true, disposition: "foreground" }]);
  unmountPeek();
  unmountMain();
});

test("with pop-ups as tabs on, a pop-up from a pop-up window opens as a tab beside the first page, and the open pop-up window stays a window", async () => {
  const events = [];
  const unmount = mountPage("opener-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => events.push([name, data]));
  await settle();
  popupOpened("ardiacore:103", {});
  await settle();
  const first = opened.at(-1);
  const info = popupWindowInfo(first.id);
  const inPopup = [];
  const shown = mountPage(info.pageKey, { url: "", profile: info.profile, adopt: info.adopt, windowId: first.id }, (name, data) => inPopup.push([name, data]));
  await settle();
  const before = opened.length;
  await withPopupsAsTabs(async () => {
    await settle();
    assert.ok(popupWindowInfo(first.id), "switching the setting on leaves the open pop-up window a window");
    assert.ok(!closed.includes(first.id));
    assert.equal(openWindowAsks(events).length, 0);
    popupOpened("ardiacore:104", {}, info.pageKey);
    await settle();
  });
  assert.equal(opened.length, before, "the pop-up's own pop-up opens no second window");
  assert.equal(openWindowAsks(inPopup).length, 0, "nor a tab inside the pop-up");
  assert.deepEqual(openWindowAsks(events).map(({ adoptId, popup }) => ({ adoptId, popup })), [{ adoptId: "ardiacore:104", popup: true }]);
  assert.ok(popupWindowInfo(first.id), "and the first pop-up stays open");
  turboModules.ArdiaAppWindows.closeWindow(first.id);
  await settle();
  shown();
  unmount();
});

test("with pop-ups as tabs on, a pop-up from Little Ardia stays a pop-up window, as on the Mac", async () => {
  assert.match(windowsSource("modules.ts"), /openWindow: \(native\) => \(id, options\) => \{\n(?:.*\n){0,2}\s+noteAppWindow\(String\(id\), \(options as OpenWindowOptions \| null\)\?\.kind\);\n(?:.*\n){0,2}\s+return native\(id, options\);/);
  noteAppWindow("little-ardia-1", "small");
  const events = [];
  const unmount = mountPage("little-page", { url: "https://app.example/", profile: "p-work", windowId: "little-ardia-1" }, (name, data) => events.push([name, data]));
  await settle();
  const before = opened.length;
  await withPopupsAsTabs(async () => {
    popupOpened("ardiacore:105", {}, "little-page");
    await settle();
  });
  assert.equal(opened.length, before + 1);
  assert.equal(popupWindowInfo(opened.at(-1).id)?.openerKey, "little-page");
  assert.equal(openWindowAsks(events).length, 0);
  turboModules.ArdiaAppWindows.closeWindow(opened.at(-1).id);
  DeviceEventEmitter.emit("ArdiaAppWindows:onWindowEvent", { type: "close", id: "little-ardia-1" });
  await settle();
  unmount();
});

test("with pop-ups as tabs on, a private window's pop-up opens as a tab in that private window, never in a regular one", async () => {
  const profile = "p-work@private-5";
  const inPrivate = [];
  const inRegular = [];
  const unmountRegular = mountPage("regular-page-106", { url: "https://app.example/", profile: "p-work", windowId: "main" }, (name, data) => inRegular.push([name, data]));
  const unmountPrivate = mountPage("private-page-106", { url: "https://app.example/", profile, windowId: "private-window" }, (name, data) => inPrivate.push([name, data]));
  await settle();
  const before = opened.length;
  await withPopupsAsTabs(async () => {
    emitTopic("tab.opened", { adopt: "ardiacore:106", url: "https://auth.example/login", foreground: true, window: true, opener: "private-page-106", profile, parent: "", fromClick: false, popup: {} });
    await settle();
  });
  assert.equal(opened.length, before);
  assert.equal(openWindowAsks(inRegular).length, 0);
  assert.deepEqual(openWindowAsks(inPrivate).map(({ adoptId, profile, popup }) => ({ adoptId, profile, popup })), [{ adoptId: "ardiacore:106", profile, popup: true }]);
  unmountPrivate();
  unmountRegular();
});

test("with pop-ups as tabs on, a pop-up with no page to open beside stays a window", async () => {
  const before = opened.length;
  await withPopupsAsTabs(async () => {
    popupOpened("ardiacore:107", {}, "nobody-knows-this-page");
    await settle();
  });
  assert.equal(opened.length, before + 1);
  assert.equal(opened.at(-1).options.focus, false);
  turboModules.ArdiaAppWindows.closeWindow(opened.at(-1).id);
  await settle();
});

test("with pop-ups as tabs on, a pop-up whose opener moved to another profile goes to a page of the pop-up's profile, or stays a window when none is showing", async () => {
  const inMoved = [];
  const unmountMoved = mountPage("moved-opener-108", { url: "https://app.example/", profile: "p-home", windowId: "main" }, (name, data) => inMoved.push([name, data]));
  await settle();
  const before = opened.length;
  await withPopupsAsTabs(async () => {
    popupOpened("ardiacore:108", {}, "moved-opener-108");
    await settle();
    assert.equal(opened.length, before + 1, "with no page of its profile showing, it opens as a window");
    turboModules.ArdiaAppWindows.closeWindow(opened.at(-1).id);
    await settle();
    const inWork = [];
    const unmountWork = mountPage("work-page-108", { url: "https://work.example/", profile: "p-work", windowId: "work-window" }, (name, data) => inWork.push([name, data]));
    await settle();
    popupOpened("ardiacore:109", {}, "moved-opener-108");
    await settle();
    assert.equal(opened.length, before + 1, "with one showing, it opens there as a tab");
    assert.deepEqual(openWindowAsks(inWork).map(({ adoptId, popup }) => ({ adoptId, popup })), [{ adoptId: "ardiacore:109", popup: true }]);
    unmountWork();
  });
  assert.equal(openWindowAsks(inMoved).length, 0, "the opener's page in its new profile gets nothing");
  unmountMoved();
});
