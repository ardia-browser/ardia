import assert from "node:assert/strict";
import test from "node:test";

const NOTIFICATION_CALLS = ["ArdiaApp.notificationPermission", "ArdiaApp.requestNotificationPermission", "ArdiaApp.postNotification", "ArdiaApp.removeNotifications"];
const invoked = [];
const hostListeners = new Set();
const advertising = {
  bootstrap: { windowId: "main", profileId: "default", capabilities: NOTIFICATION_CALLS },
  invoke: async (method, args) => {
    invoked.push([method, args]);
    return method === "ArdiaApp.notificationPermission" ? "granted" : method === "ArdiaApp.postNotification" ? args.args[0].id : null;
  },
  call: async () => "null",
  onEvent: (listener) => { hostListeners.add(listener); return () => hostListeners.delete(listener); },
};
globalThis.window = { __ardiaHost: advertising };
const { settingUnavailable } = await import("./settingsIndex.ts");
const shim = await import("./shims/expo-modules-core.ts");
delete globalThis.window;
const { resolveHostModule } = await import("./hostModules.ts");

const silent = { bootstrap: { windowId: "main", profileId: "default", capabilities: [] }, invoke: async (method) => { throw new Error(`reached ${method}`); }, call: async () => "null", onEvent: () => () => {} };

test("a host that posts Ardia's notifications is called through, and Calendar's Show alerts row appears", async () => {
  assert.equal(settingUnavailable("calendar.alertCondition"), false);
  assert.equal(shim.hostModuleName("ArdiaNotifications"), "ArdiaApp");
  const app = (method) => resolveHostModule(advertising, "ArdiaApp", method);
  assert.equal(await app("notificationPermission")(), "granted");
  const options = { id: "meeting:1", title: "Stand-up", body: "Starts in 5 min", data: { meeting: "1" } };
  assert.equal(await app("postNotification")(options), "meeting:1");
  await app("removeNotifications")(["meeting:1"]);
  assert.deepEqual(invoked, [
    ["ArdiaApp.notificationPermission", { args: [] }],
    ["ArdiaApp.postNotification", { args: [options] }],
    ["ArdiaApp.removeNotifications", { args: [["meeting:1"]] }],
  ]);
  await assert.rejects(app("openNotificationSettings")(), { code: "ERR_UNAVAILABLE" }, "Linux has no notification settings to open");
});

test("a host without them shows nothing and is never asked", async () => {
  const app = (method) => resolveHostModule(silent, "ArdiaApp", method);
  assert.equal(await app("postNotification")({ title: "x" }), null);
  assert.equal(await app("removeNotifications")(["x"]), undefined);
  await assert.rejects(app("notificationPermission")(), { code: "ERR_UNAVAILABLE" });
});

test("the host's notification response reaches the listener the shared code registers", () => {
  const heard = [];
  const subscription = shim.requireNativeModule("ArdiaNotifications").addListener("onNotificationResponse", (response) => heard.push(response));
  const response = { id: "meeting:1", action: "click", tabId: null, windowId: "main", data: { meeting: "1" } };
  assert.equal(hostListeners.size > 0, true, "the shim listens to the host");
  for (const listener of hostListeners) listener("ArdiaApp", "onNotificationResponse", response);
  assert.deepEqual(heard, [response]);
  subscription.remove();
  for (const listener of hostListeners) listener("ArdiaApp", "onNotificationResponse", response);
  assert.equal(heard.length, 1);
});
