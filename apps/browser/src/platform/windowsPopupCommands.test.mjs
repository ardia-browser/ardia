import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceEventEmitter, turboModules } from "../test-native/reactNative.ts";

const calls = [];
const openIds = new Set();

turboModules.ArdiaEngineHost = {
  available: () => true,
  hostCall: async (verb, argsJson, windowId) => {
    calls.push({ verb, args: JSON.parse(argsJson), windowId });
    if (verb === "tabs.list") return JSON.stringify({ tabs: [{ key: "main-page", shown: true, windowVisible: true }] });
    return JSON.stringify(verb === "tab.create" ? { tab: calls.length } : { ok: true });
  },
  engineCall: async () => "{}",
};

const closeRequests = [];

turboModules.ArdiaAppWindows = {
  openWindow: async (id) => void openIds.add(id),
  requestClose: async (id) => void closeRequests.push(id),
  closeWindow: async (id) => {
    openIds.delete(id);
    DeviceEventEmitter.emit("ArdiaAppWindows:onWindowEvent", { type: "close", id });
  },
  windowFrame: async (id) => (id === "main" ? [100, 50, 1200, 800] : null),
  windowIds: async () => [...openIds],
  setWindowTitle: async () => {},
};

const { mountPage } = await import("../../../../packages/expo-windows/src/engine/pages.ts");
const { popupWindowInfo } = await import("../../../../packages/expo-windows/src/engine/popupWindows.ts");
const { listenedOnWindows } = await import("../../../../packages/expo-windows/src/engine/popupCommands.ts");

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function openPopup(adopt) {
  const before = new Set(openIds);
  DeviceEventEmitter.emit("ArdiaEngineHost:event", {
    topic: "tab.opened",
    json: JSON.stringify({ adopt, url: "https://auth.example/login", foreground: true, window: true, opener: "main-page", profile: "p-work", fromClick: false, popup: {} }),
  });
  await settle();
  const windowId = [...openIds].find((id) => !before.has(id));
  const info = popupWindowInfo(windowId);
  const unmount = mountPage(info.pageKey, { url: "", profile: info.profile, adopt: info.adopt, windowId }, () => {});
  await settle();
  return { windowId, pageKey: info.pageKey, unmount };
}

const pageCalls = () => calls.filter((call) => call.verb === "tab.call" && call.args.method !== "focus");

test("a page shortcut in a pop-up acts on the pop-up's own page, never on the main window", async () => {
  const unmountMain = mountPage("main-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, () => {});
  await settle();
  const popup = await openPopup("ardiacore:40");
  const reached = [];
  const listener = listenedOnWindows("ArdiaMenus", "onCommand", (event) => reached.push(event));
  const second = [];
  const alsoListening = listenedOnWindows("ArdiaMenus", "onCommand", (event) => second.push(event));
  const expected = [
    ["reload", null, { method: "reload" }],
    ["forceReload", null, { method: "forceReload" }],
    ["stop", null, { method: "stopLoading" }],
    ["back", null, { method: "goBack" }],
    ["forward", null, { method: "goForward" }],
    ["zoomIn", null, { method: "zoomStep", direction: 1 }],
    ["zoomOut", null, { method: "zoomStep", direction: -1 }],
    ["zoomReset", null, { method: "zoomStep", direction: 0 }],
    ["print", null, { method: "print" }],
    ["printWithSystemDialog", null, { method: "runPageCommand", name: "systemPrint" }],
    ["devTools", null, { method: "showDevTools", panel: "toggle" }],
    ["toggleDevTools", null, { method: "showDevTools", panel: "toggle" }],
    ["inspectElements", null, { method: "showDevTools", panel: "inspect" }],
    ["javaScriptConsole", null, { method: "showDevTools", panel: "console" }],
  ];
  for (const [command, arg] of expected) {
    const event = { command, arg, windowId: popup.windowId, focusGeneration: null };
    listener(event);
    alsoListening(event);
  }
  await settle();
  assert.deepEqual(reached, [], "no pop-up command reaches the shared command handling");
  assert.deepEqual(second, []);
  assert.deepEqual(
    pageCalls().map((call) => call.args),
    expected.map(([, , args]) => ({ key: popup.pageKey, ...args })),
    "each page command goes once to the pop-up's page",
  );
  assert.ok(!pageCalls().some((call) => call.args.key === "main-page"));
  popup.unmount();
  unmountMain();
});

test("an app shortcut in a pop-up is refused: nothing runs and the main window never sees it", async () => {
  const unmountMain = mountPage("main-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, () => {});
  await settle();
  const popup = await openPopup("ardiacore:41");
  const before = calls.length;
  const reached = [];
  const listener = listenedOnWindows("ArdiaMenus", "onCommand", (event) => reached.push(event));
  for (const command of ["focusCommandBar", "closeAllTabs", "newTab", "findInPage", "findNext", "toggleSidebar", "selectTab", "copyUrl", "viewSource", "reopenClosedTab"])
    listener({ command, arg: command === "selectTab" ? "1" : null, windowId: popup.windowId, focusGeneration: null });
  await settle();
  assert.deepEqual(reached, []);
  assert.deepEqual(calls.slice(before), [], "a refused command calls nothing");
  popup.unmount();
  unmountMain();
});

test("close tab in a pop-up asks to close the pop-up as a window close does, and commands for other windows and menu picks pass through", async () => {
  const unmountMain = mountPage("main-page", { url: "https://app.example/", profile: "p-work", windowId: "main" }, () => {});
  await settle();
  const popup = await openPopup("ardiacore:42");
  const reached = [];
  const listener = listenedOnWindows("ArdiaMenus", "onCommand", (event) => reached.push(event.command));
  listener({ command: "reload", arg: null, windowId: "main", focusGeneration: null });
  listener({ command: "menu.pick", arg: "x", windowId: popup.windowId });
  listener({ command: "reload", arg: null, windowId: null });
  listener({ command: "closeTab", arg: null, windowId: popup.windowId, focusGeneration: null });
  await settle();
  assert.deepEqual(reached, ["reload", "menu.pick", "reload"]);
  assert.deepEqual(closeRequests, [popup.windowId], "the pop-up's close goes through the same request as its close button, so the quit question can be asked");
  await turboModules.ArdiaAppWindows.closeWindow(popup.windowId);
  await settle();
  assert.equal(popupWindowInfo(popup.windowId), null, "the pop-up closed");
  const other = [];
  const untouched = (event) => other.push(event);
  assert.equal(listenedOnWindows("ArdiaAppWindows", "onWindowEvent", untouched), untouched, "other modules' events are not wrapped");
  popup.unmount();
  unmountMain();
});
